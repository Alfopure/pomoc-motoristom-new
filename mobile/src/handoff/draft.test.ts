import { describe, expect, it, vi } from 'vitest';
import type { HandoffApi } from './api';
import { HandoffDraft, previewSnapshot } from './draft';
import { MobileApiError } from '../lib/api';
import { caseId, commandId, context, grantId, receipt, withGrant } from './fixtures';
const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
};
function setup(initial = context()) {
  const api = { context: vi.fn(async () => initial), command: vi.fn<HandoffApi['command']>(async () => receipt()) };
  const draft = new HandoffDraft(api, caseId, () => commandId);
  return { api, draft };
}
async function issue(draft: HandoffDraft) {
  await draft.refresh();
  draft.select('issue');
  draft.edit({ recipientName: 'MOCK', recipientPhone: '+421900000000', instructions: 'Presné pokyny' });
}
describe('handoff retained commands and secret lifetime', () => {
  it('pins reviewed preview while a newer context arrives', async () => {
    const { api, draft } = setup();
    await issue(draft);
    api.context.mockResolvedValue({ ...context(), previewVersion: 'b'.repeat(64), preview: { ...context().preview, caseNumber: 'CHANGED' } });
    await draft.refresh();
    expect(draft.snapshot().selected?.preview.caseNumber).toBe('MOCK-42');
    await draft.submit();
    expect(api.command.mock.calls[0][1]).toMatchObject({ previewVersion: 'a'.repeat(64), instructions: 'Presné pokyny' });
  });
  it('single flight and timeout then409 keep the exact original command', async () => {
    const { api, draft } = setup();
    await issue(draft);
    api.command.mockRejectedValueOnce(new MobileApiError('timeout', 0)).mockRejectedValueOnce(new MobileApiError('conflict', 409));
    await Promise.all([draft.submit(), draft.submit()]);
    expect(api.command).toHaveBeenCalledTimes(1);
    const frozen = draft.snapshot().pending;
    draft.edit({ instructions: 'changed' });
    await draft.reconcile();
    expect(draft.snapshot().status).toBe('uncertain');
    expect(draft.snapshot().pending).toEqual(frozen);
    expect(api.command.mock.calls[1][1]).toEqual(api.command.mock.calls[0][1]);
  });
  it('requires fresh conflict read and explicit rebase', async () => {
    const { api, draft } = setup();
    await issue(draft);
    api.command.mockRejectedValueOnce(new MobileApiError('conflict', 409));
    await draft.submit();
    expect(draft.rebase()).toBe(false);
    await draft.refresh();
    expect(draft.snapshot().status).toBe('conflict');
    expect(draft.rebase()).toBe(true);
    expect(draft.snapshot().input.instructions).toBe('Presné pokyny');
  });
  it('saved proof survives GET and same-command URL retry failure', async () => {
    const { api, draft } = setup();
    await issue(draft);
    api.command.mockResolvedValueOnce({ ...receipt(), link: { status: 'unavailable', warning: 'link_unavailable' } });
    await draft.submit();
    api.context.mockRejectedValueOnce(new MobileApiError('offline', 503));
    await draft.refresh();
    api.command.mockRejectedValueOnce(new MobileApiError('denied', 403));
    await draft.reconcile();
    expect(draft.snapshot().status).toBe('saved');
    expect(draft.snapshot().receipt?.commandId).toBe(commandId);
    expect(draft.snapshot().link).toBeNull();
  });
  it('clears expired link at Share even without timer', async () => {
    const { draft } = setup();
    await issue(draft);
    await draft.submit();
    expect(draft.shareUrl(Date.parse('2100-01-01'))).toBeNull();
    expect(draft.snapshot().receipt).not.toBeNull();
  });
  it('clears known changed/missing grant and ignores late recovery after new read', async () => {
    const { api, draft } = setup(withGrant());
    await draft.refresh();
    const pending = deferred<ReturnType<typeof receipt>>();
    api.command.mockImplementationOnce(() => pending.promise);
    const recovering = draft.recover(grantId);
    api.context.mockResolvedValue(context());
    await draft.refresh();
    pending.resolve({ ...receipt(), kind: 'link' } as never);
    await recovering;
    expect(draft.snapshot().link).toBeNull();
  });
  it('clears secret before uncertain revoke and ignores disposed writes', async () => {
    const { api, draft } = setup(withGrant());
    await draft.refresh();
    api.command.mockResolvedValueOnce({ ...receipt(), kind: 'link' } as never);
    await draft.recover(grantId);
    expect(draft.shareUrl()).toContain('/handoff');
    draft.select('revoke', grantId);
    draft.edit({ comment: 'Dôvod' });
    api.command.mockRejectedValueOnce(new MobileApiError('timeout', 0));
    await draft.submit();
    expect(draft.snapshot().link).toBeNull();
    expect(draft.snapshot().status).toBe('uncertain');
    draft.dispose();
    expect(draft.snapshot().pending).toBeNull();
  });
});
describe('handoff lifecycle races', () => {
  it('a pre-conflict read cannot unlock rebase and rebase is blocked during refresh', async () => {
    const { api, draft } = setup();
    await issue(draft);
    const read = deferred<ReturnType<typeof context>>();
    api.context.mockImplementationOnce(() => read.promise);
    const loading = draft.refresh();
    api.command.mockRejectedValueOnce(new MobileApiError('conflict', 409));
    await draft.submit();
    read.resolve(context());
    await loading;
    expect(draft.rebase()).toBe(false);
    await draft.refresh();
    const next = deferred<ReturnType<typeof context>>();
    api.context.mockImplementationOnce(() => next.promise);
    const refresh = draft.refresh();
    expect(draft.rebase()).toBe(false);
    next.resolve(context());
    await refresh;
    expect(draft.rebase()).toBe(true);
    expect(draft.snapshot().status).toBe('editing');
  });
  it.each([401, 403, 409, 422, 503])('retains uncertain identity after later %i', async (status) => {
    const { api, draft } = setup();
    await issue(draft);
    api.command.mockRejectedValueOnce(new MobileApiError('timeout', 0)).mockRejectedValueOnce(new MobileApiError('later', status));
    await draft.submit();
    const original = draft.snapshot().pending;
    await draft.reconcile();
    expect(draft.snapshot().pending).toEqual(original);
    expect(draft.snapshot().status).toBe('uncertain');
  });
  it.each(['revision', 'missing', 'terminal', 'auth'] as const)('clears cached URL on %s without losing proof', async (reason) => {
    const { api, draft } = setup();
    await issue(draft);
    await draft.submit();
    expect(draft.shareUrl()).not.toBeNull();
    const next = withGrant();
    if (reason === 'revision')
      next.handoffs[0].revision = 2;
    if (reason === 'terminal')
      next.handoffs[0].status = 'cancelled';
    if (reason === 'missing')
      next.handoffs = [];
    if (reason === 'auth')
      api.context.mockRejectedValueOnce(new MobileApiError('denied', 401));
    else
      api.context.mockResolvedValueOnce(next);
    await draft.refresh();
    expect(draft.snapshot().link).toBeNull();
    expect(draft.snapshot().receipt?.commandId).toBe(commandId);
    expect(JSON.stringify(draft.snapshot().receipt)).not.toContain('#token=');
  });
  it('stale context cannot roll back a newly committed link', async () => {
    const { api, draft } = setup();
    await issue(draft);
    const read = deferred<ReturnType<typeof context>>();
    api.context.mockImplementationOnce(() => read.promise);
    const refresh = draft.refresh();
    await draft.submit();
    read.resolve(context());
    await refresh;
    expect(draft.shareUrl()).not.toBeNull();
  });
  it('disposal prevents late commit and erases private concept', async () => {
    const { api, draft } = setup();
    await issue(draft);
    const pending = deferred<ReturnType<typeof receipt>>();
    api.command.mockImplementationOnce(() => pending.promise);
    const save = draft.submit();
    draft.dispose();
    pending.resolve(receipt());
    await save;
    expect(draft.snapshot().receipt).toBeNull();
    expect(draft.snapshot().input.recipientName).toBe('');
    expect(draft.snapshot().link).toBeNull();
  });
  it('a later action fences recovery even before submission', async () => {
    const { api, draft } = setup(withGrant());
    await draft.refresh();
    const response = deferred<Awaited<ReturnType<HandoffApi['command']>>>();
    api.command.mockImplementationOnce(() => response.promise);
    const recovering = draft.recover(grantId);
    draft.select('renew', grantId);
    response.resolve({ ...receipt(), kind: 'link', link: {
        status: 'available', url: 'https://test.dispecing.linkapomoci.sk/handoff#token=' + 'a'.repeat(43), expiresAt: '2099-01-01T00:00:00Z', currentRevision: 1
      } });
    await recovering;
    expect(draft.snapshot().link).toBeNull();
  });
});
describe('handoff local input checks', () => {
  it('rejects lone Unicode surrogate before retaining or sending command', async () => {
    const { api, draft } = setup();
    await issue(draft);
    draft.edit({ instructions: 'bad\ud800' });
    await draft.submit();
    expect(api.command).not.toHaveBeenCalled();
    expect(draft.snapshot().pending).toBeNull();
    expect(draft.snapshot().status).toBe('editing');
  });
  it('preserves legitimate Unicode through the exact command', async () => {
    const { api, draft } = setup();
    await issue(draft);
    draft.edit({ instructions: 'Ťahač 🚗' });
    await draft.submit();
    expect(api.command.mock.calls[0][1]).toMatchObject({ instructions: 'Ťahač 🚗' });
  });
});
describe('definitively rejected action can be closed', () => {
  it('fresh active grant makes issue impossible but explicit close allows current-link recovery', async () => {
    const { api, draft } = setup();
    await issue(draft);
    api.command.mockRejectedValueOnce(new MobileApiError('conflict', 409));
    await draft.submit();
    draft.cancel();
    expect(draft.snapshot().status).toBe('conflict');
    api.context.mockResolvedValue(withGrant());
    await draft.refresh();
    expect(draft.rebase()).toBe(false);
    draft.cancel();
    expect(draft.snapshot().status).toBe('editing');
    expect(draft.snapshot().pending).toBeNull();
    expect(draft.snapshot().input.instructions).toBe('Presné pokyny');
    expect(draft.select('renew', grantId)).toBe(true);
  });
  it('a revoked target cannot publish but can close and deliberately issue a new grant', async () => {
    const { api, draft } = setup(withGrant());
    await draft.refresh();
    draft.select('publish', grantId);
    api.command.mockRejectedValueOnce(new MobileApiError('conflict', 409));
    await draft.submit();
    const latest = withGrant();
    latest.handoffs[0].status = 'cancelled';
    latest.handoffs[0].canRenew = false;
    api.context.mockResolvedValue(latest);
    await draft.refresh();
    expect(draft.rebase()).toBe(false);
    draft.cancel();
    expect(draft.select('issue')).toBe(true);
  });
  it('never closes an ambiguous command', async () => {
    const { api, draft } = setup();
    await issue(draft);
    api.command.mockRejectedValueOnce(new MobileApiError('timeout', 0));
    await draft.submit();
    await draft.refresh();
    draft.cancel();
    expect(draft.snapshot().status).toBe('uncertain');
    expect(draft.snapshot().pending).not.toBeNull();
  });
});
describe('pinned schedule and current capabilities', () => {
  it('displays the exact submitted UTC schedule after device timezone changes during uncertainty', async () => {
    vi.stubEnv('TZ', 'UTC');
    try {
      const { api, draft } = setup();
      await issue(draft);
      draft.edit({ scheduledAt: '2026-11-15 10:30' });
      api.command.mockRejectedValueOnce(new MobileApiError('timeout', 0));
      await draft.submit();
      const command = draft.snapshot().pending!;
      vi.stubEnv('TZ', 'America/Los_Angeles');
      expect(previewSnapshot(draft.snapshot())?.scheduledAt).toBe('2026-11-15T10:30:00.000Z');
      expect(previewSnapshot(draft.snapshot())?.instructions).toBe('Presné pokyny');
      expect(command).toMatchObject({ scheduledAt: '2026-11-15T10:30:00.000Z' });
    }
    finally {
      vi.unstubAllEnvs();
    }
  });
  it('does not recover envelope when current enhanced flag is disabled', async () => {
    const { api, draft } = setup({ ...withGrant(), enhanced: false });
    await draft.refresh();
    await draft.recover(grantId);
    expect(api.command).not.toHaveBeenCalled();
  });
  it('disabled enhanced flag never discards or blocks exact original known-command reconciliation', async () => {
    const { api, draft } = setup();
    await issue(draft);
    api.command.mockResolvedValueOnce({ ...receipt(), link: { status: 'unavailable', warning: 'link_unavailable' } });
    await draft.submit();
    const original = draft.snapshot().pending;
    api.context.mockResolvedValue({ ...withGrant(), enhanced: false });
    await draft.refresh();
    await draft.reconcile();
    expect(api.command.mock.calls[1][1]).toEqual(original);
    expect(draft.snapshot().status).toBe('saved');
  });
});
describe('schedule input feedback', () => {
  it('rejects impossible local calendar time before sending and keeps the draft editable', async () => {
    const { api, draft } = setup();
    await issue(draft);
    draft.edit({ scheduledAt: '2026-02-30 10:30' });
    await draft.submit();
    expect(api.command).not.toHaveBeenCalled();
    expect(draft.snapshot().status).toBe('editing');
    expect(draft.snapshot().pending).toBeNull();
    expect(draft.snapshot().error).toContain('RRRR-MM-DD HH:mm');
  });
});

describe('handoff to a pristavovač in the app', () => {
  const member = { id: '77777777-7777-4777-8777-777777777777', displayName: 'MOCK Pristavovač', lastPhone: '+421900000002' };
  const withMembers = (value = context()) => ({ ...value, delivery: { members: [member] } });
  it('issues to the chosen pristavovač with their phone', async () => {
    const { api, draft } = setup(withMembers());
    await draft.refresh();
    draft.select('issue');
    draft.edit({ recipientMemberId: member.id, recipientName: member.displayName, recipientPhone: member.lastPhone });
    api.command.mockResolvedValueOnce({ ...receipt(), delivery: { status: 'sent', memberId: member.id } });
    await draft.submit();
    expect(api.command.mock.calls[0][1]).toMatchObject({ action: 'issue', recipientMemberId: member.id, recipientName: member.displayName, recipientPhone: member.lastPhone });
    expect(draft.snapshot().receipt?.delivery).toEqual({ status: 'sent', memberId: member.id });
  });
  it('leaves the member out of a link-only handoff', async () => {
    const { api, draft } = setup(withMembers());
    await issue(draft);
    await draft.submit();
    expect(api.command.mock.calls[0][1]).not.toHaveProperty('recipientMemberId');
  });
  it('refuses a pristavovač the server no longer offers', async () => {
    const { api, draft } = setup(withMembers());
    await draft.refresh();
    draft.select('issue');
    draft.edit({ recipientMemberId: member.id, recipientName: member.displayName, recipientPhone: member.lastPhone });
    api.context.mockResolvedValueOnce(context());
    await draft.refresh();
    await draft.submit();
    expect(api.command).not.toHaveBeenCalled();
    expect(draft.snapshot().error).toBe('Vybraný pristavovač už nie je dostupný. Vyberte ho znova.');
  });
  it('asks for the pristavovač phone when none is known', async () => {
    const { api, draft } = setup(withMembers());
    await draft.refresh();
    draft.select('issue');
    draft.edit({ recipientMemberId: member.id, recipientName: member.displayName, recipientPhone: '' });
    await draft.submit();
    expect(api.command).not.toHaveBeenCalled();
    expect(draft.snapshot().error).toBe('Doplňte platné telefónne číslo pristavovača.');
  });
  it('sends a waiting link-only handoff to the app once and refreshes', async () => {
    const { api, draft } = setup(withMembers(withGrant()));
    await draft.refresh();
    const answer = deferred<Awaited<ReturnType<HandoffApi['command']>>>();
    api.command.mockImplementationOnce(() => answer.promise);
    const sending = draft.deliver(grantId, member.id);
    await draft.deliver(grantId, member.id);
    expect(draft.snapshot().delivering).toBe(grantId);
    answer.resolve({ ...receipt(), kind: 'delivery', memberId: member.id, sent: true } as unknown as Awaited<ReturnType<HandoffApi['command']>>);
    await sending;
    expect(api.command).toHaveBeenCalledOnce();
    expect(api.command.mock.calls[0][1]).toEqual({ action: 'deliver', commandId, handoffId: grantId, expectedRevision: 1, recipientMemberId: member.id });
    expect(draft.snapshot()).toMatchObject({ delivering: null, delivered: { handoffId: grantId, memberId: member.id }, error: null });
    expect(api.context).toHaveBeenCalledTimes(2);
  });
  it('does not send a closed handoff or to an unknown pristavovač', async () => {
    const accepted = withGrant();
    accepted.handoffs[0] = { ...accepted.handoffs[0], status: 'accepted' };
    const { api, draft } = setup(withMembers(accepted));
    await draft.refresh();
    await draft.deliver(grantId, member.id);
    await draft.deliver(grantId, '88888888-8888-4888-8888-888888888888');
    expect(api.command).not.toHaveBeenCalled();
  });
  it('shows a failed send and allows another try', async () => {
    const { api, draft } = setup(withMembers(withGrant()));
    await draft.refresh();
    api.command.mockRejectedValueOnce(new MobileApiError('Pristavovač už nie je dostupný.', 409));
    await draft.deliver(grantId, member.id);
    expect(draft.snapshot()).toMatchObject({ delivering: null, delivered: null, error: 'Pristavovač už nie je dostupný.' });
    expect(draft.snapshot().status).toBe('editing');
  });
});

describe('quiet re-reading of the handoff screen', () => {
  it('updates the handoffs without a loading state and keeps a shown error', async () => {
    const members = { members: [{ id: '77777777-7777-4777-8777-777777777777', displayName: 'MOCK', lastPhone: null }] };
    const { api, draft } = setup({ ...withGrant(), delivery: members });
    await draft.refresh();
    api.command.mockRejectedValueOnce(new MobileApiError('Pristavovač už nie je dostupný.', 409));
    await draft.deliver(grantId, '77777777-7777-4777-8777-777777777777');
    expect(draft.snapshot().error).toBe('Pristavovač už nie je dostupný.');
    const accepted = { ...withGrant(), delivery: members };
    accepted.handoffs[0] = { ...accepted.handoffs[0], status: 'accepted' };
    api.context.mockResolvedValueOnce(accepted);
    const states: boolean[] = [];
    draft.subscribe(() => states.push(draft.snapshot().loading));
    await draft.refresh(true);
    expect(draft.snapshot().context?.handoffs[0].status).toBe('accepted');
    expect(draft.snapshot().error).toBe('Pristavovač už nie je dostupný.');
    expect(states).not.toContain(true);
  });
  it('keeps what it showed when a quiet read fails', async () => {
    const { api, draft } = setup(withGrant());
    await draft.refresh();
    api.context.mockRejectedValueOnce(new MobileApiError('offline', 0));
    await draft.refresh(true);
    expect(draft.snapshot()).toMatchObject({ error: null, loading: false });
    expect(draft.snapshot().context?.handoffs).toHaveLength(1);
  });
  it('waits while a read or a send to the app runs', async () => {
    const { api, draft } = setup({ ...withGrant(), delivery: { members: [{ id: '77777777-7777-4777-8777-777777777777', displayName: 'MOCK', lastPhone: null }] } });
    await draft.refresh();
    const answer = deferred<Awaited<ReturnType<HandoffApi['command']>>>();
    api.command.mockImplementationOnce(() => answer.promise);
    const sending = draft.deliver(grantId, '77777777-7777-4777-8777-777777777777');
    await draft.refresh(true);
    expect(api.context).toHaveBeenCalledTimes(1);
    answer.resolve({ ...receipt(), kind: 'delivery', memberId: '77777777-7777-4777-8777-777777777777', sent: true } as unknown as Awaited<ReturnType<HandoffApi['command']>>);
    await sending;
    expect(draft.snapshot().delivered).toEqual({ handoffId: grantId, memberId: '77777777-7777-4777-8777-777777777777' });
  });
  it('never discards a send to the app or a link started during a quiet read', async () => {
    const member = '77777777-7777-4777-8777-777777777777';
    const { api, draft } = setup({ ...withGrant(), delivery: { members: [{ id: member, displayName: 'MOCK', lastPhone: null }] } });
    await draft.refresh();
    const reading = deferred<ReturnType<typeof withGrant>>(), answer = deferred<Awaited<ReturnType<HandoffApi['command']>>>();
    api.context.mockImplementationOnce(() => reading.promise);
    api.command.mockImplementationOnce(() => answer.promise);
    const quiet = draft.refresh(true);
    const sending = draft.deliver(grantId, member);
    // The quiet read ends while the send is still on its way.
    reading.resolve({ ...withGrant(), delivery: { members: [{ id: member, displayName: 'MOCK', lastPhone: null }] } });
    await quiet;
    answer.resolve({ ...receipt(), kind: 'delivery', memberId: member, sent: true } as unknown as Awaited<ReturnType<HandoffApi['command']>>);
    await sending;
    expect(draft.snapshot().delivered).toEqual({ handoffId: grantId, memberId: member });
    expect(draft.snapshot().error).toBeNull();
  });
});
