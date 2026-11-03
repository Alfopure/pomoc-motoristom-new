import { emptyPartnerSettlement, type PartnerSettlement } from '@/domain/partners';

export type PartnerPendingCommand = { id: string; body: string; unconfirmed: boolean; acknowledged: boolean };
export type PartnerDraft = {
  partnerId: string; lineId: string; settlement: PartnerSettlement; settlementDirty: boolean;
  payer: string; reference: string; title: string; result: string; recipient: string; confirmed: boolean;
  name: string; email: string; newMembershipId: string; pending: PartnerPendingCommand | null; busy: boolean;
};

export function emptyPartnerDraft(): PartnerDraft {
  return { partnerId: '', lineId: '', settlement: { ...emptyPartnerSettlement }, settlementDirty: false,
    payer: '', reference: '', title: 'Výsledok konzultácie', result: '', recipient: '', confirmed: false,
    name: '', email: '', newMembershipId: '', pending: null, busy: false };
}

/** Created by the mounted workspace provider, never shared between server requests or users. */
export function createPartnerDraftStore() {
  const drafts = new Map<string, PartnerDraft>();
  const listeners = new Set<() => void>();
  let version = 0;
  const get = (key: string) => {
    let draft = drafts.get(key);
    if (!draft) { draft = emptyPartnerDraft(); drafts.set(key, draft); }
    return draft;
  };
  const update = (key: string, patch: Partial<PartnerDraft> | ((draft: PartnerDraft) => Partial<PartnerDraft>)) => {
    const draft = get(key);
    drafts.set(key, { ...draft, ...(typeof patch === 'function' ? patch(draft) : patch) });
    version += 1;
    for (const listener of listeners) listener();
  };
  return { get, update, entries: () => [...drafts.entries()], version: () => version,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}

export function partnerCommandIntent(draft: PartnerDraft, body: string, newId: () => string): PartnerPendingCommand {
  if (draft.pending) {
    if (draft.pending.body !== body) throw new Error('Najprv overte pôvodný nepotvrdený príkaz. Nový zámer sa nevytvoril.');
    return draft.pending;
  }
  return { id: newId(), body, unconfirmed: false, acknowledged: false };
}

export function preserveUnconfirmedPartnerCommand(draft: PartnerDraft): Partial<PartnerDraft> {
  // Discarding a navigation dialog cannot undo a command that may have committed.
  return draft.pending ? { pending: { ...draft.pending, acknowledged: true } } : {};
}

export function hasPartnerDraft(draft: PartnerDraft) {
  return Boolean(draft.pending || draft.busy || draft.settlementDirty || draft.result || draft.recipient
    || draft.payer || draft.reference || draft.name || draft.email);
}
