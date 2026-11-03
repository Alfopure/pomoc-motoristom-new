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
    expect((await api(value).api.command(caseId, command) as { link: Record<string, unknown> }).link.status).toBe('unavailable');
  });
  it('retains commit on malformed link metadata but rejects malformed receipt', async () => {
    expect((await api({ ...receipt(), link: {
        status: 'available', url: origin + '/handoff#token=' + 'a'.repeat(43), expiresAt: 'bad', currentRevision: 1
      } }).api.command(caseId, command) as { link: Record<string, unknown> }).link.status).toBe('unavailable');
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
    expect((await api(value).api.command(caseId, command) as { link: Record<string, unknown> }).link).toMatchObject({ currentRevision: 3 });
    value.link = { ...value.link, expiresAt: '2000-01-01T00:00:00Z' };
    expect((await api(value).api.command(caseId, command) as { link: Record<string, unknown> }).link.status).toBe('unavailable');
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
    expect('link' in result && result.link).toEqual({ status: 'not_requested' });
  });
  it('an issue without expected link metadata remains saved with unavailable warning', async () => {
    const result = await api({ ...receipt(), link: { status: 'not_requested' } }).api.command(caseId, command);
    expect('link' in result && result.link).toEqual({ status: 'unavailable', warning: 'link_unavailable' });
  });
});

describe('draft organization request fence', () => {
  it('binds context and explicit commands to the expected organization', async () => {
    const transport = vi.fn(async () => Response.json({ error: 'scope' }, { status: 409 }));
    const client = createHandoffApi(config, scope.profileId, async () => 'MOCK', transport, caseId);
    await expect(client.context(caseId)).rejects.toMatchObject({ status: 409 });
    await expect(client.command(caseId, command)).rejects.toMatchObject({ status: 409 });
    for (const [, init] of transport.mock.calls as unknown as [string, RequestInit][]) expect(init.headers).toMatchObject({ 'X-PM-Expected-Organization': caseId });
  });
});

describe('pristavovač in the app', () => {
  const member = { id: '77777777-7777-4777-8777-777777777777', displayName: 'MOCK Pristavovač', lastPhone: '+421900000002' };
  const position = { lat: 49.2, lng: 18.7, accuracy: 12, recordedAt: '2026-10-22T10:00:00Z' };
  it('reads who can receive in the app and where an assigned one is', async () => {
    const value = withGrant();
    const raw = { ...value, delivery: { members: [{ ...member, id: member.id.toUpperCase() }] }, handoffs: [{ ...value.handoffs[0], app: { memberId: member.id, lastPosition: position } }] };
    const result = await api(raw).api.context(caseId);
    expect(result.delivery).toEqual({ members: [member] });
    expect(result.handoffs[0].app).toEqual({ memberId: member.id, lastPosition: position });
    expect((await api(withGrant()).api.context(caseId)).handoffs[0].app).toBeNull();
  });
  it('hides a malformed member list instead of failing the handoff', async () => {
    for (const delivery of [{ members: [{ ...member, id: 'x' }] }, { members: 'all' }, []]) {
      const result = await api({ ...context(), delivery }).api.context(caseId);
      expect(result.delivery).toBeUndefined();
    }
  });
  it('rejects a malformed position of a pristavovač', async () => {
    const value = withGrant();
    for (const lastPosition of [{ ...position, lat: 95 }, { ...position, accuracy: -1 }, { ...position, recordedAt: 'now' }]) {
      await expect(api({ ...value, handoffs: [{ ...value.handoffs[0], app: { memberId: member.id, lastPosition } }] }).api.context(caseId)).rejects.toThrow();
    }
  });
  it('confirms sending an existing handoff to the chosen pristavovač', async () => {
    const input = { action: 'deliver' as const, commandId, handoffId: receipt().handoffId, expectedRevision: 1, recipientMemberId: member.id };
    const answer = { ...scope, kind: 'delivery', caseId, handoffId: input.handoffId, commandId, memberId: member.id, sent: true, currentRevision: 1 };
    expect(await api(answer).api.command(caseId, input)).toMatchObject({ kind: 'delivery', memberId: member.id, sent: true });
    await expect(api({ ...answer, memberId: '88888888-8888-4888-8888-888888888888' }).api.command(caseId, input)).rejects.toThrow();
    await expect(api({ ...answer, kind: 'mutation' }).api.command(caseId, input)).rejects.toThrow();
  });
  it('reports a failed send beside the confirmed handoff, never instead of it', async () => {
    const issue = { ...command, recipientMemberId: member.id };
    expect(await api({ ...receipt(), delivery: { status: 'sent', memberId: member.id } }).api.command(caseId, issue)).toMatchObject({ kind: 'mutation', delivery: { status: 'sent', memberId: member.id } });
    expect(await api({ ...receipt(), delivery: { status: 'sent', memberId: 'other' } }).api.command(caseId, issue)).toMatchObject({ kind: 'mutation', delivery: { status: 'failed', memberId: member.id } });
    expect(await api(receipt()).api.command(caseId, issue)).toMatchObject({ kind: 'mutation', delivery: { status: 'failed' } });
    expect(await api({ ...receipt(), delivery: { status: 'sent', memberId: member.id } }).api.command(caseId, command)).not.toHaveProperty('delivery');
  });
});
