import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTelephonyHarness, NUMBERS, ORG, PROFILES } from '@/test/telephony-harness';
import type { TelephonyRuntimeDeps } from '@/server/telephony/runtime';
import { completeCallAnnouncements } from '@/test/complete-call-announcements';
import { listNativeTransferTargets, readNativeRecordingInput, readNativeTransferInput, stopNativeRecording, transferNativeCall } from './voice-call-actions';
import { changeNativeHold, readNativeCallStatus } from './voice-hold';
import { nativeHandedAway, requireNativeSession } from './voice';

const actor = { userId: PROFILES.o1, profileId: PROFILES.o1, organizationId: ORG, displayName: 'Test', role: 'dispatcher' as const };
const lease = '00000000-0000-4000-8000-000000000071';
beforeEach(() => {
  for (const [k, v] of Object.entries({ MOTORIST_APP_ENV: 'test', VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'dev', VERCEL_PROJECT_ID: 'prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk',
    SUPABASE_URL: 'https://nzpnqdstvkfncflgqlny.supabase.co', APP_BASE_URL: 'https://test.dispecing.linkapomoci.sk', MOTORIST_NATIVE_VOICE_TEST_ENABLED: 'true',
    TELEPHONY_STABILITY_V1_ENABLED: 'true', TELNYX_CALL_ACTION_ANNOUNCEMENTS_ENABLED: 'false' })) vi.stubEnv(k, v);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

/** An inbound call answered on this operator's mobile endpoint only. */
async function fixture(options: { recording?: boolean; answered?: boolean } = {}) {
  // Recording uses the same harness setup as the web recording lifecycle tests.
  if (options.recording) for (const key of ['TELNYX_RECORDING_ENABLED', 'TELNYX_RECORDING_CONTRACT_VERIFIED', 'RECORDING_PROCESSING_ENABLED']) vi.stubEnv(key, 'true');
  const h = options.recording ? createTelephonyHarness() : createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  if (options.recording) h.db.insert('motorist_call_recording_policies', { organization_id: ORG, revision: 1, recording_enabled: true, approved_at: h.now().toISOString(), inbound_enabled: true, outbound_enabled: true, max_segment_seconds: 1800 });
  const call = await h.inbound({ to: NUMBERS.allianz });
  if (options.recording) await completeCallAnnouncements(h, call.sessionId);
  const control = String(h.legFor(call.sessionId, actor.profileId)!.telnyx_call_control_id);
  if (options.answered !== false) {
    h.telnyx.physical.answered(control); await h.legEvent(control, 'call.answered');
    for (const leg of h.legs(call.sessionId)) if (leg.role !== 'customer' && leg.profile_id !== actor.profileId && !leg.ended_at) await h.legEvent(String(leg.telnyx_call_control_id), 'call.hangup');
  }
  const web = h.rows('motorist_operator_devices').find(x => x.profile_id === actor.profileId)!;
  h.db.seed('motorist_operator_mobile_devices', [{ ...web, sip_username: 'native-transfer', device_session_id: lease, registration_state: 'registered', metadata: {} }]);
  h.db.update('motorist_call_legs', { to_number: 'sip:native-transfer@sip.telnyx.com' }, x => x.telnyx_call_control_id === control);
  if (options.recording) await completeCallAnnouncements(h, call.sessionId);
  const deps = { ...h.deps, deviceKind: 'mobile' } as TelephonyRuntimeDeps;
  return { h, deps, id: call.sessionId, control };
}

describe('native transfer and recording input', () => {
  it('accepts only the device lease and a colleague', () => {
    expect(readNativeTransferInput({ deviceSessionId: lease, profileId: PROFILES.o2.toUpperCase() })).toEqual({ deviceSessionId: lease, profileId: PROFILES.o2.toLowerCase() });
    for (const bad of [null, [], {}, { deviceSessionId: lease }, { deviceSessionId: 'x', profileId: PROFILES.o2 }, { deviceSessionId: lease, profileId: PROFILES.o2, number: '+421900000000' }]) {
      expect(() => readNativeTransferInput(bad)).toThrow();
    }
  });
  it('accepts a stop and an explicit retry only', () => {
    expect(readNativeRecordingInput({ deviceSessionId: lease })).toEqual({ deviceSessionId: lease, retry: false });
    expect(readNativeRecordingInput({ deviceSessionId: lease, retry: true })).toEqual({ deviceSessionId: lease, retry: true });
    for (const bad of [{ deviceSessionId: lease, retry: 'yes' }, { deviceSessionId: lease, action: 'start' }, { retry: true }]) expect(() => readNativeRecordingInput(bad)).toThrow();
  });
});

describe('native transfer', () => {
  it('lists colleagues without the caller and with sanitized names', async () => {
    const f = await fixture();
    f.h.db.update('motorist_profiles', { display_name: 'Peter\u0007 Kolega' }, row => row.id === PROFILES.o2);
    const { targets } = await listNativeTransferTargets(f.deps, actor, f.id, { deviceSessionId: lease });
    await expect(listNativeTransferTargets(f.deps, actor, f.id, { deviceSessionId: '00000000-0000-4000-8000-000000000072' })).rejects.toMatchObject({ status: 409 });
    expect(targets.some(target => target.profileId === actor.profileId)).toBe(false);
    expect(targets.find(target => target.profileId === PROFILES.o2)).toMatchObject({ displayName: 'Peter Kolega', label: expect.any(String) });
    // The web's badge, not a raw presence code.
    expect(targets.every(target => target.label.length > 0 && !['available', 'on_call', 'after_call_work'].includes(target.label))).toBe(true);
  });
  it('transfers the connected call through the shared web action', async () => {
    const f = await fixture();
    const result = await transferNativeCall(f.deps, actor, f.id, { deviceSessionId: lease, profileId: PROFILES.o2 });
    expect(result.sessionId).toBe(f.id);
    expect(f.h.rows('motorist_audit_log').map(row => row.action)).toContain('telephony.call.blind_transfer');
  });
  it('refuses a ringing call, the caller itself and a stale lease', async () => {
    const ringing = await fixture({ answered: false });
    await expect(transferNativeCall(ringing.deps, actor, ringing.id, { deviceSessionId: lease, profileId: PROFILES.o2 })).rejects.toMatchObject({ status: expect.any(Number) });
    const f = await fixture();
    await expect(transferNativeCall(f.deps, actor, f.id, { deviceSessionId: lease, profileId: actor.profileId })).rejects.toMatchObject({ status: 400 });
    await expect(transferNativeCall(f.deps, actor, f.id, { deviceSessionId: '00000000-0000-4000-8000-000000000072', profileId: PROFILES.o2 })).rejects.toMatchObject({ status: 409 });
    expect(f.h.rows('motorist_audit_log').map(row => row.action)).not.toContain('telephony.call.blind_transfer');
  });
  it('leaves nothing for this phone to end once the call was handed away', async () => {
    const f = await fixture();
    expect(await nativeHandedAway(f.deps, actor, f.id)).toBe(false);
    await transferNativeCall(f.deps, actor, f.id, { deviceSessionId: lease, profileId: PROFILES.o2 });
    if (!f.h.legFor(f.id, actor.profileId)?.ended_at) await f.h.legEvent(f.control, 'call.hangup');
    await expect(requireNativeSession(f.deps, actor, f.id)).rejects.toMatchObject({ status: 403 });
    expect(await nativeHandedAway(f.deps, actor, f.id)).toBe(true);
    expect(await nativeHandedAway(f.deps, { ...actor, profileId: PROFILES.o3, userId: PROFILES.o3 }, f.id)).toBe(false);
    // A late hold from this phone is a plain refusal, not lost ownership that would disconnect it.
    await expect(changeNativeHold(f.deps, actor, f.id, { deviceSessionId: lease, callControlId: f.control, requestId: '00000000-0000-4000-8000-000000000073', held: true, expectedVersion: 1 }))
      .rejects.toMatchObject({ status: 409, code: 'native_handed_away' });
  });
  it('tells the phone whether a call is between colleagues', async () => {
    const f = await fixture();
    expect((await readNativeCallStatus(f.deps, actor, f.id, lease)).internal).toBe(false);
    f.h.db.update('motorist_call_sessions', { direction: 'internal' }, row => row.id === f.id);
    expect((await readNativeCallStatus(f.deps, actor, f.id, lease)).internal).toBe(true);
  });
  it('never transfers a call between colleagues', async () => {
    const f = await fixture();
    f.h.db.update('motorist_call_sessions', { direction: 'internal' }, row => row.id === f.id);
    await expect(listNativeTransferTargets(f.deps, actor, f.id, { deviceSessionId: lease })).rejects.toMatchObject({ status: 409, code: 'internal_call' });
    await expect(transferNativeCall(f.deps, actor, f.id, { deviceSessionId: lease, profileId: PROFILES.o2 })).rejects.toMatchObject({ status: 409, code: 'internal_call' });
    expect(f.h.rows('motorist_audit_log').map(row => row.action)).not.toContain('telephony.call.blind_transfer');
  });
  it('another operator or organization never transfers this call', async () => {
    const f = await fixture();
    await expect(transferNativeCall(f.deps, { ...actor, profileId: PROFILES.o2, userId: PROFILES.o2 }, f.id, { deviceSessionId: lease, profileId: PROFILES.o3 })).rejects.toBeDefined();
    await expect(transferNativeCall({ ...f.deps, organizationId: 'foreign' }, { ...actor, organizationId: 'foreign' }, f.id, { deviceSessionId: lease, profileId: PROFILES.o2 })).rejects.toBeDefined();
    expect(f.h.rows('motorist_audit_log').map(row => row.action)).not.toContain('telephony.call.blind_transfer');
  });
});

describe('native recording stop', () => {
  it('stops recording of the connected call and reports the recorder, never assuming a stop', async () => {
    const f = await fixture({ recording: true });
    expect((await readNativeCallStatus(f.deps, actor, f.id, lease)).recording).toMatchObject({ state: 'recording', suppressed: false });
    const before = f.h.telnyx.of('recordingStop').length;
    const result = await stopNativeRecording(f.deps, actor, f.id, { deviceSessionId: lease });
    expect(f.h.telnyx.of('recordingStop').length).toBeGreaterThan(before);
    expect(result.sessionId).toBe(f.id);
    expect(['stopping', 'stopped']).toContain(result.recording.state);
    expect((await readNativeCallStatus(f.deps, actor, f.id, lease)).recording).toEqual(result.recording);
  });
  it('tells only the connected participant whether the call is recorded', async () => {
    const f = await fixture({ recording: true, answered: false });
    expect((await readNativeCallStatus(f.deps, actor, f.id, lease)).recording).toBeNull();
  });
  it('refuses a stale lease and an ended call', async () => {
    const f = await fixture({ recording: true });
    await expect(stopNativeRecording(f.deps, actor, f.id, { deviceSessionId: '00000000-0000-4000-8000-000000000072' })).rejects.toMatchObject({ status: 409 });
    f.h.db.update('motorist_call_sessions', { ended_at: f.h.now().toISOString(), state: 'ended' }, row => row.id === f.id);
    await expect(stopNativeRecording(f.deps, actor, f.id, { deviceSessionId: lease })).rejects.toBeDefined();
  });
});
