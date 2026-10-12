import { describe, expect, it, vi } from 'vitest';
import { HandoffDraft, previewSnapshot } from './draft';
import { caseId, commandId, context , receipt, scope, withGrant } from './fixtures';
import { DraftNotSentError, type DraftPort } from '../drafts/port';

import { memoryPort, deferred, jsonCopy } from '../work/draft-test-port';
import { MobileApiError } from '../lib/api';
describe('handoff durable preparation', () => {
  it('does not send a grant mutation if WAL preparation fails', async () => {
    const api = { context: vi.fn(async () => context()), command: vi.fn() };
    const port: DraftPort = { load: () => null, changed: vi.fn(), prepare: vi.fn().mockRejectedValue(new DraftNotSentError()), current: () => true, acceptsScope: () => true, settled: () => true, reject: vi.fn() };
    const draft = new HandoffDraft(api, caseId, () => commandId, () => {}, port);
    await draft.refresh(); draft.select('issue'); draft.edit({ recipientName: 'MOCK', recipientPhone: '+421900000001' }); await draft.submit();
    expect(port.prepare).toHaveBeenCalledOnce(); expect(api.command).not.toHaveBeenCalled(); expect(draft.snapshot().status).toBe('editing');
  });
});
function storage(saved: unknown = null) {
  const f = memoryPort(saved); f.port.acceptsScope = value => { const v = value as typeof scope; return v?.ok === true && v.apiVersion === 1 && v.profileId === scope.profileId && v.environment === scope.environment; }; return f;
}
function durable(saved: unknown = null) {
  const f = storage(saved), api = { context: vi.fn(async () => context()), command: vi.fn(async () => receipt()) };
  return { ...f, api, draft: new HandoffDraft(api, caseId, () => commandId, () => {}, f.port) };
}
async function select(draft: HandoffDraft) { await draft.refresh(); draft.select('issue'); draft.edit({ recipientName: 'MOCK', recipientPhone: '+421900000000', instructions: 'Presný pokyn', scheduledAt: '2026-10-12 14:30' }); }
describe('handoff restoration and captured receipts', () => {
  it('restores unsent selected preview only as explicit fresh-context comparison', async () => {
    const f = durable(); await select(f.draft); const restored = durable(f.draft.exportDraft());
    expect(restored.draft.snapshot()).toMatchObject({ status: 'conflict', context: null, canRebase: false, link: null });
    await restored.draft.submit(); expect(restored.api.command).not.toHaveBeenCalled(); expect(restored.draft.rebase()).toBe(false);
    await restored.draft.refresh(); expect(restored.draft.rebase()).toBe(true); expect(restored.draft.snapshot().input.instructions).toBe('Presný pokyn');
    expect(restored.api.command).not.toHaveBeenCalled();
  });
  it('awaits WAL with synchronous busy flag and prevents send on scope change', async () => {
    const f = durable(); await select(f.draft); const wait = deferred<Awaited<ReturnType<DraftPort['prepare']>>>();
    vi.mocked(f.port.prepare).mockImplementationOnce(() => wait.promise);
    const saving = f.draft.submit(); await f.draft.submit(); expect(f.draft.busy).toBe(true); expect(f.api.command).not.toHaveBeenCalled();
    f.record.live = false; wait.resolve({ finish: async () => true }); await saving;
    expect(f.api.command).not.toHaveBeenCalled(); expect(f.draft.snapshot().status).toBe('editing');
  });
  it('restores a crashed sending record with original UTC/UUID/full preview and no URL/history', async () => {
    const f = durable(); await select(f.draft); const wait = deferred<ReturnType<typeof receipt>>(); f.api.command.mockImplementationOnce(() => wait.promise);
    const saving = f.draft.submit(); await Promise.resolve(); const wal = jsonCopy(f.record.payload), restored = durable(wal);
    expect(restored.draft.snapshot().status).toBe('uncertain'); expect(restored.api.command).not.toHaveBeenCalled();
    expect(restored.draft.snapshot().selected?.preview).toEqual(context().preview); expect(previewSnapshot(restored.draft.snapshot())?.scheduledAt).toBe(new Date(2026, 9, 12, 14, 30).toISOString());
    const encoded = JSON.stringify(wal); for (const forbidden of ['"context"', '"url"', '"events"', '"handoffs"']) expect(encoded).not.toContain(forbidden);
    await restored.draft.reconcile(); expect(restored.api.command.mock.calls[0]).toEqual(f.api.command.mock.calls[0]);
    wait.resolve(receipt()); await saving;
  });
  it.each([401, 403, 409, 422])('keeps an uncertain original command after later denial %s', async status => {
    const f = durable(); await select(f.draft); f.api.command.mockRejectedValueOnce(new MobileApiError('unknown', 0)); await f.draft.submit();
    const restored = durable(f.record.payload); restored.api.command.mockRejectedValueOnce(new MobileApiError('denied', status)); await restored.draft.reconcile();
    expect(restored.draft.snapshot().status).toBe('uncertain'); expect(restored.draft.snapshot().pending).toEqual(f.draft.snapshot().pending);
  });
  it('writes verified late receipt after disposal without updating disposed UI', async () => {
    const f = durable(); await select(f.draft); const wait = deferred<ReturnType<typeof receipt>>(); f.api.command.mockImplementationOnce(() => wait.promise);
    const saving = f.draft.submit(); await Promise.resolve(); f.draft.dispose(); wait.resolve(receipt()); expect(await saving).toBeUndefined();
    expect(f.record.payload).toMatchObject({ status: 'saved', receipt: { commandId, link: { status: 'not_requested' } } }); expect(f.draft.snapshot().receipt).toBeNull();
    expect(JSON.stringify(f.record.payload)).not.toContain('token=');
  });
  it('keeps known receipt after local failure; neither select nor server replay repairs storage', async () => {
    const f = durable(); await select(f.draft); f.record.finishOk = false; await f.draft.submit();
    expect(f.draft.snapshot()).toMatchObject({ status: 'saved', receipt: { commandId } }); expect(f.draft.snapshot().error).toContain('miestne');
    await f.draft.reconcile(); expect(f.api.command).toHaveBeenCalledOnce(); expect(f.draft.select('issue')).toBe(false);
    expect(f.record.payload).toMatchObject({ status: 'saving' });
  });
  it('restores known save without share URL and never recovers automatically', async () => {
    const f = durable(); await select(f.draft); await f.draft.submit(); const restored = durable(f.record.payload);
    expect(restored.draft.snapshot()).toMatchObject({ status: 'saved', receipt: { commandId }, link: null, context: null });
    expect(restored.draft.shareUrl()).toBeNull(); expect(restored.api.command).not.toHaveBeenCalled();
  });
  it('explicit link retrieval checks durable live scope without storing returned URL', async () => {
    const f = durable(); f.api.context.mockResolvedValue(withGrant()); await f.draft.refresh();
    vi.mocked(f.port.prepare).mockRejectedValueOnce(new DraftNotSentError()); await f.draft.recover(withGrant().handoffs[0].id);
    expect(f.api.command).not.toHaveBeenCalled(); expect(f.draft.shareUrl()).toBeNull();
  });
  it('rejects wrong schema, hidden URL, cross-scope receipt and mismatched exact command', async () => {
    const f = durable(); await select(f.draft); await f.draft.submit(); const original = f.draft.exportDraft();
    for (const invalid of [
      { ...original, version: 2 }, { ...original, url: 'private' }, { ...original, context: context() },
      { ...original, receipt: { ...original.receipt!, profileId: caseId } },
      { ...original, receipt: { ...original.receipt!, link: receipt().link } },
      { ...original, pending: { ...original.pending!, previewVersion: 'b'.repeat(64) } },
    ]) { const restored = durable(invalid); await restored.draft.submit(); await restored.draft.reconcile(); expect(restored.record.reject).toBe(true); expect(restored.api.command).not.toHaveBeenCalled(); }
  });
});

describe('link retrieval storage gate', () => {
  it('finishes the safe storage ticket before explicit recovery and never stores the returned link', async () => {
    const f = durable(); f.api.context.mockResolvedValue(withGrant()); await f.draft.refresh();
    let finished = false;
    vi.mocked(f.port.prepare).mockImplementationOnce(async payload => ({ finish: async outcome => { expect(outcome).toEqual(payload); finished = true; return true; } }));
    f.api.command.mockImplementationOnce(async () => {
      expect(finished).toBe(true);
      return { ...receipt(), kind: 'link', link: receipt().link } as never;
    });
    await f.draft.recover(withGrant().handoffs[0].id);
    expect(f.api.command).toHaveBeenCalledOnce(); expect(f.draft.shareUrl()).toContain('/handoff#token='); expect(JSON.stringify(f.draft.exportDraft())).not.toContain('token=');
  });
  it('disposal while gating finishes the captured record and never retrieves a link', async () => {
    const f = durable(); f.api.context.mockResolvedValue(withGrant()); await f.draft.refresh();
    const gate = deferred<Awaited<ReturnType<DraftPort['prepare']>>>(), finish = vi.fn(async () => true);
    vi.mocked(f.port.prepare).mockImplementationOnce(() => gate.promise);
    const recovery = f.draft.recover(withGrant().handoffs[0].id); f.draft.dispose(); gate.resolve({ finish }); await recovery;
    expect(finish).toHaveBeenCalledOnce(); expect(f.api.command).not.toHaveBeenCalled();
  });
});
