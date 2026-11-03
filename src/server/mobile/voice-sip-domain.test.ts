import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import type { TelephonyRuntimeDeps } from "@/server/telephony/runtime";
import { callColleague, createRateLimiter, hangupCall, startOutboundCall } from "@/server/telephony/call-actions";
import { defaultLatencyFlags, type LatencyFlags } from "@/server/telephony/latency-flags";
import { sessionSipDomain } from "@/server/telephony/state/types";
import { authorizeNativeOffer, requireNativeSession } from "./voice";
import { changeNativeHold, readNativeCallStatus } from "./voice-hold";

/**
 * Call-speed S5 SIP-domain spike, on the phone: a session frozen to
 * `sip.telnyx.eu` dials the phone's credential there, and every check that
 * recognises "this phone's leg" by its SIP address (the offer, the delivered
 * offer, the native session, native hold, the callee's own hangup) accepts
 * that address, and still refuses another credential on either domain.
 */

const actor = { userId: PROFILES.o1, profileId: PROFILES.o1, organizationId: ORG, displayName: "Test", role: "dispatcher" as const };
const lease = "00000000-0000-4000-8000-000000000071";
const NATIVE_EU = "sip:native-test@sip.telnyx.eu";
const EU: Partial<LatencyFlags> = { api_region: "eu", sip_domain: "eu" };

beforeEach(() => {
  for (const [key, value] of Object.entries({ MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
    VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk", SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co", APP_BASE_URL: "https://test.dispecing.linkapomoci.sk",
    MOTORIST_NATIVE_VOICE_TEST_ENABLED: "true", TELEPHONY_STABILITY_V1_ENABLED: "true", TELNYX_CALL_ACTION_ANNOUNCEMENTS_ENABLED: "false" })) vi.stubEnv(key, value);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

let request = 0;
const requestId = () => `00000000-0000-4000-8000-${String(900 + ++request).padStart(12, "0")}`;

/** This operator's phone, registered, as their only mobile endpoint. */
function withPhone(flags: Partial<LatencyFlags>) {
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  h.deps.latencyFlags = { ...defaultLatencyFlags(), ...flags };
  const web = h.rows("motorist_operator_devices").find(row => row.profile_id === actor.profileId)!;
  h.db.seed("motorist_operator_mobile_devices", [{ ...web, sip_username: "native-test", device_session_id: lease, registration_state: "registered", metadata: {} }]);
  const deps = { ...h.deps, deviceKind: "mobile" as const, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) } as TelephonyRuntimeDeps;
  return { h, deps };
}

/** An outbound call placed from the phone, through to both sides talking. */
async function outboundFromPhone(h: TelephonyHarness, deps: TelephonyRuntimeDeps) {
  const call = await startOutboundCall(deps, actor, { to: NUMBERS.customer, requestId: requestId() });
  h.telnyx.physical.answered(call.operatorLegCallControlId);
  await h.legEvent(call.operatorLegCallControlId, "call.answered");
  const customer = String(h.legs(call.sessionId).find(leg => leg.role === "customer")!.telnyx_call_control_id);
  h.telnyx.physical.answered(customer);
  await h.legEvent(customer, "call.answered");
  expect(h.session(call.sessionId).state).toBe("talking");
  return call;
}

describe("the phone's leg of an `eu` session", () => {
  it("is dialled on sip.telnyx.eu and stays this phone's for status, hold and hangup", async () => {
    const { h, deps } = withPhone(EU);
    const call = await outboundFromPhone(h, deps);
    expect(sessionSipDomain(h.session(call.sessionId).metadata)).toBe("eu");
    expect(h.telnyx.of("dial")[0].params.to).toBe(NATIVE_EU);
    expect(h.legFor(call.sessionId, actor.profileId)!.to_number).toBe(NATIVE_EU);
    expect(await requireNativeSession(deps, actor, call.sessionId)).toMatchObject({ id: call.sessionId, nativeConnected: true });
    expect(await readNativeCallStatus(deps, actor, call.sessionId, lease)).toMatchObject({ connected: true, media: { state: "active", canHold: true, callControlId: call.operatorLegCallControlId } });
    const body = { deviceSessionId: lease, requestId: "11111111-1111-4111-8111-111111111111", callControlId: call.operatorLegCallControlId, held: true,
      expectedVersion: Number(h.session(call.sessionId).version) };
    expect(await changeNativeHold(deps, actor, call.sessionId, body)).toMatchObject({ operation: { outcome: "accepted", held: true }, media: { state: "held" } });
    expect(h.telnyx.of("conference:hold")).toHaveLength(1);
    await hangupCall(deps, actor, call.sessionId);
    expect(h.session(call.sessionId).ended_at ?? h.session(call.sessionId).termination_requested_at).toBeTruthy();
  });

  it("is not another credential's, on either domain", async () => {
    const { h, deps } = withPhone(EU);
    const call = await outboundFromPhone(h, deps);
    for (const foreign of ["sip:native-other@sip.telnyx.eu", "sip:native-other@sip.telnyx.com", "sip:native-test@sip.telnyx.de"]) {
      h.db.update("motorist_call_legs", { to_number: foreign }, row => row.telnyx_call_control_id === call.operatorLegCallControlId);
      await expect(requireNativeSession(deps, actor, call.sessionId), foreign).rejects.toMatchObject({ status: 403 });
    }
  });

  it("authorizes the offer of its exact leg, and the offer Telnyx delivered under whichever name it uses", async () => {
    const { h, deps } = withPhone(EU);
    const call = await startOutboundCall(deps, actor, { to: NUMBERS.customer, requestId: requestId() });
    const leg = h.legFor(call.sessionId, actor.profileId)!;
    expect(leg.to_number).toBe(NATIVE_EU);
    expect(await authorizeNativeOffer(deps, actor, { deviceSessionId: lease, callControlId: call.operatorLegCallControlId }))
      .toMatchObject({ sessionId: call.sessionId, callControlId: call.operatorLegCallControlId, direction: "outbound", role: "caller" });
    // The SDK reports an internal leg no webhook names: the one fresh leg Telnyx delivered to this phone.
    const connection = deps.config?.configured ? deps.config.credentialConnectionId : null;
    const sdkLeg = "2530AD30-CE3D-11F1-A033-02420A1F0D69";
    const offer = { deviceSessionId: lease, providerLegId: sdkLeg };
    const delivered = (to: string) => h.db.seed("motorist_telnyx_webhook_events", [{ event_id: `evt-${to}`, organization_id: ORG, event_type: "call.initiated",
      call_session_id: h.session(call.sessionId).telnyx_session_id, call_leg_id: "2530a204-ce3d-11f1-a1f5-02420a1f0d69", connection_id: connection,
      payload: { direction: "incoming", to } }]);
    h.db.update("motorist_call_legs", { created_at: h.now().toISOString(), answered_at: null }, row => row.id === leg.id);
    for (const foreign of ["native-other", "sip:native-other@sip.telnyx.eu", "sip:native-test@sip.telnyx.de", `${NATIVE_EU};transport=tls`]) {
      delivered(foreign);
      await expect(authorizeNativeOffer(deps, actor, offer), foreign).rejects.toMatchObject({ status: 409, code: "native_offer_pending" });
      h.db.delete("motorist_telnyx_webhook_events", () => true);
    }
    for (const to of ["native-test", NATIVE_EU, "sip:native-test@sip.telnyx.com"]) {
      delivered(to);
      expect(await authorizeNativeOffer(deps, actor, offer), to).toMatchObject({ sessionId: call.sessionId, callControlId: call.operatorLegCallControlId });
      h.db.delete("motorist_telnyx_webhook_events", () => true);
    }
    // Its leg is the phone's on either domain; another credential's is not.
    h.db.update("motorist_call_legs", { to_number: "sip:native-other@sip.telnyx.eu" }, row => row.id === leg.id);
    await expect(authorizeNativeOffer(deps, actor, { deviceSessionId: lease, callControlId: call.operatorLegCallControlId })).rejects.toMatchObject({ status: 409 });
  });

  it("lets the native callee of an `eu` colleague call read its direct audio and end the call", async () => {
    const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
    h.deps.latencyFlags = { ...defaultLatencyFlags(), ...EU };
    const callee = { ...actor, userId: PROFILES.o2, profileId: PROFILES.o2 };
    const calleeLease = "99999999-9999-4999-8999-999999999999";
    // Both parties on their phones only: the caller starts from the phone, the colleague has no live browser.
    for (const [profileId, sip, deviceLease] of [[actor.profileId, "native-test", lease], [PROFILES.o2, "native-colleague", calleeLease]]) {
      const web = h.rows("motorist_operator_devices").find(row => row.profile_id === profileId)!;
      h.db.seed("motorist_operator_mobile_devices", [{ ...web, sip_username: sip, device_session_id: deviceLease, registration_state: "registered", metadata: {} }]);
    }
    h.db.update("motorist_operator_devices", { registration_state: "unregistered" }, row => row.profile_id === PROFILES.o2);
    const deps = { ...h.deps, deviceKind: "mobile" as const, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) } as TelephonyRuntimeDeps;
    const start = await callColleague(deps, actor, { targetProfileId: PROFILES.o2, requestId: requestId() });
    expect(h.session(start.sessionId).called_number).toBe("sip:native-colleague@sip.telnyx.eu");
    h.telnyx.physical.answered(start.operatorLegCallControlId);
    await h.legEvent(start.operatorLegCallControlId, "call.answered");
    const calleeLeg = h.openLegFor(start.sessionId, PROFILES.o2)!;
    expect(calleeLeg.to_number).toBe("sip:native-colleague@sip.telnyx.eu");
    const calleeControl = String(calleeLeg.telnyx_call_control_id);
    h.telnyx.physical.answered(calleeControl);
    await h.legEvent(calleeControl, "call.answered");
    expect(h.session(start.sessionId).state).toBe("talking");
    for (const [who, deviceLease, control] of [[actor, lease, start.operatorLegCallControlId], [callee, calleeLease, calleeControl]] as const) {
      expect(await readNativeCallStatus(deps, who, start.sessionId, deviceLease)).toMatchObject({ connected: true, media: { state: "active", canHold: false, callControlId: control } });
    }
    // The callee's own provider hangup precedes the session's: their exact accepted endpoint keeps the right to end it.
    h.db.update("motorist_call_legs", { ended_at: h.now().toISOString() }, row => row.telnyx_call_control_id === calleeControl);
    await expect(hangupCall(deps, callee, start.sessionId)).resolves.toBeDefined();
  });
});
