import type { TowingCommand, TowingFields, TowingMember, TowingOrder } from '@/domain/towing/types';

const DATABASE = 'pm-towing-offline-v1';
export const LEASE_MS = 12 * 60 * 60 * 1000;
export const SNAPSHOT_MS = 24 * 60 * 60 * 1000;
const ACCOUNT_BUDGET = 200 * 1024 * 1024;
const ORDER_BUDGET = 50 * 1024 * 1024;
export interface OfflineIdentity { userId: string; organizationId: string; membershipId: string; environment: string }
export interface OfflineLease { issuedAt: number; expiresAt: number }
export interface OfflineScope extends OfflineIdentity {
  key: string; lease: OfflineLease; consent: true; locked: boolean; syncOwner?: string; syncUntil?: number;
}
export interface OfflineEntry {
  id: string; phase: 'fields' | 'photo' | 'receipt' | 'submit'; state: 'pending' | 'sending' | 'failed' | 'conflict';
  command: TowingCommand; sealed: boolean; file?: Blob; fileName?: string; error?: string; lastHttpStatus?: number;
}
export interface OfflineOrder {
  key: string; scopeKey: string; order: TowingOrder; loadedAt: number; revision: number;
  lease: OfflineLease;
  entries: OfflineEntry[]; acknowledgedReceipts: string[];
}
export interface ReceiptEvidence {
  key: string; scopeKey: string; orderId: string; receiptId: string; assignmentGeneration: number;
  amountCents: number; method: 'cash'; capturedAt: string; status: 'requires_office_reconciliation';
}
export class OfflineError extends Error {
  constructor(public code: 'locked' | 'quota' | 'identity' | 'missing' | 'pending' | 'unsupported', message: string) { super(message); }
}
export function scopeKey(identity: OfflineIdentity) {
  return JSON.stringify([identity.environment, identity.organizationId, identity.userId, identity.membershipId]);
}
const orderKey = (identity: OfflineIdentity, id: string) => `${scopeKey(identity)}:${id}`;
const requestValue = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
async function openDatabase() {
  if (typeof indexedDB === 'undefined') throw new OfflineError('unsupported', 'Tento prehliadač nepovoľuje uloženie offline.');
  const request = indexedDB.open(DATABASE, 1);
  request.onupgradeneeded = () => {
    for (const name of ['scopes', 'orders', 'receipts']) request.result.createObjectStore(name, { keyPath: 'key' });
  };
  const db = await requestValue(request);
  db.onversionchange = () => db.close();
  return db;
}
async function transaction<T>(mode: IDBTransactionMode, run: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const db = await openDatabase();
  const tx = db.transaction(['scopes', 'orders', 'receipts'], mode);
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('Lokálne uloženie bolo prerušené.'));
    tx.onerror = () => { /* onabort reports the transaction outcome. */ };
  });
  try { const result = await run(tx); await done; return result; }
  catch (error) { try { tx.abort(); } catch { /* Already completed or aborted. */ } await done.catch(() => undefined); throw error; }
  finally { db.close(); }
}
async function scopeIn(tx: IDBTransaction, identity: OfflineIdentity, readable = true, now = Date.now()) {
  const scope = await requestValue(tx.objectStore('scopes').get(scopeKey(identity))) as OfflineScope | undefined;
  if (!scope || scope.userId !== identity.userId || scope.organizationId !== identity.organizationId || scope.membershipId !== identity.membershipId)
    throw new OfflineError('identity', 'Offline údaje patria inému účtu alebo ešte neboli pripravené.');
  if (readable && (scope.locked || now < scope.lease.issuedAt - 60_000 || now >= scope.lease.expiresAt))
    throw new OfflineError('locked', 'Offline prístup vypršal. Pripojte sa a overte rovnaký účet. Neodoslané údaje ostali uložené.');
  return scope;
}
function minimalOrder(order: TowingOrder): TowingOrder {
  const fields: TowingFields = {
    serviceType: order.fields.serviceType, subjectType: order.fields.subjectType,
    subjectDescription: order.fields.subjectDescription, pickup: order.fields.pickup,
  };
  const keys = ['plate','vin','destination','contact','noContactReason','branchId','fleetAssetId','plannedAt','startedAt','finishedAt','startSource','driverNotes','performedQuantity','photoException','assistanceReference','parkingId','parkingName','parkingAddress','assistancePartnerName'] as const;
  for (const key of keys) if (order.fields[key] !== undefined) Object.assign(fields, { [key]: order.fields[key] });
  return {
    id: order.id, number: order.number, sourceCaseId: null, revision: order.revision,
    assignmentGeneration: order.assignmentGeneration, driverId: order.driverId, workStatus: order.workStatus,
    billingStatus: 'not_ready', paymentStatus: 'unpriced', fields,
    authorizedCollectionCents: order.authorizedCollectionCents, receivedCents: order.receivedCents, dueCents: order.authorizedCollectionCents,
    reconciliationRequired: order.reconciliationRequired, createdAt: order.createdAt, updatedAt: order.updatedAt,
    attachments: order.attachments.filter(a => a.kind !== 'scan').map(a => ({ ...a })),
  };
}
function bytes(record: OfflineOrder) {
  return new TextEncoder().encode(JSON.stringify(record)).length + record.entries.reduce((sum, item) => sum + (item.file?.size ?? 0), 0);
}
async function putWithinBudget(tx: IDBTransaction, record: OfflineOrder) {
  const size = bytes(record);
  const all = await requestValue(tx.objectStore('orders').getAll()) as OfflineOrder[];
  const total = size + all.filter(r => r.scopeKey === record.scopeKey && r.key !== record.key).reduce((sum, r) => sum + bytes(r), 0);
  if (size > ORDER_BUDGET || total > ACCOUNT_BUDGET) throw new OfflineError('quota', 'Offline miesto je plné. Záznam sa neuložil; najprv synchronizujte uloženú prácu.');
  await requestValue(tx.objectStore('orders').put(record));
}
export async function availableStorage(additionalBytes: number) {
  const estimate = await globalThis.navigator?.storage?.estimate?.();
  if (estimate?.quota && estimate.quota - (estimate.usage ?? 0) < additionalBytes + 1024 * 1024)
    throw new OfflineError('quota', 'V zariadení nie je dosť miesta. Záznam sa neuložil.');
}
export async function rememberOrder(identity: OfflineIdentity, actor: TowingMember, order: TowingOrder, lease: OfflineLease) {
  const now = Date.now();
  if (actor.userId !== identity.userId || actor.organizationId !== identity.organizationId || actor.id !== identity.membershipId || order.driverId !== actor.id || !actor.capabilities.includes('drive'))
    throw new OfflineError('identity', 'Uložiť sa dá iba vlastná pridelená zákazka.');
  if (![lease.issuedAt, lease.expiresAt].every(Number.isFinite) || lease.expiresAt <= now || lease.issuedAt > now + 60_000 || lease.expiresAt - lease.issuedAt > LEASE_MS)
    throw new OfflineError('locked', 'Offline prístup sa nepodarilo overiť.');
  await availableStorage(64 * 1024);
  return transaction('readwrite', async tx => {
    const key = orderKey(identity, order.id);
    const old = await requestValue(tx.objectStore('orders').get(key)) as OfflineOrder | undefined;
    if (old?.entries.length && old.order.assignmentGeneration !== order.assignmentGeneration)
      throw new OfflineError('pending', 'Pridelenie sa zmenilo. Najprv vyriešte neodoslanú prácu.');
    const scope: OfflineScope = { ...identity, key: scopeKey(identity), lease, consent: true, locked: false };
    const previous = await requestValue(tx.objectStore('scopes').get(scope.key)) as OfflineScope | undefined;
    if (previous?.syncOwner) { scope.syncOwner = previous.syncOwner; scope.syncUntil = previous.syncUntil; }
    await requestValue(tx.objectStore('scopes').put(scope));
    await putWithinBudget(tx, old?.entries.length ? { ...old, lease } : {
      key, scopeKey: scope.key, order: minimalOrder(order), loadedAt: now, revision: order.revision, entries: [], acknowledgedReceipts: [],
      lease,
    });
  });
}
export async function scopesForUser(userId: string, environment: string): Promise<OfflineScope[]> {
  return transaction('readonly', async tx => (await requestValue(tx.objectStore('scopes').getAll()) as OfflineScope[]).filter(s => s.userId === userId && s.environment === environment));
}
export async function readOrders(identity: OfflineIdentity, now = Date.now()) {
  return transaction('readonly', async tx => {
    await scopeIn(tx, identity, true, now);
    return (await requestValue(tx.objectStore('orders').getAll()) as OfflineOrder[]).filter(r => r.scopeKey === scopeKey(identity) && now < r.lease.expiresAt && (r.entries.length || now - r.loadedAt < SNAPSHOT_MS));
  });
}
export async function pendingSummary(identity: OfflineIdentity) {
  return transaction('readonly', async tx => {
    await scopeIn(tx, identity, false);
    const entries = (await requestValue(tx.objectStore('orders').getAll()) as OfflineOrder[]).filter(r => r.scopeKey === scopeKey(identity)).flatMap(r => r.entries);
    return { changes: entries.length, photos: entries.filter(e => e.phase === 'photo').length, receipts: entries.filter(e => e.phase === 'receipt').length };
  });
}
export async function lockScope(identity: OfflineIdentity) {
  return transaction('readwrite', async tx => {
    const scope = await scopeIn(tx, identity, false); scope.locked = true;
    await requestValue(tx.objectStore('scopes').put(scope));
  });
}
export async function enqueue(identity: OfflineIdentity, orderId: string, entry: OfflineEntry) {
  await availableStorage((entry.file?.size ?? 0) + 32 * 1024);
  return transaction('readwrite', async tx => {
    await scopeIn(tx, identity);
    const record = await requestValue(tx.objectStore('orders').get(orderKey(identity, orderId))) as OfflineOrder | undefined;
    if (!record) throw new OfflineError('missing', 'Zákazka nebola pripravená pre offline prácu.');
    if (Date.now() >= record.lease.expiresAt) throw new OfflineError('locked', 'Zákazku treba znova overiť online.');
    if (entry.command.targetId !== orderId || entry.command.assignmentGeneration !== record.order.assignmentGeneration || entry.sealed || entry.state !== 'pending')
      throw new OfflineError('identity', 'Zmenilo sa pridelenie zákazky.');
    if (record.entries.some(e => e.id === entry.id)) return;
    if (record.entries.some(e => e.phase === 'submit')) throw new OfflineError('pending', 'Dokončenie už čaká na odoslanie. Najprv ho synchronizujte alebo zrušte.');
    if (!['update_order','start','receive_payment','submit','attachment_intent'].includes(entry.command.type)) throw new OfflineError('unsupported', 'Táto operácia vyžaduje pripojenie.');
    record.entries.push(entry);
    await putWithinBudget(tx, record);
  });
}
/** Mutations remain transactional across tabs. A sent payload is never silently rebased. */
export async function editOrder(identity: OfflineIdentity, orderId: string, edit: (record: OfflineOrder) => void) {
  return transaction('readwrite', async tx => {
    await scopeIn(tx, identity);
    const record = await requestValue(tx.objectStore('orders').get(orderKey(identity, orderId))) as OfflineOrder | undefined;
    if (!record) throw new OfflineError('missing', 'Lokálny záznam nie je dostupný.');
    edit(record); await putWithinBudget(tx, record); return record;
  });
}
export async function quarantine(identity: OfflineIdentity, orderId?: string) {
  return transaction('readwrite', async tx => {
    const scope = await scopeIn(tx, identity, false);
    const records = (await requestValue(tx.objectStore('orders').getAll()) as OfflineOrder[]).filter(r => r.scopeKey === scope.key && (!orderId || r.order.id === orderId));
    for (const record of records) {
      for (const entry of record.entries.filter(e => e.phase === 'receipt')) {
        const p = entry.command.payload;
        const evidence: ReceiptEvidence = {
          key: `${scope.key}:${String(p.receiptId)}`, scopeKey: scope.key, orderId: record.order.id,
          receiptId: String(p.receiptId), assignmentGeneration: record.order.assignmentGeneration,
          amountCents: Number(p.amountCents), method: 'cash', capturedAt: String(p.capturedAt), status: 'requires_office_reconciliation',
        };
        await requestValue(tx.objectStore('receipts').put(evidence));
      }
      await requestValue(tx.objectStore('orders').delete(record.key));
    }
    if (!orderId) { scope.locked = true; await requestValue(tx.objectStore('scopes').put(scope)); }
  });
}
export async function readReceiptEvidence(identity: OfflineIdentity) {
  return transaction('readonly', async tx => {
    await scopeIn(tx, identity, false);
    return (await requestValue(tx.objectStore('receipts').getAll()) as ReceiptEvidence[]).filter(r => r.scopeKey === scopeKey(identity));
  });
}
export async function acquireSync(identity: OfflineIdentity, owner: string, now = Date.now()) {
  return transaction('readwrite', async tx => {
    const scope = await scopeIn(tx, identity, false);
    if (scope.syncOwner && scope.syncOwner !== owner && (scope.syncUntil ?? 0) > now) return false;
    scope.syncOwner = owner; scope.syncUntil = now + 60_000;
    await requestValue(tx.objectStore('scopes').put(scope)); return true;
  });
}
/** Identity-scoped opaque metadata permits reauthorization without revealing locked content. */
export async function recoveryTargets(identity: OfflineIdentity) {
  return transaction('readonly', async tx => {
    await scopeIn(tx, identity, false);
    return (await requestValue(tx.objectStore('orders').getAll()) as OfflineOrder[]).filter(r => r.scopeKey === scopeKey(identity))
      .map(r => ({ id: r.order.id, generation: r.order.assignmentGeneration }));
  });
}
export async function releaseSync(identity: OfflineIdentity, owner: string) {
  return transaction('readwrite', async tx => {
    const scope = await scopeIn(tx, identity, false);
    if (scope.syncOwner === owner) { delete scope.syncOwner; delete scope.syncUntil; await requestValue(tx.objectStore('scopes').put(scope)); }
  });
}
