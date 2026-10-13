import type { TowingCashAccount, TowingCommandResult, TowingMember, TowingOrder } from '@/domain/towing/types';
import { acquireSync, editOrder, lockScope, quarantine, readOrders, recoveryTargets, releaseSync, rememberOrder, scopeKey, type OfflineIdentity, type OfflineLease } from './store';

export interface DriverAccess { actor: TowingMember; order: TowingOrder; cashAccount: TowingCashAccount | null; lease: OfflineLease }
export class OfflineTransportError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export async function offlineRequest<T>(identity: OfflineIdentity, path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('X-Towing-User', identity.userId);
  const response = await fetch(path, { ...init, headers, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(45_000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new OfflineTransportError(response.status, data.code ?? 'unavailable', data.error ?? 'Odoslanie sa nepodarilo potvrdiť.');
  return data as T;
}
export function accessOrder(identity: OfflineIdentity, id: string, generation?: number) {
  const params = new URLSearchParams({ orderId: id });
  if (generation !== undefined) params.set('assignmentGeneration', String(generation));
  return offlineRequest<DriverAccess>(identity, `/api/towing/access?${params}`);
}
export interface SyncDependencies {
  currentUser: () => Promise<string | null>;
  access?: typeof accessOrder;
  request?: (identity: OfflineIdentity, path: string, init?: RequestInit) => Promise<TowingCommandResult>;
  onChange?: () => void;
}
const phaseOrder = { fields: 0, photo: 1, receipt: 2, submit: 3 };
export async function synchronize(identity: OfflineIdentity, dependencies: SyncDependencies) {
  const run = async () => {
    const owner = crypto.randomUUID();
    if (!await acquireSync(identity, owner)) return;
    const access = dependencies.access ?? accessOrder;
    const request = dependencies.request ?? offlineRequest<TowingCommandResult>;
    const assertIdentity = async () => {
      if (await dependencies.currentUser() !== identity.userId) {
        await lockScope(identity);
        throw new OfflineTransportError(401, 'identity_changed', 'Prihláste pôvodný účet. Jeho neodoslaná práca ostala zamknutá.');
      }
    };
    try {
      await assertIdentity();
      for (const target of await recoveryTargets(identity)) {
        if (!await acquireSync(identity, owner)) return;
        let verified: DriverAccess;
        try {
          await assertIdentity();
          verified = await access(identity, target.id, target.generation);
        } catch (error) {
          // Only the dedicated identity-checked access response proves revocation.
          if (error instanceof OfflineTransportError && error.status === 403 && ['membership_revoked','assignment_revoked'].includes(error.code)) {
            await quarantine(identity, error.code === 'membership_revoked' ? undefined : target.id);
            dependencies.onChange?.();
            if (error.code === 'membership_revoked') return;
            continue;
          }
          if (error instanceof OfflineTransportError && [401,403].includes(error.status)) await lockScope(identity);
          throw error;
        }
        if (verified.actor.userId !== identity.userId || verified.actor.organizationId !== identity.organizationId || verified.actor.id !== identity.membershipId)
          throw new OfflineTransportError(401, 'identity_changed', 'Overenie vrátilo iný účet. Nič sa neodoslalo.');
        await rememberOrder(identity, verified.actor, verified.order, verified.lease);
        for (;;) {
          const record = (await readOrders(identity)).find(r => r.order.id === target.id);
          if (!record) break;
          const entry = [...record.entries].sort((a, b) => phaseOrder[a.phase] - phaseOrder[b.phase])[0];
          if (!entry) break;
          if (entry.state === 'conflict') break;
          if (!entry.sealed && record.revision !== verified.order.revision) {
            await editOrder(identity, target.id, draft => {
              const next = draft.entries.find(e => e.id === entry.id)!;
              next.state = 'conflict'; next.error = 'Zákazka bola upravená inde. Porovnajte uložené a aktuálne údaje.';
            });
            break;
          }
          await assertIdentity();
          if (!await acquireSync(identity, owner)) return;
          const sealed = await editOrder(identity, target.id, draft => {
            const next = draft.entries.find(e => e.id === entry.id)!;
            if (!next.sealed) {
              next.command.expectedRevision = draft.revision;
              if (next.phase === 'receipt') next.command.payload.accountRevision = verified.cashAccount?.revision ?? 1;
              if (next.phase === 'submit') next.command.payload.receiptIds = draft.acknowledgedReceipts;
              next.sealed = true;
            }
            next.state = 'sending'; delete next.error;
          });
          const next = sealed.entries.find(e => e.id === entry.id)!;
          try {
            let result: TowingCommandResult;
            if (next.phase === 'photo') {
              if (!next.file) throw new Error('Lokálna fotografia nie je dostupná. Dokončenie ostáva zablokované.');
              const form = new FormData();
              form.set('file', next.file, next.fileName ?? 'fotografia.jpg');
              form.set('commandId', next.command.commandId);
              form.set('attachmentId', String(next.command.payload.id));
              form.set('expectedRevision', String(next.command.expectedRevision));
              form.set('assignmentGeneration', String(next.command.assignmentGeneration));
              form.set('kind', String(next.command.payload.kind));
              result = await request(identity, `/api/towing/orders/${target.id}/attachments`, { method: 'POST', body: form });
            } else {
              result = await request(identity, '/api/towing/commands', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next.command),
              });
            }
            if (result.commandId !== next.command.commandId || result.targetId !== target.id || !Number.isSafeInteger(result.revision))
              throw new Error('Server nepotvrdil identitu záznamu. Zopakujte rovnaké odoslanie.');
            await editOrder(identity, target.id, draft => {
              const item = draft.entries.find(e => e.id === next.id);
              if (!item) return;
              draft.entries = draft.entries.filter(e => e.id !== next.id); // Removing the acknowledged blob frees storage immediately.
              draft.revision = result.revision;
              if (next.phase === 'receipt') draft.acknowledgedReceipts.push(String(next.command.payload.receiptId));
              if (next.phase === 'fields' && next.command.payload.fields) Object.assign(draft.order.fields, next.command.payload.fields);
            });
            if (next.phase === 'submit') {
              await quarantine(identity, target.id); // All earlier entries were acknowledged; there is no unconfirmed receipt to discard.
              break;
            }
            verified = await access(identity, target.id, target.generation);
          } catch (error) {
            await editOrder(identity, target.id, draft => {
              const item = draft.entries.find(e => e.id === next.id);
              if (!item) return;
              item.state = error instanceof OfflineTransportError && error.status === 409 ? 'conflict' : 'failed';
              item.error = error instanceof Error ? error.message : 'Odoslanie nebolo potvrdené.';
              item.lastHttpStatus = error instanceof OfflineTransportError ? error.status : 0;
            });
            if (error instanceof OfflineTransportError && [401,403].includes(error.status)) await lockScope(identity);
            break;
          } finally { dependencies.onChange?.(); }
        }
      }
    } finally { await releaseSync(identity, owner); dependencies.onChange?.(); }
  };
  // IndexedDB lease is also checked for browsers without Web Locks; server receipts remain the final dedupe boundary.
  if (globalThis.navigator?.locks) return navigator.locks.request(`towing:${scopeKey(identity)}`, { ifAvailable: true }, lock => lock ? run() : undefined);
  return run();
}
