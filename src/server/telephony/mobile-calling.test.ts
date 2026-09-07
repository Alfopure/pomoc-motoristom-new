import { completeAnnouncedAction } from "@/test/complete-call-announcements";
import { describe, expect, it } from "vitest";
import { createTelephonyHarness, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { callColleague, completeTransfer, pickupWaitingCall, startConsult, startOutboundCall, type CallActionDeps } from "./call-actions";
import { disconnectDevice, issueWebphoneToken, touchDevice } from "./operator-devices";

const actor = (profileId: string = PROFILES.o1) => ({ profileId, role: "dispatcher" as const });
const deps = (h: TelephonyHarness, mobile = true): CallActionDeps => ({ ...h.deps, deviceKind: mobile ? "mobile" : "web" });
const deviceDeps = (h: TelephonyHarness, mobile = true) => ({ admin: h.admin, telnyx: h.telnyx.client, environment: "development" as const, now: h.now, deviceKind: mobile ? "mobile" as const : "web" as const });
function readyMobile(h: TelephonyHarness, profileId: string = PROFILES.o1) {
  h.db.seed("motorist_operator_mobile_devices", [{ organization_id: ORG, profile_id: profileId, environment: "development", sip_username: `mobile-${profileId}`, telnyx_credential_id: `mobile-${profileId}`, device_session_id: "mobile-session", device_seen_at: h.now().toISOString(), registration_state: "registered" }]);
}

describe("separate explicit mobile calling", () => {
  it("mints and retires the mobile session without revoking the live web credential or heartbeat", async () => {
    const h = createTelephonyHarness();
    const web = h.rows("motorist_operator_devices");
    const token = await issueWebphoneToken(deviceDeps(h), { organizationId: ORG, profileId: PROFILES.o1 });
    expect(await touchDevice(deviceDeps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: token.deviceSessionId, registrationState: "registered" })).toMatchObject({ ok: true });
    expect(await touchDevice(deviceDeps(h), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: token.deviceSessionId, registrationState: "unregistered" })).toMatchObject({ ok: true });
    expect(h.rows("motorist_operator_devices")).toEqual(web);
  });

  it("fences late heartbeats from the old web tab after a lock-owner handoff", async () => {
    const h = createTelephonyHarness();
    const first = await issueWebphoneToken(deviceDeps(h, false), { organizationId: ORG, profileId: PROFILES.o1, takeover: true });
    await touchDevice(deviceDeps(h, false), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: first.deviceSessionId, registrationState: "registered" });
    const next = await issueWebphoneToken(deviceDeps(h, false), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: first.deviceSessionId, handoff: true });
    expect(next.deviceSessionId).not.toBe(first.deviceSessionId);
    expect(await touchDevice(deviceDeps(h, false), { organizationId: ORG, profileId: PROFILES.o1, deviceSessionId: first.deviceSessionId, registrationState: "unregistered" })).toEqual({ ok: false, reason: "stale_session" });
  });

  it.each(["mobile", "web"])("keeps the %s winner connected after a near-simultaneous answer and late loser hangup", async (winner) => {
    const h = createTelephonyHarness(); readyMobile(h);
    const call = await h.inbound();
    const webLeg = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    const pickup = await pickupWaitingCall(deps(h), actor(), call.sessionId);
    const mobileLeg = pickup.operatorLegCallControlId!;
    expect(h.telnyx.of("hangup").some((command) => command.params.callControlId === webLeg)).toBe(false);
    const first = winner === "mobile" ? mobileLeg : webLeg;
    const loser = winner === "mobile" ? webLeg : mobileLeg;
    await h.legEvent(first, "call.answered");
    await h.legEvent(loser, "call.answered");
    await h.legEvent(loser, "call.hangup");
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: PROFILES.o1, metadata: expect.objectContaining({ answered_leg_call_control_id: first }) });
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "on_call", current_session_id: call.sessionId });
    expect(h.telnyx.of("hangup").some((command) => command.params.callControlId === first)).toBe(false);
    expect(h.rows("motorist_operator_devices").find((row) => row.profile_id === PROFILES.o1)?.registration_state).toBe("registered");
  });

  it("originates from the mobile SIP identity and resolves colleagues to their web identity", async () => {
    const h = createTelephonyHarness(); readyMobile(h);
    const call = await callColleague(deps(h), actor(), { targetProfileId: PROFILES.o2 });
    expect(h.telnyx.of("dial")[0].params.to).toContain("mobile-");
    await h.legEvent(call.operatorLegCallControlId!, "call.answered");
    expect(h.telnyx.of("dial").at(-1)?.params.to).toContain("gencred002");
  });

  it("accepts an internal invitation in mobile and ignores the old web leg's late answer and hangup", async () => {
    const h = createTelephonyHarness(); readyMobile(h, PROFILES.o2);
    const call = await callColleague(deps(h, false), actor(), { targetProfileId: PROFILES.o2 });
    await h.legEvent(call.operatorLegCallControlId!, "call.answered");
    const oldLeg = String(h.legFor(call.sessionId, PROFILES.o2)!.telnyx_call_control_id);
    const mobile = await pickupWaitingCall(deps(h), actor(PROFILES.o2), call.sessionId);
    await h.legEvent(mobile.operatorLegCallControlId!, "call.answered");
    await h.legEvent(oldLeg, "call.answered");
    await h.legEvent(oldLeg, "call.hangup");
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(h.presence(PROFILES.o2).status).toBe("on_call");
    expect(h.telnyx.of("bridge").at(-1)?.params.targetCallControlId).toBe(mobile.operatorLegCallControlId);
    expect(h.telnyx.of("hangup").some((command) => command.params.callControlId === call.operatorLegCallControlId)).toBe(false);
  });

  it("accepts a private consult only for its invited operator and completes transfer using the accepted leg", async () => {
    const h = createTelephonyHarness(); readyMobile(h, PROFILES.o2); readyMobile(h, PROFILES.o5);
    const call = await h.inbound();
    const original = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    await h.legEvent(original, "call.answered");
    for (const leg of h.legs(call.sessionId)) if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1) await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
    await completeAnnouncedAction(h, startConsult(deps(h, false), actor(), call.sessionId, { profileId: PROFILES.o2 }));
    await expect(pickupWaitingCall(deps(h), actor(PROFILES.o5), call.sessionId)).rejects.toThrow();
    const old = h.legs(call.sessionId).find((leg) => leg.role === "consult")!;
    const mobile = await pickupWaitingCall(deps(h), actor(PROFILES.o2), call.sessionId);
    await h.legEvent(mobile.operatorLegCallControlId!, "call.answered");
    await h.legEvent(String(old.telnyx_call_control_id), "call.answered");
    await h.legEvent(String(old.telnyx_call_control_id), "call.hangup");
    expect(h.session(call.sessionId).state).toBe("consulting");
    await completeAnnouncedAction(h, completeTransfer(deps(h, false), actor(), call.sessionId));
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: PROFILES.o2, metadata: expect.objectContaining({ answered_leg_call_control_id: mobile.operatorLegCallControlId }) });
  });

  it("manager revocation deletes both credentials, including a mobile-only operator", async () => {
    const h = createTelephonyHarness(); readyMobile(h, PROFILES.o3);
    const { deviceKind: _kind, ...both } = deviceDeps(h);
    await disconnectDevice(both, { organizationId: ORG, profileId: PROFILES.o3 });
    expect(h.rows("motorist_operator_mobile_devices")[0].telnyx_credential_id).toBeNull();
  });

  it("does not allow an active desktop call to be replaced with a new mobile outbound call", async () => {
    const h = createTelephonyHarness(); readyMobile(h);
    const call = await h.inbound();
    await h.legEvent(String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id), "call.answered");
    await expect(startOutboundCall(deps(h), actor(), { to: "+421905123456" })).rejects.toThrow();
    expect(h.session(call.sessionId).state).toBe("talking");
  });
});
