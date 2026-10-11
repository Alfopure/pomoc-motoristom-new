import { describe, expect, it, vi } from 'vitest';
import { createHandoffApi, parseSnapshot } from './api';
import { caseId, commandId, context, origin, receipt, scope, withGrant } from './fixtures';
const config = {
  environment: 'test' as const, apiOrigin: origin, supabaseUrl: 'https://nzpnqdstvkfncflgqlny.supabase.co', publishableKey: 'unused'
};
const command = {
  action: 'issue' as const, commandId, recipientName: 'MOCK', recipientPhone: '+421900000000', previewVersion: 'a'.repeat(64)
};
function api(value: unknown) {
  const transport = vi.fn(async () => new Response(JSON.stringify(value)));
  return { transport, api: createHandoffApi(config, scope.profileId, async () => 'MOCK-token', transport) };
}
describe('handoff API trust boundary', () => {
  it('accepts complete V3 preserving false/zero and legacy snapshot', () => {
    expect(parseSnapshot(context().preview)).toEqual(context().preview);
    const legacy = {
      caseNumber: '42', action: 'Odťah', contact: { name: '', phone: '' }, vehicle: { make: '', model: '', plate: '' }, pickup: null, destination: null
    };
    expect(parseSnapshot(legacy)).toEqual(legacy);
  });
  it.each([{ ...context().preview, schemaVersion: 4 }, { ...context().preview, secret: 'hidden' }, { ...context().preview, vehicle: { ...context().preview.vehicle, hidden: true } }, { ...context().preview, incident: { ...context().preview.incident, passengersCount: -1 } }])('rejects unseen/invalid snapshot fields', value => expect(() => parseSnapshot(value)).toThrow());
  it('preserves independent nullable coordinates from SQL', () => {
    const value = { ...context().preview, pickup: { address: 'Miesto', lat: 0, lng: null } };
    expect(parseSnapshot(value).pickup).toEqual(value.pickup);
  });
  it('validates account/case and grant identities', async () => {
    await expect(api({ ...context(), profileId: 'other' }).api.context(caseId)).rejects.toThrow();
    await expect(api({ ...context(), caseId: 'other' }).api.context(caseId)).rejects.toThrow();
    const duplicate = withGrant();
    duplicate.handoffs.push(duplicate.handoffs[0]);
    await expect(api(duplicate).api.context(caseId)).rejects.toThrow();
  });
  it('sends scoped immutable command once without cookies', async () => {
    const a = api(receipt());
    await a.api.command(caseId, command);
    expect(a.transport).toHaveBeenCalledTimes(1);
    const [, request] = a.transport.mock.calls[0] as unknown as [
      string,
      RequestInit
    ];
    expect(request.credentials).toBe('omit');
    expect(JSON.parse(request.body as string)).toEqual(command);
  });
  it.each(['https://evil.test/handoff#token=', origin + '/other#token=', origin + '/handoff?x=1#token='])('retains commit when URL is untrusted', async (url) => {
    const value = receipt();
    value.link = { ...value.link as Extract<typeof value.link, {
        status: 'available';
      }>, url: url + 'a'.repeat(43) };
    expect((await api(value).api.command(caseId, command)).link.status).toBe('unavailable');
  });
  it('retains commit on malformed link metadata but rejects malformed receipt', async () => {
    expect((await api({ ...receipt(), link: {
        status: 'available', url: origin + '/handoff#token=' + 'a'.repeat(43), expiresAt: 'bad', currentRevision: 1
      } }).api.command(caseId, command)).link.status).toBe('unavailable');
    await expect(api({ ...receipt(), committedRevision: 2 }).api.command(caseId, command)).rejects.toThrow();
  });
  it('recovery is distinct and must validate its link', async () => {
    const result = { ...receipt(), kind: 'link', link: { status: 'unavailable' } };
    await expect(api(result).api.command(caseId, {
      action: 'recover', commandId, handoffId: receipt().handoffId, expectedRevision: 1
    })).rejects.toThrow();
  });
});
describe('handoff timestamp and receipt metadata', () => {
  it.each(['2026', '1', '2026-02-30T10:00:00Z', '2026-10-11'])('rejects loose or impossible timestamp %s', value => {
    expect(() => parseSnapshot({ ...context().preview, caseCreatedAt: value })).toThrow();
  });
  it('accepts PostgreSQL microseconds without reducing precision', () => {
    const value = { ...context().preview, caseCreatedAt: '2026-10-11T23:00:00.123456+00:00' };
    expect(parseSnapshot(value).caseCreatedAt).toBe(value.caseCreatedAt);
  });
  it('binds URL to newer observed revision and degrades expired URL without losing commit', async () => {
    const value = receipt();
    value.link = { ...value.link as Extract<typeof value.link, {
        status: 'available';
      }>, currentRevision: 3 };
    expect((await api(value).api.command(caseId, command)).link).toMatchObject({ currentRevision: 3 });
    value.link = { ...value.link, expiresAt: '2000-01-01T00:00:00Z' };
    expect((await api(value).api.command(caseId, command)).link.status).toBe('unavailable');
  });
});
describe('action-specific link availability', () => {
  it('never exposes a URL from a revoke receipt', async () => {
    const value = {
      ...receipt(), action: 'revoke', committedRevision: 2, currentRevision: 2, link: { ...receipt().link as object, currentRevision: 2 }
    };
    const result = await api(value).api.command(caseId, {
      action: 'revoke', commandId, handoffId: receipt().handoffId, expectedRevision: 1, comment: 'Dôvod'
    });
    expect(result.link).toEqual({ status: 'not_requested' });
  });
  it('an issue without expected link metadata remains saved with unavailable warning', async () => {
    expect((await api({ ...receipt(), link: { status: 'not_requested' } }).api.command(caseId, command)).link).toEqual({ status: 'unavailable', warning: 'link_unavailable' });
  });
});
