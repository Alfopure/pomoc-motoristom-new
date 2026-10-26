import { describe, expect, it, vi } from 'vitest';
import { createPartnerDraftStore, emptyPartnerDraft, hasPartnerDraft, partnerCommandIntent, preserveUnconfirmedPartnerCommand } from './partner-drafts';

describe('session scoped partner drafts', () => {
  it('restores each case after module or keyed panel unmount without mixing another case or account', () => {
    const session = createPartnerDraftStore();
    const listener = vi.fn(); const unsubscribe = session.subscribe(listener);
    session.update('case:one', { result: 'Unpublished result', recipient: 'approved@example.invalid', settlementDirty: true });
    unsubscribe(); // The component leaves; the workspace owns the draft lifetime.
    session.update('case:two', { result: 'Another consultation' });
    expect(session.get('case:one').result).toBe('Unpublished result');
    expect(session.get('case:one').recipient).toBe('approved@example.invalid');
    expect(session.get('case:two').recipient).toBe('');
    expect(createPartnerDraftStore().get('case:one').result).toBe('');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(hasPartnerDraft(session.get('case:one'))).toBe(true);
  });
  it('freezes the entire pending command across timeout, navigation discard and revision refresh', () => {
    const store = createPartnerDraftStore();
    const body = JSON.stringify({ action: 'create_assistance', expectedRevision: 1, payload: { payer: 'Independent', reference: 'REF' } });
    const newId = vi.fn(() => 'original-command');
    const pending = partnerCommandIntent(store.get('case:one'), body, newId);
    store.update('case:one', { pending: { ...pending, unconfirmed: true } });
    store.update('case:one', preserveUnconfirmedPartnerCommand(store.get('case:one')));
    expect(store.get('case:one').pending?.acknowledged).toBe(true);
    expect(partnerCommandIntent(store.get('case:one'), body, newId).id).toBe('original-command');
    expect(() => partnerCommandIntent(store.get('case:one'), body.replace('REF', 'NEW'), newId)).toThrow('Najprv overte');
    expect(newId).toHaveBeenCalledTimes(1);
    expect(store.get('case:one').pending?.body).toBe(body);
  });
  it('creates a new explicit intent only after the original receipt is confirmed', () => {
    const draft = emptyPartnerDraft();
    const first = partnerCommandIntent(draft, 'publish-one', () => 'one');
    draft.pending = first;
    expect(() => partnerCommandIntent(draft, 'publish-two', () => 'two')).toThrow();
    draft.pending = null;
    expect(partnerCommandIntent(draft, 'publish-two', () => 'two').id).toBe('two');
  });
});
