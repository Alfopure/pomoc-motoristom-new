import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from '@/test/fake-supabase';
import { MutationError } from '@/server/mutation-error';
const f = vi.hoisted(() => ({ auth: vi.fn(), admin: vi.fn() }));
vi.mock('@/server/api-auth', () => ({ requireDefaultMotoristActor: f.auth }));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: f.admin }));
import { loadDiagnosticPhoneStatus, PHONE_STATUS_LIMIT, readDiagnosticPhoneStatus } from './phone-status';
import { TEST_APP_ORIGIN, TEST_VERCEL_PROJECT_ID } from '@/lib/app-environment';

const NOW = new Date('2026-11-04T10:00:00.000Z');
const old = '2026-11-04T09:00:00.000Z';
const row = { id: 'id', organization_id: 'org', profile_id: 'profile', environment: 'production', registration_state: 'registered', device_seen_at: NOW.toISOString(), device_session_id: 'device-secret', telnyx_credential_id: 'credential-secret', sip_username: 'sip-secret', credential_expires_at: null, metadata: { private: 'private-secret' } };
beforeEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); vi.stubEnv('MOTORIST_APP_ENV', 'production'); f.auth.mockResolvedValue({ organizationId: 'org' }); });

describe('phone status inventory', () => {
  it('separates fresh failures, old records and unknown/future heartbeats without exposing device data', async () => {
    const fake = createFakeSupabase();
    fake.db.seed('motorist_operator_devices', [
      row, { ...row, id: 'error', registration_state: 'error' }, { ...row, id: 'stale-error', registration_state: 'error', device_seen_at: old },
      { ...row, id: 'registering', registration_state: 'registering' }, { ...row, id: 'unregistered', registration_state: 'unregistered' },
      { ...row, id: 'unknown', registration_state: null }, { ...row, id: 'missing-credentials', sip_username: null },
      { ...row, id: 'future', device_seen_at: '2099-01-01T00:00:00Z' }, { ...row, id: 'missing', device_seen_at: null },
      { ...row, id: 'expired', credential_expires_at: old }, { ...row, id: 'other-org', organization_id: 'foreign' },
      { ...row, id: 'other-env', environment: 'development' },
    ].map(device => ({ ...device, profile_id: device.id })));
    const status = await loadDiagnosticPhoneStatus(fake.admin, 'org', () => NOW);
    expect(status.browser).toEqual({ source: 'available', total: 10, ready: 1, pushReachable: 0, error: 1, registering: 1, unregistered: 1, stale: 1, unknown: 5, lastSeenAt: NOW.toISOString(), truncated: false });
    expect(status.mobile.total).toBe(0);
    expect(status.environment).toBe('production');
    const json = JSON.stringify(status);
    for (const privateValue of ['secret', 'profile', 'organization_id', 'metadata']) expect(json).not.toContain(privateValue);
    expect(fake.db.log.every(query => query.filters?.includes('eq(organization_id)') && query.filters?.includes('eq(environment)'))).toBe(true);
  });

  it('uses dedicated TEST telephony records and the existing bounded push lease rules', async () => {
    vi.stubEnv('MOTORIST_APP_ENV', 'test'); vi.stubEnv('VERCEL_ENV', 'production'); vi.stubEnv('VERCEL_GIT_COMMIT_REF', 'dev');
    vi.stubEnv('VERCEL_PROJECT_ID', TEST_VERCEL_PROJECT_ID); vi.stubEnv('APP_BASE_URL', TEST_APP_ORIGIN);
    vi.stubEnv('MOTORIST_NATIVE_VOICE_TEST_ENABLED', 'true'); vi.stubEnv('MOTORIST_NATIVE_VOIP_PUSH_TEST_ENABLED', 'true');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://nzpnqdstvkfncflgqlny.supabase.co'); vi.stubEnv('MOTORIST_TEST_LIVE_INTEGRATIONS', 'true');
    const fake = createFakeSupabase();
    const mobile = { ...row, environment: 'development', device_seen_at: old, metadata: { native_voip: { v: 1, platform: 'ios', deviceSessionId: row.device_session_id, until: '2026-11-05T10:00:00.000Z' } } };
    fake.db.seed('motorist_operator_mobile_devices', [mobile, { ...mobile, id: 'foreign-lease', metadata: { native_voip: { ...mobile.metadata.native_voip, deviceSessionId: 'wrong' } } }, { ...mobile, id: 'production', environment: 'production' }].map(device => ({ ...device, profile_id: device.id })));
    const status = await loadDiagnosticPhoneStatus(fake.admin, 'org', () => NOW);
    expect(status.environment).toBe('test');
    expect(status.mobile).toMatchObject({ total: 2, pushReachable: 1, ready: 0, stale: 1 });
    vi.stubEnv('MOTORIST_NATIVE_VOIP_PUSH_TEST_ENABLED', 'false');
    expect((await loadDiagnosticPhoneStatus(fake.admin, 'org', () => NOW)).mobile).toMatchObject({ pushReachable: 0, stale: 2 });
  });

  it('preserves source failures and truncation instead of presenting incomplete zeroes as healthy', async () => {
    const fake = createFakeSupabase();
    fake.db.seed('motorist_operator_devices', Array.from({ length: PHONE_STATUS_LIMIT + 2 }, (_, i) => ({ ...row, id: String(i), profile_id: String(i) })));
    fake.db.failNext('motorist_operator_mobile_devices', 'select', 'private database error');
    const status = await loadDiagnosticPhoneStatus(fake.admin, 'org', () => NOW);
    expect(status.browser).toMatchObject({ total: PHONE_STATUS_LIMIT, ready: PHONE_STATUS_LIMIT, truncated: true });
    expect(status.mobile).toMatchObject({ source: 'unavailable', total: 0 });
    expect(JSON.stringify(status)).not.toContain('private database error');
  });

  it('bounds both queries with the same abort signal and a sentinel row limit', async () => {
    const abortSignals: AbortSignal[] = [], limits: number[] = [];
    const query = { select() { return this; }, eq() { return this; }, order() { return this; }, limit(value: number) { limits.push(value); return this; }, abortSignal(signal: AbortSignal) { abortSignals.push(signal); return Promise.resolve({ data: [], error: null }); } };
    await loadDiagnosticPhoneStatus({ from: () => query } as unknown as Parameters<typeof loadDiagnosticPhoneStatus>[0], 'org', () => NOW);
    expect(limits).toEqual([PHONE_STATUS_LIMIT + 1, PHONE_STATUS_LIMIT + 1]);
    expect(abortSignals).toHaveLength(2); expect(abortSignals[0]).toBe(abortSignals[1]); expect(abortSignals[0]).toBeInstanceOf(AbortSignal);
  });
});

describe('phone status access', () => {
  it('requires manager/admin before accessing the organization-scoped source and disables caching', async () => {
    const fake = createFakeSupabase(); f.admin.mockReturnValue(fake.admin);
    const response = await readDiagnosticPhoneStatus();
    expect(f.auth).toHaveBeenCalledWith(['manager', 'admin']);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
  it('denies unauthorized reads and honors the panel switch before obtaining an admin client', async () => {
    f.auth.mockRejectedValue(new MutationError('Prístup zamietnutý.', 403));
    expect((await readDiagnosticPhoneStatus()).status).toBe(403); expect(f.admin).not.toHaveBeenCalled();
    f.auth.mockResolvedValue({ organizationId: 'org' }); vi.stubEnv('DIAGNOSTICS_PANEL_ENABLED', 'false');
    expect((await readDiagnosticPhoneStatus()).status).toBe(503); expect(f.admin).not.toHaveBeenCalled();
  });
});
