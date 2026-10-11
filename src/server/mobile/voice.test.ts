import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";
import type { TelephonyRuntimeDeps } from "@/server/telephony/runtime";
import { authorizeNativeOffer, nativeVoiceDeps, requireNativeLease, requireNativeSession } from "./voice";
import { disconnectDevice, touchDevice } from "@/server/telephony/operator-devices";
import { TelnyxCommandError } from "@/server/telephony/telnyx/client";
import { nativeMobilePushReachable } from "@/lib/telephony/device-liveness";
import { callColleague, createRateLimiter } from "@/server/telephony/call-actions";
import { toEligibilityDevices } from "@/server/telephony/routing/ring-plan";

const mocks = vi.hoisted(() => ({ deps: vi.fn() }));
vi.mock("@/server/telephony/runtime", () => ({ createTelephonyDeps: mocks.deps }));
const actor = { userId: PROFILES.o1, profileId: PROFILES.o1, organizationId: ORG, displayName: "Test", role: "dispatcher" as const };
const lease = "00000000-0000-4000-8000-000000000071", sessionId = "00000000-0000-4000-8000-000000000072", legId = "00000000-0000-4000-8000-000000000073";
function environment() {
  for (const [key, value] of Object.entries({ MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
    VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk", APP_BASE_URL: "https://test.dispecing.linkapomoci.sk",
    SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co", MOTORIST_NATIVE_VOICE_TEST_ENABLED: "true", MOTORIST_NATIVE_VOIP_PUSH_TEST_ENABLED: "true" })) vi.stubEnv(key, value);
}
beforeEach(() => { vi.clearAllMocks(); environment(); });
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  const h = createTelephonyHarness();
  const web = h.rows("motorist_operator_devices").find(row => row.profile_id === actor.profileId)!;
  h.db.seed("motorist_operator_mobile_devices", [{ ...web, sip_username: "native-test", device_session_id: lease, registration_state: "registered", metadata: {} }]);
  h.db.seed("motorist_call_sessions", [{ id: sessionId, organization_id: ORG, direction: "inbound", state: "ringing", metadata: { environment: "development" }, caller_number: "+421900000001", answered_at: null, ended_at: null, answered_by_profile_id: null }]);
  h.db.seed("motorist_call_legs", [{ id: legId, session_id: sessionId, organization_id: ORG, role: "operator", profile_id: actor.profileId,
    telnyx_call_control_id: "exact-native-leg", telnyx_call_leg_id: legId, to_number: "sip:native-test@sip.telnyx.com", ended_at: null, client_state: {} }]);
  const deps = { ...h.deps, deviceKind: "mobile" as const } as TelephonyRuntimeDeps;
  return { h, deps, offer: { deviceSessionId: lease, providerLegId: legId } };
}
describe("native voice boundaries", () => {
  it.each([{ VERCEL_ENV: "preview" }, { VERCEL_PROJECT_ID: "production-project" }, { MOTORIST_APP_ENV: "production" },
    { MOTORIST_NATIVE_VOICE_TEST_ENABLED: "false" }, { SUPABASE_URL: "https://ifpaeegaesdmljfkdvcn.supabase.co" }])("blocks provider creation outside the opted-in dedicated TEST: %j", async change => {
    for (const [key, value] of Object.entries(change)) vi.stubEnv(key, value);
    await expect(nativeVoiceDeps(actor)).rejects.toMatchObject({ status: 503 }); expect(mocks.deps).not.toHaveBeenCalled();
  });
  it("retains provenance-guarded cleanup after native creation is disabled", async () => {
    vi.stubEnv("MOTORIST_NATIVE_VOICE_TEST_ENABLED", "false"); mocks.deps.mockResolvedValue({});
    await nativeVoiceDeps(actor, { cleanup: true }); expect(mocks.deps).toHaveBeenCalledWith({ organizationId: ORG, deviceKind: "mobile" });
    vi.stubEnv("VERCEL_ENV", "preview"); await expect(nativeVoiceDeps(actor, { cleanup: true })).rejects.toMatchObject({ status: 503 });
  });
  it("authorizes only the current operator's exact mobile SIP leg", async () => {
    const { deps, h, offer } = fixture();
    expect(await authorizeNativeOffer(deps, actor, offer)).toMatchObject({ sessionId, callControlId: "exact-native-leg", direction: "inbound" });
    h.db.update("motorist_call_legs", { to_number: "sip:web-test@sip.telnyx.com" }, () => true);
    await expect(authorizeNativeOffer(deps, actor, offer)).rejects.toMatchObject({ status: 409 });
  });
  it("denies another operator, stale lease, cancelled offer and completed session", async () => {
    const f = fixture();
    await expect(authorizeNativeOffer(f.deps, { ...actor, profileId: PROFILES.o2 }, f.offer)).rejects.toMatchObject({ status: 409, code: "native_lease_stale" });
    await expect(authorizeNativeOffer(f.deps, actor, { ...f.offer, deviceSessionId: sessionId })).rejects.toMatchObject({ status: 409 });
    f.h.db.seed("motorist_ring_attempts", [{ organization_id: ORG, session_id: sessionId, leg_id: legId, result: "cancelled", ended_at: null }]);
    await expect(authorizeNativeOffer(f.deps, actor, f.offer)).rejects.toMatchObject({ status: 409 });
    f.h.db.seed("motorist_ring_attempts", []); f.h.db.update("motorist_call_sessions", { ended_at: f.h.now().toISOString() }, () => true);
    await expect(authorizeNativeOffer(f.deps, actor, f.offer)).rejects.toMatchObject({ status: 409 });
  });
  it("checks the current reservation token before answering", async () => {
    const { deps, h, offer } = fixture(); h.db.update("motorist_call_legs", { client_state: { offerToken: "old-reservation" } }, () => true);
    h.setPresence(actor.profileId, { status: "ringing", current_session_id: sessionId, offer_token: "new-reservation" });
    await expect(authorizeNativeOffer(deps, actor, offer)).rejects.toMatchObject({ status: 409 });
    h.setPresence(actor.profileId, { offer_token: "old-reservation" }); expect(await authorizeNativeOffer(deps, actor, offer)).toMatchObject({ sessionId });
  });
  it("does not grant whole-session hangup to a losing offer, even to a manager", async () => {
    const { deps, h } = fixture(); h.db.update("motorist_call_sessions", { answered_by_profile_id: PROFILES.o2 }, () => true);
    await expect(requireNativeSession(deps, { ...actor, role: "manager" }, sessionId)).rejects.toMatchObject({ status: 403 });
    expect(await requireNativeSession(deps, actor, sessionId, { readOffer: true })).toMatchObject({ id: sessionId });
  });
  it("provides a bounded push lease instead of pretending a background heartbeat is fresh", async () => {
    const { deps, h } = fixture();
    await touchDevice(deps, { organizationId: ORG, profileId: actor.profileId, deviceSessionId: lease, registrationState: "registered", nativeVoipRegistered: true });
    h.advance(180_000); const device = await requireNativeLease(deps, actor, lease);
    expect(nativeMobilePushReachable(device, h.now())).toBe(true);
    expect(device.metadata).not.toHaveProperty("pushToken");
    vi.stubEnv("MOTORIST_NATIVE_VOIP_PUSH_TEST_ENABLED", "false"); expect(nativeMobilePushReachable(device, h.now())).toBe(false);
  });
  it("allows retry of a failed revocation while refusing a different or newer mobile lease", async () => {
    const { deps, h } = fixture(); const original = h.telnyx.client.deleteTelephonyCredential;
    h.telnyx.client.deleteTelephonyCredential = vi.fn().mockRejectedValueOnce(new TelnyxCommandError({ code: "unknown", status: 503, message: "offline" })).mockImplementation(original);
    await expect(disconnectDevice(deps, { organizationId: ORG, profileId: actor.profileId, deviceSessionId: lease })).rejects.toMatchObject({ status: 502 });
    const revoking = await requireNativeLease(deps, actor, lease, { cleanup: true });
    expect(revoking.device_session_id).toMatch(/^revoked:/);
    await expect(requireNativeLease(deps, actor, sessionId, { cleanup: true })).rejects.toMatchObject({ status: 409 });
    await disconnectDevice(deps, { organizationId: ORG, profileId: actor.profileId, deviceSessionId: revoking.device_session_id! });
    expect(h.rows("motorist_operator_mobile_devices")[0].telnyx_credential_id).toBeNull();
    expect(h.rows("motorist_operator_devices").find(row => row.profile_id === actor.profileId)?.telnyx_credential_id).not.toBeNull();
  });
  it("keeps browser liveness unchanged and expires/revokes mobile push eligibility", async () => {
    const { deps, h } = fixture();
    await touchDevice(deps, { organizationId: ORG, profileId: actor.profileId, deviceSessionId: lease, registrationState: "registered", nativeVoipRegistered: true });
    h.advance(180_000); const device = await requireNativeLease(deps, actor, lease);
    expect(toEligibilityDevices([device])[0].nativePushReachable).toBeUndefined();
    expect(toEligibilityDevices([device], h.now())[0].nativePushReachable).toBe(true);
    expect(nativeMobilePushReachable({ ...device, device_session_id: sessionId }, h.now())).toBe(false);
    h.advance(7 * 86_400_000); expect(nativeMobilePushReachable(device, h.now())).toBe(false);
  });
  it("freezes web-to-colleague routing to the explicitly connected native TEST phone", async () => {
    const { deps, h } = fixture();
    await touchDevice(deps, { organizationId: ORG, profileId: actor.profileId, deviceSessionId: lease, registrationState: "registered", nativeVoipRegistered: true });
    h.advance(180_000); h.touchDevice(PROFILES.o2); h.touchDevice(actor.profileId);
    const result = await callColleague({ ...h.deps, rateLimiter: createRateLimiter() }, { profileId: PROFILES.o2, role: "dispatcher", displayName: "Web tester" },
      { targetProfileId: actor.profileId, requestId: legId });
    expect(h.session(result.sessionId).called_number).toBe("sip:native-test@sip.telnyx.com");
    expect((h.session(result.sessionId).metadata as { internal: { target_sip: string } }).internal.target_sip).toBe("sip:native-test@sip.telnyx.com");
  });
});
