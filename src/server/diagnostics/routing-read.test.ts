import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RoutingDiagnostic } from '@/lib/diagnostics/routing';
import { parseRoutingDiagnostic, readRoutingDiagnostics, ROUTING_READ_LIMITS } from './routing-read';

const org = '00000000-0000-0000-0000-000000000001';
const session = '00000000-0000-0000-0000-000000000002';
const call = '00000000-0000-0000-0000-000000000003';
const at = '2026-10-03T13:45:29.000Z';
const snapshot: RoutingDiagnostic = {
  version: 1, at, kind: 'selection', step: 0, strategy: 'all', ringSecs: 20, startedAt: at, deadlineAt: '2026-10-03T13:45:54.000Z', reason: null,
  selectedCount: 1, skippedCount: 1, omittedMembers: 0, activeLegCount: 1, maxConcurrentLegs: 12, maxFanout: 8,
  members: [{ memberId: call, profileId: org, endpoint: 'sip', outcome: 'skipped', reason: 'device_stale', presence: 'available', registration: 'registering', heartbeatAgeMs: 500, openOffer: false }],
};
const query = { organizationId: org, callSessionId: session, since: '2026-10-03T13:00:00.000Z', until: '2026-10-03T14:00:00.000Z', budgetMs: 500 };
function fakeAdmin(rows: unknown[] = [{ routing: [snapshot] }]) {
  const calls = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: { id: call }, error: null }), abortSignal: vi.fn() };
  const events = { select: vi.fn(), eq: vi.fn(), gte: vi.fn(), lte: vi.fn(), not: vi.fn(), order: vi.fn(), limit: vi.fn(), abortSignal: vi.fn().mockResolvedValue({ data: rows, error: null }) };
  const profiles = { select: vi.fn(), eq: vi.fn(), in: vi.fn(), limit: vi.fn(), abortSignal: vi.fn().mockResolvedValue({ data: null, error: null }) };
  for (const builder of [calls, events, profiles]) for (const [key, method] of Object.entries(builder)) if (builder === calls ? key !== 'maybeSingle' : key !== 'abortSignal') method.mockReturnValue(builder);
  const from = vi.fn().mockImplementation(table => table === 'motorist_calls' ? calls : table === 'motorist_call_events' ? events : profiles);
  return { admin: { from } as unknown as Parameters<typeof readRoutingDiagnostics>[0], from, calls, events, profiles };
}
afterEach(() => vi.useRealTimers());

describe('routing audit evidence privacy', () => {
  it('projects only known values, stripping phone numbers, SIP credentials and provider payloads', () => {
    const parsed = parseRoutingDiagnostic({ ...snapshot, phone: '+421-canary', sipUri: 'sip:secret@example.test', raw_payload: { token: 'canary-secret' }, members: snapshot.members.map(member => ({ ...member, externalNumber: '+421-canary', sipUsername: 'canary-secret', metadata: { credential: 'canary-secret' } })) });
    expect(parsed).toEqual(snapshot);
    expect(JSON.stringify(parsed)).not.toMatch(/canary|sip:|raw_payload|credential/);
  });
  it('rejects untrusted strings in every field that could otherwise leak private data', () => {
    for (const override of [{ reason: '+421-canary' }, { at: '2026-02-30T13:45:29.000Z' }, { version: 2 }, { strategy: 'sip:secret' }, { members: [{ ...snapshot.members[0], memberId: '+421-canary' }] }, { members: [{ ...snapshot.members[0], profileId: 'sip:secret' }] }, { members: [{ ...snapshot.members[0], reason: 'canary-secret' }] }, { members: [{ ...snapshot.members[0], registration: 'canary-secret' }] }, { members: [{ ...snapshot.members[0], presence: 'canary-secret' }] }]) expect(parseRoutingDiagnostic({ ...snapshot, ...override })).toBeNull();
    expect(parseRoutingDiagnostic({ ...snapshot, members: Array(65).fill(snapshot.members[0]) })).toBeNull();
    expect(parseRoutingDiagnostic({ ...snapshot, kind: 'completed', reason: 'no_eligible_members' })).not.toBeNull();
  });
});

describe('bounded tenant-scoped routing audit reads', () => {
  it('requires organization and session in both indexed call lookup and exact audit read', async () => {
    const f = fakeAdmin();
    expect(await readRoutingDiagnostics(f.admin, query)).toEqual({ routing: [snapshot], routingUnavailable: false, routingTruncated: false });
    expect(f.calls.eq.mock.calls).toEqual([['organization_id', org], ['session_id', session]]);
    expect(f.events.eq.mock.calls).toEqual([['organization_id', org], ['call_id', call], ['normalized_payload->>session_id', session]]);
    expect(f.events.select).toHaveBeenCalledWith('routing:normalized_payload->routing');
    expect(f.events.gte).toHaveBeenCalledWith('received_at', query.since);
    expect(f.events.lte).toHaveBeenCalledWith('received_at', query.until);
    expect(f.events.limit).toHaveBeenCalledWith(101);
    expect(f.events.order.mock.calls).toEqual([['created_at', { ascending: true }], ['id', { ascending: true }]]);
  });
  it('never reads unlinked call audit and keeps absence distinct from unavailability', async () => {
    const missing = fakeAdmin();
    missing.calls.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect((await readRoutingDiagnostics(missing.admin, query)).routingUnavailable).toBe(true);
    expect(missing.events.select).not.toHaveBeenCalled();
    const empty = fakeAdmin([]);
    expect(await readRoutingDiagnostics(empty.admin, query)).toEqual({ routing: [], routingTruncated: false, routingUnavailable: false });
    const failed = fakeAdmin();
    failed.events.abortSignal.mockRejectedValue(new Error('private provider error'));
    expect(await readRoutingDiagnostics(failed.admin, query)).toEqual({ routing: [], routingTruncated: false, routingUnavailable: true });
  });
  it('looks up only involved operator names in the same organization', async () => {
    const f = fakeAdmin();
    f.profiles.abortSignal.mockResolvedValue({ data: [{ id: org, display_name: 'Mário Šalásek' }, { id: session, display_name: 'Foreign canary' }], error: null });
    const result = await readRoutingDiagnostics(f.admin, query);
    expect(f.profiles.select).toHaveBeenCalledWith('id,display_name');
    expect(f.profiles.eq.mock.calls).toEqual([['organization_id', org]]);
    expect(f.profiles.in).toHaveBeenCalledWith('id', [org]);
    expect(f.profiles.limit).toHaveBeenCalledWith(128);
    expect(result.routingProfiles).toEqual({ [org]: 'Mário Šalásek' });
  });
  it('bounds snapshot count and response bytes, and reports dropped evidence', async () => {
    const many = fakeAdmin(Array.from({ length: 101 }, () => ({ routing: [snapshot] })));
    const result = await readRoutingDiagnostics(many.admin, query);
    expect(result.routing.length).toBe(ROUTING_READ_LIMITS.snapshots);
    expect(result.routingTruncated).toBe(true);
    const large = fakeAdmin(Array.from({ length: 40 }, () => ({ routing: [{ ...snapshot, members: Array(64).fill(snapshot.members[0]) }] })));
    const limited = await readRoutingDiagnostics(large.admin, query);
    expect(limited.routing.length).toBeGreaterThan(0);
    expect(limited.routing.length).toBeLessThan(40);
    expect(new TextEncoder().encode(JSON.stringify(limited.routing)).length).toBeLessThanOrEqual(ROUTING_READ_LIMITS.bytes);
    expect(limited.routingTruncated).toBe(true);
    const malformed = fakeAdmin([{ routing: [{ ...snapshot, reason: '+421-canary' }, snapshot] }]);
    expect(await readRoutingDiagnostics(malformed.admin, query)).toEqual({ routing: [snapshot], routingTruncated: true, routingUnavailable: false });
  });
  it('aborts a stalled audit within the optional budget so the existing timeline can return', async () => {
    vi.useFakeTimers();
    const f = fakeAdmin();
    f.calls.maybeSingle.mockImplementation(() => new Promise(() => undefined));
    const pending = readRoutingDiagnostics(f.admin, { ...query, budgetMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).routingUnavailable).toBe(true);
    expect(f.calls.abortSignal.mock.calls[0][0].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.events.select).not.toHaveBeenCalled();
    const late = fakeAdmin();
    expect((await readRoutingDiagnostics(late.admin, { ...query, budgetMs: 0 })).routingUnavailable).toBe(true);
    expect(late.from).not.toHaveBeenCalled();
  });
  it('retains routing decisions when the optional display-name lookup exceeds the shared budget', async () => {
    vi.useFakeTimers();
    const f = fakeAdmin();
    f.profiles.abortSignal.mockImplementation(() => new Promise(() => undefined));
    const pending = readRoutingDiagnostics(f.admin, { ...query, budgetMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({ routing: [snapshot], routingUnavailable: false, routingTruncated: false });
    expect(f.profiles.abortSignal.mock.calls[0][0].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
