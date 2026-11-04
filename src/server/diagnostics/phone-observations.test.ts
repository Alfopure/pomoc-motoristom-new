import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ after: vi.fn(), from: vi.fn(), select: vi.fn(), eq: vi.fn(), in: vi.fn(), gte: vi.fn(), lte: vi.fn(), limit: vi.fn(), read: vi.fn(), capture: vi.fn() }));
vi.mock('next/server', () => ({ after: f.after }));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: () => ({ from: f.from }) }));
vi.mock('./server-errors', () => ({ captureServerError: f.capture }));
import { deferAcceptedPhoneFailures, isFreshPhoneFailure } from './phone-observations';
import type { DiagnosticEvent } from '@/lib/diagnostics/types';
const now = Date.parse('2026-11-04T18:00:00.000Z');
const id = '11111111-1111-4111-8111-111111111111';
const device = '22222222-2222-4222-8222-222222222222';
const actor = { organizationId: '33333333-3333-4333-8333-333333333333', profileId: '44444444-4444-4444-8444-444444444444' };
const event: DiagnosticEvent = { id, pageId: id, sequence: 1, occurredAt: new Date(now).toISOString(), monotonicMs: 0, type: 'phone_lifecycle', module: 'telephony', outcome: 'failed', buildId: 'browser_release', sampled: false, sampleRate: 1, deviceSessionId: device, reason: 'recovery_timeout', phoneFailure: 'recovery_timeout', rtcEdge: 'eu' };
const row = () => ({ id, event, device_session_id: device, received_at: new Date(now).toISOString() });
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(now); vi.stubEnv('DIAGNOSTICS_SERVER_ERRORS_ENABLED', 'true');
  const query = { select: f.select, eq: f.eq, in: f.in, gte: f.gte, lte: f.lte, limit: f.limit, abortSignal: f.read };
  for (const fn of [f.from, f.select, f.eq, f.in, f.gte, f.lte, f.limit]) fn.mockReturnValue(query);
  f.read.mockResolvedValue({ data: [row()], error: null }); f.capture.mockResolvedValue({ accepted: true });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
describe('durable phone observations', () => {
  it('defers all database/transport work and reads exact accepted actor/source/environment rows', async () => {
    deferAcceptedPhoneFailures(actor, [event], [id], 'test');
    expect(f.after).toHaveBeenCalledOnce(); expect(f.from).not.toHaveBeenCalled(); expect(f.capture).not.toHaveBeenCalled();
    await f.after.mock.calls[0][0]();
    expect(f.from).toHaveBeenCalledWith('motorist_diagnostic_events');
    expect(f.eq.mock.calls).toEqual([['organization_id', actor.organizationId], ['profile_id', actor.profileId], ['environment', 'test'], ['source', 'browser']]);
    expect(f.in).toHaveBeenCalledWith('id', [id]);
    expect(f.capture).toHaveBeenCalledWith(expect.objectContaining({ name: 'PhoneLifecycleObservation', code: 'browser_phone_failure' }), {
      source: 'phone_observation', route: 'diagnostics.phone-observation', observationEventId: id, deviceSessionId: device,
      phoneFailure: 'recovery_timeout', phoneReason: 'recovery_timeout', sdkCode: undefined, rtcEdge: 'eu', browserBuild: 'browser_release',
    });
  });
  it('never schedules rejected, unbound, old, future or nonterminal observations', () => {
    deferAcceptedPhoneFailures(actor, [event], [], 'test');
    for (const extra of [{ occurredAt: new Date(now - 120_001).toISOString() }, { occurredAt: new Date(now + 1).toISOString() }, { deviceSessionId: undefined }, { outcome: 'ok' as const }, { reason: 'unregistered' as const }]) {
      const changed = { ...event, ...extra };
      expect(isFreshPhoneFailure(changed, now)).toBe(false);
      deferAcceptedPhoneFailures(actor, [changed], [id], 'test');
    }
    expect(f.after).not.toHaveBeenCalled();
  });
  it('uses the original stored evidence on a retry instead of modified submitted values', async () => {
    deferAcceptedPhoneFailures(actor, [{ ...event, rtcEdge: 'default', buildId: 'changed_retry' }], [id], 'production');
    await f.after.mock.calls[0][0]();
    expect(f.capture.mock.calls[0][1]).toMatchObject({ rtcEdge: 'eu', browserBuild: 'browser_release' });
  });
  it('requires the retained canonical device link and revalidates event privacy/freshness', async () => {
    const cases = [
      { ...row(), device_session_id: null, event: { ...event, deviceSessionId: undefined } },
      { ...row(), device_session_id: actor.profileId },
      { ...row(), event: { ...event, token: 'PRIVATE' } },
      { ...row(), event: { ...event, outcome: 'ok' } },
      { ...row(), received_at: new Date(now - 120_001).toISOString() },
      { ...row(), received_at: new Date(now + 1).toISOString() },
      { ...row(), id: actor.profileId },
    ];
    for (const stored of cases) {
      f.read.mockResolvedValueOnce({ data: [stored], error: null });
      deferAcceptedPhoneFailures(actor, [event], [id], 'test');
      await f.after.mock.calls.at(-1)![0]();
    }
    expect(f.capture).not.toHaveBeenCalled();
  });
  it('absorbs read/scheduling errors and expires before reporting a delayed callback', async () => {
    f.read.mockRejectedValueOnce(new Error('PRIVATE SQL'));
    deferAcceptedPhoneFailures(actor, [event], [id], 'test');
    await expect(f.after.mock.calls[0][0]()).resolves.toBeUndefined();
    deferAcceptedPhoneFailures(actor, [event], [id], 'test'); vi.setSystemTime(now + 120_001);
    await f.after.mock.calls[1][0]();
    expect(f.capture).not.toHaveBeenCalled();
    vi.setSystemTime(now); f.after.mockImplementationOnce(() => { throw new Error('outside lifecycle'); });
    expect(() => deferAcceptedPhoneFailures(actor, [event], [id], 'test')).not.toThrow();
    vi.stubEnv('DIAGNOSTICS_SERVER_ERRORS_ENABLED', 'false');
    deferAcceptedPhoneFailures(actor, [event], [id], 'test'); expect(f.after).toHaveBeenCalledTimes(3);
  });
});
