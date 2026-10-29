import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";
import type { TelephonyRuntimeDeps } from "@/server/telephony/runtime";
import { authorizeNativeOffer, nativeVoiceDeps, requireNativeLease, requireNativeSession } from "./voice";
import { disconnectDevice, touchDevice } from "@/server/telephony/operator-devices";
import { TelnyxCommandError } from "@/server/telephony/telnyx/client";
import { nativeMobilePushReachable, nativePushLease } from "@/lib/telephony/device-liveness";
import { callColleague, createRateLimiter, hangupCall } from "@/server/telephony/call-actions";
import { toEligibilityDevices } from "@/server/telephony/routing/ring-plan";
import { loadActiveCalls, readActiveCallRows } from "@/server/telephony/active-calls";

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
  describe("on the production deployment", () => {
    function production(flags: Record<string, string> = {}) {
      vi.unstubAllEnvs();
      for (const [key, value] of Object.entries({ MOTORIST_APP_ENV: "production", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main",
        VERCEL_PROJECT_ID: "prj_DN3smSO1EbGowAmw3nHLQUYoSVJG", APP_BASE_URL: "https://dispecing.linkapomoci.sk",
        SUPABASE_URL: "https://ifpaeegaesdmljfkdvcn.supabase.co", ...flags })) vi.stubEnv(key, value);
    }
    it("creates native dependencies only with the production opt-in, never with the TEST one", async () => {
      mocks.deps.mockResolvedValue({});
      production(); await expect(nativeVoiceDeps(actor)).rejects.toMatchObject({ status: 503 });
      production({ MOTORIST_NATIVE_VOICE_TEST_ENABLED: "true" }); await expect(nativeVoiceDeps(actor)).rejects.toMatchObject({ status: 503 });
      expect(mocks.deps).not.toHaveBeenCalled();
      production({ MOTORIST_NATIVE_VOICE_ENABLED: "true" }); await nativeVoiceDeps(actor);
      expect(mocks.deps).toHaveBeenCalledWith({ organizationId: ORG, deviceKind: "mobile" });
    });
    it.each<Record<string, string>>([{ VERCEL_ENV: "preview" }, { VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk" }, { VERCEL_GIT_COMMIT_REF: "dev" },
      { APP_BASE_URL: "https://dispecing-test.vercel.app" }])("refuses creation and cleanup on a mismatched production binding %j", async change => {
      production({ MOTORIST_NATIVE_VOICE_ENABLED: "true", ...change });
      await expect(nativeVoiceDeps(actor)).rejects.toMatchObject({ status: 503 });
      await expect(nativeVoiceDeps(actor, { cleanup: true })).rejects.toMatchObject({ status: 503 });
      expect(mocks.deps).not.toHaveBeenCalled();
    });
    it("retains cleanup after the production opt-in is removed", async () => {
      production(); mocks.deps.mockResolvedValue({});
      await nativeVoiceDeps(actor, { cleanup: true }); expect(mocks.deps).toHaveBeenCalledWith({ organizationId: ORG, deviceKind: "mobile" });
    });
    it("leases and reaches only a production device row, only with both production flags", () => {
      const now = new Date("2026-10-29T10:00:00.000Z");
      const device = { environment: "production", device_session_id: lease, telnyx_credential_id: "credential", registration_state: "registered",
        sip_username: "native-production", credential_expires_at: null, metadata: {} };
      production({ MOTORIST_NATIVE_VOICE_ENABLED: "true", MOTORIST_NATIVE_VOIP_PUSH_ENABLED: "true" });
      const reachable = { ...device, metadata: { native_voip: nativePushLease(device, now, true) } };
      expect(reachable.metadata.native_voip).toMatchObject({ v: 1, platform: "ios", deviceSessionId: lease });
      expect(nativeMobilePushReachable(reachable, now)).toBe(true);
      expect(nativeMobilePushReachable({ ...reachable, environment: "development" }, now)).toBe(false);
      production({ MOTORIST_NATIVE_VOICE_ENABLED: "true", MOTORIST_NATIVE_VOIP_PUSH_TEST_ENABLED: "true" });
      expect(nativePushLease(device, now, true)).toBeNull(); expect(nativeMobilePushReachable(reachable, now)).toBe(false);
      vi.unstubAllEnvs(); environment();
      expect(nativeMobilePushReachable(reachable, now)).toBe(false);
      expect(nativeMobilePushReachable({ ...reachable, environment: "development" }, now)).toBe(true);
    });
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
  it("matches the stored lower-case leg ID that the iOS SDK reports in upper case", async () => {
    const { deps, h } = fixture(); const leg = "6fa67170-ce19-11f1-b24a-02420a1f0b69";
    h.db.update("motorist_call_legs", { telnyx_call_leg_id: leg }, () => true);
    expect(await authorizeNativeOffer(deps, actor, { deviceSessionId: lease, providerLegId: leg.toUpperCase() })).toMatchObject({ sessionId, callControlId: "exact-native-leg" });
  });
  it("permits a bounded retry when an SDK invite precedes the persisted dial response", async () => {
    const { deps, h, offer } = fixture(); const leg = h.rows("motorist_call_legs")[0];
    h.db.delete("motorist_call_legs", () => true);
    await expect(authorizeNativeOffer(deps, actor, offer)).rejects.toMatchObject({ status: 409, code: "native_offer_pending" });
    h.db.seed("motorist_call_legs", [leg]);
    h.db.update("motorist_call_sessions", { direction: "outbound", answered_by_profile_id: actor.profileId }, () => true);
    expect(await authorizeNativeOffer(deps, actor, offer)).toMatchObject({ sessionId, callControlId: "exact-native-leg" });
  });
  it("authorizes the one fresh leg Telnyx delivered to this phone when the SDK reports its internal leg", async () => {
    // Seen on TEST: dialed leg 24ff4664…, credential-connection leg 2530a204…, SDK leg 2530ad30….
    const { deps, h } = fixture(); const sdkLeg = "2530AD30-CE3D-11F1-A033-02420A1F0D69";
    const connection = deps.config?.configured ? deps.config.credentialConnectionId : null;
    h.db.update("motorist_call_sessions", { direction: "outbound", telnyx_session_id: "provider-session", called_number: "+421900000009", metadata: { environment: deps.environment } }, () => true);
    h.db.update("motorist_call_legs", { created_at: h.now().toISOString(), answered_at: null }, () => true);
    const initiated = (change: Record<string, unknown> = {}) => ({ event_id: "evt-" + Math.random(), organization_id: ORG, event_type: "call.initiated",
      call_session_id: "provider-session", call_leg_id: "2530a204-ce3d-11f1-a1f5-02420a1f0d69", connection_id: connection, payload: { direction: "incoming", to: "native-test" }, ...change });
    const offer = { deviceSessionId: lease, providerLegId: sdkLeg };
    // Not yet delivered to the phone, or delivered elsewhere: still pending.
    await expect(authorizeNativeOffer(deps, actor, offer)).rejects.toMatchObject({ status: 409, code: "native_offer_pending" });
    for (const foreign of [{ connection_id: "another-connection" }, { organization_id: "00000000-0000-4000-8000-0000000000ff" },
      { payload: { direction: "incoming", to: "someone-else" } }, { payload: { direction: "outgoing", to: "native-test" } }, { call_session_id: "another-call" }]) {
      h.db.seed("motorist_telnyx_webhook_events", [initiated(foreign)]);
      await expect(authorizeNativeOffer(deps, actor, offer)).rejects.toMatchObject({ status: 409, code: "native_offer_pending" });
    }
    h.db.seed("motorist_telnyx_webhook_events", [initiated()]);
    expect(await authorizeNativeOffer(deps, actor, offer)).toMatchObject({ sessionId, callControlId: "exact-native-leg", direction: "outbound", role: "caller" });
    // Two open legs to this phone are ambiguous; an answered, stale or ended leg is not an offer.
    const leg = h.rows("motorist_call_legs")[0];
    const second = "00000000-0000-4000-8000-000000000075";
    h.db.seed("motorist_call_legs", [{ ...leg, id: second, telnyx_call_control_id: "second-leg", telnyx_call_leg_id: "00000000-0000-4000-8000-000000000076" }]);
    await expect(authorizeNativeOffer(deps, actor, offer)).rejects.toMatchObject({ status: 409, code: "native_offer_pending" });
    h.db.delete("motorist_call_legs", row => row.id === second);
    for (const change of [{ answered_at: h.now().toISOString() }, { created_at: new Date(h.now().getTime() - 61_000).toISOString() }, { ended_at: h.now().toISOString() }]) {
      h.db.update("motorist_call_legs", { created_at: h.now().toISOString(), answered_at: null, ended_at: null, ...change }, () => true);
      await expect(authorizeNativeOffer(deps, actor, offer)).rejects.toMatchObject({ status: 409, code: "native_offer_pending" });
    }
  });
  it.each(["error", "unregistered"])("allows the current owner to recover from %s without reviving a revoked lease", async registration_state => {
    const { deps, h } = fixture(); h.db.update("motorist_operator_mobile_devices", { registration_state }, () => true);
    await expect(requireNativeLease(deps, actor, lease)).rejects.toMatchObject({ status: 409 });
    expect(await requireNativeLease(deps, actor, lease, { heartbeat: true })).toMatchObject({ device_session_id: lease });
    await expect(requireNativeLease(deps, actor, sessionId, { heartbeat: true })).rejects.toMatchObject({ status: 409 });
    h.db.update("motorist_operator_mobile_devices", { device_session_id: "revoked:old", metadata: { native_revocation_session_id: lease } }, () => true);
    await expect(requireNativeLease(deps, actor, lease, { heartbeat: true })).rejects.toMatchObject({ status: 409 });
  });
  it("denies controlling a browser-only call even when the mobile actor owns the session", async () => {
    const { deps, h } = fixture();
    h.db.update("motorist_call_sessions", { direction: "outbound", answered_by_profile_id: actor.profileId }, () => true);
    h.db.update("motorist_call_legs", { to_number: "sip:web-test@sip.telnyx.com" }, () => true);
    await expect(requireNativeSession(deps, actor, sessionId)).rejects.toMatchObject({ status: 403 });
    await expect(requireNativeSession(deps, actor, sessionId, { readOffer: true })).rejects.toMatchObject({ status: 403 });
  });
  it.each(["inbound", "internal"])("ends the losing %s mobile offer when this operator answers on web", async direction => {
    const { deps, h, offer } = fixture();
    h.db.update("motorist_call_sessions", { direction, state: "talking", answered_by_profile_id: actor.profileId,
      answered_at: h.now().toISOString(), metadata: { environment: "development", accepted_device_legs: { [actor.profileId]: "browser-winner" } } }, () => true);
    h.db.update("motorist_call_legs", { answered_at: h.now().toISOString() }, () => true);
    await expect(requireNativeSession(deps, actor, sessionId)).rejects.toMatchObject({ status: 403 });
    expect(await requireNativeSession(deps, actor, sessionId, { readOffer: true })).toMatchObject({ nativeConnected: false, nativeEnded: true });
    await expect(authorizeNativeOffer(deps, actor, offer)).rejects.toMatchObject({ status: 409 });
  });
  it("authorizes the mobile caller before answer and the winning mobile leg after answer", async () => {
    const { deps, h } = fixture();
    h.db.update("motorist_call_sessions", { direction: "outbound", answered_by_profile_id: actor.profileId }, () => true);
    expect(await requireNativeSession(deps, actor, sessionId)).toMatchObject({ nativeConnected: false, nativeEnded: false });
    h.db.update("motorist_call_sessions", { direction: "inbound", state: "talking", answered_at: h.now().toISOString(),
      metadata: { environment: "development", answered_leg_call_control_id: "exact-native-leg" } }, () => true);
    h.db.update("motorist_call_legs", { answered_at: h.now().toISOString() }, () => true);
    expect(await requireNativeSession(deps, actor, sessionId)).toMatchObject({ nativeConnected: true, nativeEnded: false });
    h.db.update("motorist_call_legs", { ended_at: h.now().toISOString() }, () => true);
    expect(await requireNativeSession(deps, actor, sessionId, { readOffer: true })).toMatchObject({ nativeConnected: false, nativeEnded: true });
    // The exact winner retains cleanup authority while the customer leg ends.
    expect(await requireNativeSession(deps, actor, sessionId)).toMatchObject({ nativeEnded: true });
  });
  it("lets the mobile caller clean up after its leg ends before session finalization", async () => {
    const { deps, h } = fixture();
    h.db.update("motorist_call_sessions", { direction: "outbound", answered_by_profile_id: actor.profileId, termination_requested_at: h.now().toISOString() }, () => true);
    h.db.update("motorist_call_legs", { ended_at: h.now().toISOString() }, () => true);
    expect(await requireNativeSession(deps, actor, sessionId)).toMatchObject({ nativeConnected: false, nativeEnded: true });
  });
  it("lets the exact native callee end an internal call without owning the caller profile", async () => {
    const { deps, h } = fixture();
    h.db.update("motorist_call_sessions", { direction: "internal", answered_by_profile_id: PROFILES.o2,
      metadata: { environment: "development", internal: { target_profile_id: actor.profileId }, accepted_device_legs: { [actor.profileId]: "exact-native-leg" } } }, () => true);
    h.db.update("motorist_call_legs", { answered_at: h.now().toISOString() }, () => true);
    expect(await requireNativeSession(deps, actor, sessionId)).toMatchObject({ nativeConnected: true });
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
  it("freezes both web and the explicitly connected native TEST colleague endpoints", async () => {
    const { deps, h } = fixture();
    await touchDevice(deps, { organizationId: ORG, profileId: actor.profileId, deviceSessionId: lease, registrationState: "registered", nativeVoipRegistered: true });
    h.advance(180_000); h.touchDevice(PROFILES.o2); h.touchDevice(actor.profileId);
    const result = await callColleague({ ...h.deps, rateLimiter: createRateLimiter() }, { profileId: PROFILES.o2, role: "dispatcher", displayName: "Web tester" },
      { targetProfileId: actor.profileId, requestId: legId });
    expect(h.session(result.sessionId).called_number).toBe("sip:native-test@sip.telnyx.com");
    expect((h.session(result.sessionId).metadata as { internal: { endpoints: unknown[] } }).internal.endpoints).toEqual([
      { device: "web", sipUri: expect.stringContaining("gencred001") }, { device: "mobile", sipUri: "sip:native-test@sip.telnyx.com" },
    ]);
  });
  it("allows the ordinary native callee to finish internal-call cleanup after its leg ends", async () => {
    const { deps, h } = fixture();
    const result = await callColleague({ ...h.deps, rateLimiter: createRateLimiter() }, { profileId: PROFILES.o2, role: "dispatcher", displayName: "Web tester" },
      { targetProfileId: actor.profileId, requestId: legId });
    await h.legEvent(result.operatorLegCallControlId, "call.answered");
    const callee = h.legs(result.sessionId).find(leg => leg.profile_id === actor.profileId && leg.to_number === "sip:native-test@sip.telnyx.com")!;
    await h.legEvent(String(callee.telnyx_call_control_id), "call.answered");
    const webLoser = h.legs(result.sessionId).find(leg => leg.profile_id === actor.profileId && leg.id !== callee.id)!;
    await h.legEvent(String(webLoser.telnyx_call_control_id), "call.hangup", { hangup_cause: "originator_cancel" });
    h.db.update("motorist_call_legs", { ended_at: h.now().toISOString(), state: "ended" }, row => row.id === callee.id);
    expect(await requireNativeSession(deps, actor, result.sessionId)).toMatchObject({ nativeEnded: true });
    await expect(hangupCall({ ...h.deps, deviceKind: "web" }, actor, result.sessionId)).rejects.toMatchObject({ status: 403 });
    const ended = await hangupCall({ ...h.deps, deviceKind: "mobile" }, actor, result.sessionId);
    expect(ended.state).toBe("wrap_up");
    expect(h.telnyx.of("hangup").at(-1)?.params.callControlId).toBe(result.operatorLegCallControlId);
  });
  it.each([false, true])("shows a background native colleague as callable in the web presence snapshot (RPC: %s)", async rpc => {
    const { deps, h } = fixture();
    await touchDevice(deps, { organizationId: ORG, profileId: actor.profileId, deviceSessionId: lease, registrationState: "registered", nativeVoipRegistered: true });
    h.advance(180_000);
    const snapshotDeps = { ...h.deps, configured: true };
    if (rpc) {
      const rows = await readActiveCallRows(snapshotDeps);
      const payload = JSON.parse(JSON.stringify({ ...rows, mobileDevices: undefined, callRows: [] }));
      vi.spyOn(h.admin, "rpc").mockReturnValue({ abortSignal: () => Promise.resolve({ data: payload, error: null }) } as unknown as ReturnType<typeof h.admin.rpc>);
      vi.stubEnv("TELEPHONY_ACTIVE_SNAPSHOT_V1_ENABLED", "true");
    }
    const viewer = { profileId: PROFILES.o2, canManageAssignments: false };
    const snapshot = await loadActiveCalls(snapshotDeps, viewer);
    expect(snapshot.presence.devices.filter(device => device.profileId === actor.profileId)).toEqual([
      expect.objectContaining({ registered: true }),
    ]);
    vi.stubEnv("MOTORIST_NATIVE_VOICE_TEST_ENABLED", "false");
    expect((await loadActiveCalls(snapshotDeps, viewer)).presence.devices.find(device => device.profileId === actor.profileId)?.registered).toBe(false);
    expect(h.telnyx.calls).toHaveLength(0);
  });
});

describe("native pending transfer ownership", () => {
  function transferred(kind: "global" | "own") {
    const f = fixture();
    f.h.db.update("motorist_call_legs", { client_state: { intent: "transfer_safe" } }, () => true);
    f.h.db.seed("motorist_call_legs", [{ id: "old", session_id: sessionId, organization_id: ORG,
      profile_id: kind === "own" ? actor.profileId : PROFILES.o2, role: "operator", telnyx_call_control_id: "old-answered-leg",
      to_number: "sip:previous@sip.telnyx.com", answered_at: f.h.now().toISOString(), ended_at: f.h.now().toISOString(), client_state: { intent: "ring" } }]);
    f.h.db.update("motorist_call_sessions", { answered_at: f.h.now().toISOString(), answered_by_profile_id: null,
      metadata: { environment: "development", answered_leg_call_control_id: "old-answered-leg",
        ...(kind === "own" ? { accepted_device_legs: { [actor.profileId]: "old-answered-leg" } } : {}),
        transfer: { kind: "blind", at: f.h.now().toISOString(), target: { kind: "operator", profileId: actor.profileId, sipUri: "sip:native-test@sip.telnyx.com" } } } }, () => true);
    return f;
  }
  it.each(["global", "own"] as const)("does not treat historical %s answered metadata as the current transfer winner", async kind => {
    const f = transferred(kind);
    await expect(authorizeNativeOffer(f.deps, actor, f.offer)).resolves.toMatchObject({ sessionId, callControlId: "exact-native-leg" });
  });
  it.each(["global", "own"] as const)("does not definitively end a pending mobile transfer due to historical %s winner", async kind => {
    const f = transferred(kind);
    expect(await requireNativeSession(f.deps, actor, sessionId, { readOffer: true })).toMatchObject({ nativeConnected: false, nativeEnded: false });
  });
  it.each(["transfer", "transfer_safe", "transfer_recorded"])("allows a current %s offer without granting session cleanup", async intent => {
    const f = transferred("own");
    f.h.db.update("motorist_call_legs", { client_state: { intent } }, row => row.id === legId);
    await expect(authorizeNativeOffer(f.deps, actor, f.offer)).resolves.toMatchObject({ callControlId: "exact-native-leg" });
    await expect(requireNativeSession(f.deps, actor, sessionId)).rejects.toMatchObject({ status: 403 });
    expect(f.h.telnyx.calls).toHaveLength(0);
  });
  it.each(["live winner", "missing winner", "foreign session", "foreign organization", "wrong winner role", "foreign accepted profile", "busy caller", "wrong target", "completed transfer", "wrong intent", "outbound", "assigned", "wrong SIP", "wrong role"])("does not authorize historical metadata with %s", async reason => {
    const f = transferred("own");
    const old = (row: Record<string, unknown>) => row.id === "old";
    if (reason === "live winner") f.h.db.update("motorist_call_legs", { ended_at: null }, old);
    if (reason === "missing winner") f.h.db.update("motorist_call_legs", { telnyx_call_control_id: "different" }, old);
    if (reason === "foreign session") f.h.db.update("motorist_call_legs", { session_id: lease }, old);
    if (reason === "foreign organization") f.h.db.update("motorist_call_legs", { organization_id: lease }, old);
    if (reason === "wrong winner role") f.h.db.update("motorist_call_legs", { role: "consult" }, old);
    if (reason === "foreign accepted profile") f.h.db.update("motorist_call_legs", { profile_id: PROFILES.o2 }, old);
    if (reason === "busy caller") f.h.db.seed("motorist_call_legs", [{ id: "busy", session_id: sessionId, organization_id: ORG, role: "operator", profile_id: PROFILES.o2, answered_at: f.h.now().toISOString(), ended_at: null }]);
    if (reason === "wrong target" || reason === "completed transfer") {
      const metadata = f.h.rows("motorist_call_sessions")[0].metadata as Record<string, unknown>;
      const transfer = metadata.transfer as Record<string, unknown>;
      f.h.db.update("motorist_call_sessions", { metadata: { ...metadata, transfer: { ...transfer,
        ...(reason === "wrong target" ? { target: { kind: "operator", profileId: PROFILES.o2 } } : { completed_at: f.h.now().toISOString() }) } } }, () => true);
    }
    if (reason === "wrong intent") f.h.db.update("motorist_call_legs", { client_state: { intent: "ring" } }, row => row.id === legId);
    if (reason === "outbound") f.h.db.update("motorist_call_sessions", { direction: "outbound" }, () => true);
    if (reason === "assigned") f.h.db.update("motorist_call_sessions", { answered_by_profile_id: PROFILES.o2 }, () => true);
    if (reason === "wrong SIP") f.h.db.update("motorist_call_legs", { to_number: "sip:another@sip.telnyx.com" }, row => row.id === legId);
    if (reason === "wrong role") f.h.db.update("motorist_call_legs", { role: "consult" }, row => row.id === legId);
    await expect(authorizeNativeOffer(f.deps, actor, f.offer)).rejects.toMatchObject({ status: 409 });
    if (!["wrong SIP", "wrong role"].includes(reason)) {
      expect(await requireNativeSession(f.deps, actor, sessionId, { readOffer: true })).toMatchObject({ nativeConnected: false, nativeEnded: true });
    }
    expect(f.h.telnyx.calls).toHaveLength(0);
  });
  it("retains current lease, offer reservation and attempt denials during transfer", async () => {
    const f = transferred("own");
    await expect(authorizeNativeOffer(f.deps, actor, { ...f.offer, deviceSessionId: sessionId })).rejects.toMatchObject({ code: "native_lease_stale" });
    f.h.db.update("motorist_call_legs", { client_state: { intent: "transfer_safe", offerToken: "current" } }, row => row.id === legId);
    await expect(authorizeNativeOffer(f.deps, actor, f.offer)).rejects.toMatchObject({ status: 409 });
    f.h.db.update("motorist_call_legs", { client_state: { intent: "transfer_safe" } }, row => row.id === legId);
    f.h.db.seed("motorist_ring_attempts", [{ organization_id: ORG, session_id: sessionId, leg_id: legId, result: "cancelled", ended_at: f.h.now().toISOString() }]);
    await expect(authorizeNativeOffer(f.deps, actor, f.offer)).rejects.toMatchObject({ status: 409 });
  });

});


describe("native internal offer party contract", () => {
  it.each(["caller", "callee"] as const)("derives the exact internal %s and safe peer display", async role => {
    const f = fixture();
    f.h.db.update("motorist_call_sessions", { direction: "internal", metadata: { environment: "development", internal: {
      by: role === "caller" ? actor.profileId : PROFILES.o2, target_profile_id: role === "callee" ? actor.profileId : PROFILES.o2,
      caller_name: "Caller", target_name: "Colleague" } } }, () => true);
    f.h.db.update("motorist_call_legs", { client_state: { intent: role === "caller" ? "internal_caller" : "internal" } }, () => true);
    expect(await authorizeNativeOffer(f.deps, actor, f.offer)).toMatchObject({ role, displayName: role === "caller" ? "Colleague" : "Caller", number: null });
  });
  it.each(["internal_caller", "internal"])("rejects mismatched internal party identity for %s", async intent => {
    const f = fixture();
    f.h.db.update("motorist_call_sessions", { direction: "internal", metadata: { environment: "development", internal: { by: PROFILES.o2, target_profile_id: PROFILES.o3 } } }, () => true);
    f.h.db.update("motorist_call_legs", { client_state: { intent } }, () => true);
    await expect(authorizeNativeOffer(f.deps, actor, f.offer)).rejects.toMatchObject({ status: 409 });
  });
});


describe("native offer role fail-closed boundaries", () => {
  it.each(["internal", "ring", "transfer", null])("never grants caller role to a different intent %s", async intent => {
    const f = fixture();
    f.h.db.update("motorist_call_sessions", { direction: "internal", metadata: { environment: "development", internal: { by: actor.profileId, target_profile_id: PROFILES.o2 } } }, () => true);
    f.h.db.update("motorist_call_legs", { client_state: { intent } }, () => true);
    await expect(authorizeNativeOffer(f.deps, actor, f.offer)).rejects.toMatchObject({ status: 409 });
  });
  it.each([undefined, "not-a-profile", actor.profileId])("rejects an incomplete or self-referential peer %s", async peer => {
    const f = fixture();
    f.h.db.update("motorist_call_sessions", { direction: "internal", metadata: { environment: "development", internal: { by: actor.profileId, target_profile_id: peer } } }, () => true);
    f.h.db.update("motorist_call_legs", { client_state: { intent: "internal_caller" } }, () => true);
    await expect(authorizeNativeOffer(f.deps, actor, f.offer)).rejects.toMatchObject({ status: 409 });
  });
  it.each([["outbound", "caller"], ["inbound", "callee"]])("retains the external %s number and explicit %s role", async (direction, role) => {
    const f = fixture(); f.h.db.update("motorist_call_sessions", { direction, called_number: "+421905555555" }, () => true);
    expect(await authorizeNativeOffer(f.deps, actor, f.offer)).toMatchObject({ role, displayName: null, number: direction === "outbound" ? "+421905555555" : "+421900000001" });
  });
});


describe("internal offer safe peer label", () => {
  it.each([[undefined, "Kolega"], ["  Ja\nna  ", "Jana"], ["x".repeat(130), "x".repeat(120)]])("uses safe presentation independently of authority: %j", async (name, expected) => {
    const f = fixture();
    f.h.db.update("motorist_call_sessions", { direction: "internal", metadata: { environment: "development", internal: { by: PROFILES.o2, target_profile_id: actor.profileId, caller_name: name } } }, () => true);
    f.h.db.update("motorist_call_legs", { client_state: { intent: "internal" } }, () => true);
    expect(await authorizeNativeOffer(f.deps, actor, f.offer)).toMatchObject({ role: "callee", displayName: expected, number: null });
  });
});
