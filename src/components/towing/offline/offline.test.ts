import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TowingCommand, TowingCommandResult, TowingMember, TowingOrder } from '@/domain/towing/types';
import { enqueue, LEASE_MS, lockScope, pendingSummary, quarantine, readOrders, readReceiptEvidence, recoveryTargets, rememberOrder, scopesForUser, type OfflineEntry, type OfflineIdentity } from './store';
import { OfflineTransportError, synchronize, type DriverAccess } from './sync';

const identity: OfflineIdentity = { userId: 'user-a', organizationId: 'org-a', membershipId: 'driver-a', environment: 'https://test.example' };
const actor: TowingMember = { id: identity.membershipId, userId: identity.userId, organizationId: identity.organizationId, roles: ['driver'], capabilities: ['drive'], active: true, version: 1, displayName: 'Vodič A' };
const order: TowingOrder = { id: 'order-a', number: 'Z-1', sourceCaseId: 'private-case', revision: 1, assignmentGeneration: 2, driverId: actor.id, workStatus: 'assigned', billingStatus: 'not_ready', paymentStatus: 'unpaid', fields: { serviceType: 'tow', subjectType: 'vehicle', subjectDescription: 'Auto', pickup: 'Súkromná adresa', contact: 'Súkromný kontakt' }, officeNotes: 'Secret office note', lines: [], attachments: [], receivedCents: 0, dueCents: 10000, authorizedCollectionCents: 10000, reconciliationRequired: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
const lease = () => ({ issuedAt: Date.now(), expiresAt: Date.now() + LEASE_MS });
function entry(phase: OfflineEntry['phase'], type: TowingCommand['type'], payload: Record<string, unknown> = {}): OfflineEntry {
  const id = crypto.randomUUID(); return { id, phase, state: 'pending', sealed: false, command: { commandId: id, type, targetId: order.id, assignmentGeneration: 2, expectedRevision: 1, payload } };
}
const receipt = () => entry('receipt', 'receive_payment', { receiptId: crypto.randomUUID(), amountCents: 10000, method: 'cash', capturedAt: new Date().toISOString() });
beforeEach(async () => {
  vi.restoreAllMocks(); vi.useRealTimers();
  await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase('pm-towing-offline-v1'); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
  await rememberOrder(identity, actor, order, lease());
});

describe('driver offline preservation and isolation', () => {
  it('stores only the driver projection and keeps other accounts inaccessible', async () => {
    const [saved] = await readOrders(identity);
    expect(saved.order.officeNotes).toBeUndefined(); expect(saved.order.sourceCaseId).toBeNull(); expect(saved.order.lines).toBeUndefined();
    expect(await scopesForUser('user-b', identity.environment)).toEqual([]);
    await expect(readOrders({ ...identity, userId: 'user-b' })).rejects.toMatchObject({ code: 'identity' });
    await expect(rememberOrder(identity, actor, { ...order, driverId: 'driver-b' }, lease())).rejects.toMatchObject({ code: 'identity' });
  });
  it('locks expired content without deleting pending fields, photos or receipts after 24 hours', async () => {
    await enqueue(identity, order.id, entry('fields','update_order',{ fields: { driverNotes: 'Neodoslaná práca' } }));
    await enqueue(identity, order.id, { ...entry('photo','attachment_intent',{ id: crypto.randomUUID(), kind: 'work' }), file: new Blob(['photo']), fileName: 'photo.jpg' });
    await enqueue(identity, order.id, receipt());
    const tomorrow = Date.now() + 25 * 60 * 60 * 1000;
    await expect(readOrders(identity, tomorrow)).rejects.toMatchObject({ code: 'locked' });
    expect(await pendingSummary(identity)).toEqual({ changes: 3, photos: 1, receipts: 1 });
    await lockScope(identity);
    expect(await recoveryTargets(identity)).toEqual([{ id: order.id, generation: 2 }]);
    await rememberOrder(identity, actor, order, lease());
    expect((await readOrders(identity))[0].entries).toHaveLength(3);
  });
  it('retains only opaque cash evidence when work is explicitly discarded or revoked', async () => {
    const cash = receipt();
    await enqueue(identity, order.id, cash);
    await enqueue(identity, order.id, { ...entry('photo','attachment_intent',{ id: crypto.randomUUID(), kind: 'work' }), file: new Blob(['secret photo']), fileName: 'private.jpg' });
    await quarantine(identity, order.id);
    expect(await readOrders(identity)).toEqual([]);
    const evidence = await readReceiptEvidence(identity);
    expect(evidence).toHaveLength(1); expect(evidence[0].receiptId).toBe(cash.command.payload.receiptId);
    expect(JSON.stringify(evidence)).not.toMatch(/Súkromná|Súkromný|private.jpg|secret photo|Secret office/);
    await expect(readReceiptEvidence({ ...identity, userId: 'user-b' })).rejects.toMatchObject({ code: 'identity' });
  });
  it('rejects a full order budget atomically without claiming another photo is stored', async () => {
    const large = new Blob([new Uint8Array(10 * 1024 * 1024)]);
    for (let i = 0; i < 4; i++) await enqueue(identity, order.id, { ...entry('photo','attachment_intent',{ id: crypto.randomUUID(), kind: 'work' }), file: large });
    await expect(enqueue(identity, order.id, { ...entry('photo','attachment_intent',{ id: crypto.randomUUID(), kind: 'work' }), file: large })).rejects.toMatchObject({ code: 'quota' });
    expect((await pendingSummary(identity)).photos).toBe(4);
  });
});

describe('foreground sync', () => {
  function server() {
    let serverRevision = 1; let cashEffects = 0; let loseNextResponse = false;
    const receipts = new Map<string, { payload: string; result: TowingCommandResult }>();
    const calls: TowingCommand[] = [];
    const access = vi.fn(async (): Promise<DriverAccess> => ({ actor, order: { ...order, revision: serverRevision }, lease: lease(), cashAccount: { id: 'cash-a', driverId: actor.id, balanceCents: cashEffects * 10000, reservedCents: 0, revision: cashEffects + 1 } }));
    const request = vi.fn(async (_identity: OfflineIdentity, _path: string, init?: RequestInit): Promise<TowingCommandResult> => {
      const command = JSON.parse(String(init?.body)) as TowingCommand; calls.push(command);
      const previous = receipts.get(command.commandId);
      if (previous) { expect(JSON.stringify(command)).toBe(previous.payload); return previous.result; }
      if (command.type === 'receive_payment') cashEffects++;
      else serverRevision++;
      const result = { commandId: command.commandId, targetId: order.id, revision: serverRevision };
      receipts.set(command.commandId, { payload: JSON.stringify(command), result });
      if (loseNextResponse) { loseNextResponse = false; throw new TypeError('Response lost'); }
      return result;
    });
    return { access, request, calls, cashEffects: () => cashEffects, loseResponse: () => { loseNextResponse = true; }, changeRevision: () => { serverRevision++; } };
  }
  it('retries exactly the sealed command after a lost ACK and completes only after receipt ACK', async () => {
    const api = server();
    // Enqueue in a different order: sync still commits fields before cash and completion.
    await enqueue(identity, order.id, receipt());
    await enqueue(identity, order.id, entry('fields','update_order',{ fields: { driverNotes: 'Done' } }));
    await enqueue(identity, order.id, entry('submit','submit'));
    api.loseResponse();
    const dependencies = { currentUser: async () => identity.userId, access: api.access, request: api.request };
    await synchronize(identity, dependencies);
    expect((await pendingSummary(identity)).changes).toBe(3);
    expect(api.calls.map(c => c.type)).toEqual(['update_order']);
    await synchronize(identity, dependencies);
    expect(api.calls.map(c => c.type)).toEqual(['update_order','update_order','receive_payment','submit']);
    expect(api.cashEffects()).toBe(1);
    expect(api.calls[3].payload.receiptIds).toEqual([api.calls[2].payload.receiptId]);
    expect((await pendingSummary(identity)).changes).toBe(0);
    expect(await readOrders(identity)).toEqual([]);
  });
  it('halts on an external revision change and preserves edits instead of silently rebasing', async () => {
    const api = server();
    await enqueue(identity, order.id, entry('fields','update_order',{ fields: { driverNotes: 'Mine' } }));
    api.changeRevision();
    await synchronize(identity, { currentUser: async () => identity.userId, access: api.access, request: api.request });
    expect(api.request).not.toHaveBeenCalled();
    expect((await readOrders(identity))[0].entries[0]).toMatchObject({ state: 'conflict', command: { payload: { fields: { driverNotes: 'Mine' } } } });
  });
  it('preserves work for generic 403 and purges only an authoritative same-identity revocation', async () => {
    await enqueue(identity, order.id, receipt());
    const generic = { currentUser: async () => identity.userId, access: async () => { throw new OfflineTransportError(403,'access_denied','Denied'); } };
    await expect(synchronize(identity, generic)).rejects.toMatchObject({ code: 'access_denied' });
    expect((await pendingSummary(identity)).receipts).toBe(1);
    await expect(readOrders(identity)).rejects.toMatchObject({ code: 'locked' });
    await synchronize(identity, { ...generic, access: async () => { throw new OfflineTransportError(403,'assignment_revoked','Revoked'); } });
    expect(await recoveryTargets(identity)).toEqual([]); expect(await readReceiptEvidence(identity)).toHaveLength(1);
  });
  it('never sends an old account outbox under a different login', async () => {
    const api = server(); await enqueue(identity, order.id, receipt());
    await expect(synchronize(identity, { currentUser: async () => 'user-b', access: api.access, request: api.request })).rejects.toMatchObject({ code: 'identity_changed' });
    expect(api.access).not.toHaveBeenCalled(); expect(api.request).not.toHaveBeenCalled();
    expect((await pendingSummary(identity)).receipts).toBe(1);
  });
});
