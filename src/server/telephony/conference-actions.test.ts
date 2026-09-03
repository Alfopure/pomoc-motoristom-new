import { describe, expect, it } from "vitest";

import { createTelephonyHarness, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";

import {
  addCallParty,
  CallActionError,
  createRateLimiter,
  leaveConferenceCall,
  removeCallParty,
  setCallPartyMuted,
  stopSupervisingCall,
  startOutboundCall,
  superviseCall,
  type CallActionDeps,
  type CallActor,
} from "./call-actions";
import { TelnyxCommandError } from "./telnyx/client";

/**
 * Conference (three-way) and supervision, driven end to end through the real
 * reducer, effects and fake Telnyx (design §4 Phase 4, stage 3).
 */

const o1: CallActor = { profileId: PROFILES.o1, role: "dispatcher", displayName: "Jana" };
const o2: CallActor = { profileId: PROFILES.o2, role: "dispatcher", displayName: "Peter" };
const senior: CallActor = { profileId: PROFILES.o3, role: "senior_dispatcher", displayName: "Senior" };
const manager: CallActor = { profileId: PROFILES.o4, role: "manager", displayName: "Manažér" };

function actionDeps(h: TelephonyHarness, overrides: Partial<CallActionDeps> = {}): CallActionDeps {
  return { ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }), ...overrides };
}

/**
 * The seed only gives the three operators a browser phone; a supervisor needs
 * one too, because supervision dials their own WebRTC leg.
 */
const SUPERVISOR_SIP = "sip:gencred900@sip.telnyx.com";

function giveSupervisorDevice(h: TelephonyHarness): void {
  const seenAt = h.now().toISOString();
  h.db.seed("motorist_operator_devices", [
    {
      organization_id: ORG,
      profile_id: PROFILES.o4,
      environment: "development",
      telnyx_credential_id: "cred-900",
      sip_username: "gencred900",
      credential_expires_at: null,
      last_token_issued_at: seenAt,
      token_expires_at: null,
      device_seen_at: seenAt,
      device_session_id: "dev-900",
      registration_state: "registered",
      user_agent: "vitest",
      metadata: {},
    },
  ]);
}

async function fail(promise: Promise<unknown>): Promise<CallActionError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CallActionError) return error;
    throw error;
  }
  throw new Error("expected a CallActionError");
}

/** Inbound call answered by o1 (losers hung up) → talking. */
async function talkingWith(h: TelephonyHarness, operator = PROFILES.o1) {
  const call = await h.inbound({ to: NUMBERS.allianz });
  const winner = h.legFor(call.sessionId, operator)!;
  await h.legEvent(String(winner.telnyx_call_control_id), "call.answered");
  for (const leg of h.legs(call.sessionId)) {
    if (leg.role !== "customer" && leg.profile_id !== operator) {
      await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup", { hangup_cause: "originator_cancel" });
    }
  }
  expect(h.session(call.sessionId).state).toBe("talking");
  return { ...call, operatorLeg: String(winner.telnyx_call_control_id) };
}

/** o1 talking with the caller plus one answered external party → `conference`. */
async function threeWay(h: TelephonyHarness) {
  const call = await talkingWith(h);
  await addCallParty(actionDeps(h), o1, call.sessionId, { number: NUMBERS.external });
  const party = h.legByNumber(call.sessionId, NUMBERS.external)!;
  await h.legEvent(String(party.telnyx_call_control_id), "call.answered", { direction: "outgoing" });
  expect(h.session(call.sessionId).state).toBe("conference");
  return { ...call, partyLeg: h.legByNumber(call.sessionId, NUMBERS.external)! };
}

describe("addCallParty", () => {
  it("promotes the call to a conference and dials the third party with link_to", async () => {
    const h = createTelephonyHarness();
    const call = await talkingWith(h);

    const result = await addCallParty(actionDeps(h), o1, call.sessionId, { number: "0900 000 000" });
    expect(result.ignored).toBeNull();

    expect(h.telnyx.of("createConference")).toHaveLength(1);
    expect(h.telnyx.of("conference:join")[0].params).toMatchObject({ call_control_id: call.callControlId });
    const dial = h.telnyx.of("dial").at(-1)!.params;
    expect(dial).toMatchObject({ to: NUMBERS.external, linkTo: call.callControlId, timeoutSecs: 30 });
    // The state only moves once the party actually answers.
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking" });
    expect(h.session(call.sessionId).metadata).toMatchObject({ party_pending: { by: PROFILES.o1 } });

    const party = h.legByNumber(call.sessionId, NUMBERS.external)!;
    expect(party).toMatchObject({ role: "external", client_state: expect.objectContaining({ intent: "party" }) });

    await h.legEvent(String(party.telnyx_call_control_id), "call.answered", { direction: "outgoing" });
    expect(h.session(call.sessionId).state).toBe("conference");
    expect(h.session(call.sessionId).metadata).toMatchObject({ party_pending: null });
    expect(h.telnyx.of("conference:join").at(-1)!.params).toMatchObject({ call_control_id: party.telnyx_call_control_id });
  });

  it("adds a colleague, reserves them and takes a held caller off hold on answer", async () => {
    const h = createTelephonyHarness();
    const call = await talkingWith(h);
    h.db.update("motorist_call_sessions", { state: "held", hold_started_at: h.now().toISOString() }, (row) => row.id === call.sessionId);

    await addCallParty(actionDeps(h), o1, call.sessionId, { profileId: PROFILES.o2 });
    // `legFor` would find the ring-offer leg that already ended.
    const party = h.openLegFor(call.sessionId, PROFILES.o2)!;
    expect(party).toMatchObject({ role: "operator", client_state: expect.objectContaining({ intent: "party" }) });

    await h.legEvent(String(party.telnyx_call_control_id), "call.answered");
    expect(h.session(call.sessionId)).toMatchObject({ state: "conference", hold_started_at: null });
    expect(h.telnyx.of("conference:unhold").at(-1)!.params).toMatchObject({ call_control_ids: [call.callControlId] });
    expect(h.presence(PROFILES.o2)).toMatchObject({ status: "on_call", current_session_id: call.sessionId });
  });

  it("refuses a second party while the first is still ringing, and the caller's own operator", async () => {
    const h = createTelephonyHarness();
    const call = await talkingWith(h);
    await addCallParty(actionDeps(h), o1, call.sessionId, { number: NUMBERS.external });

    expect(await fail(addCallParty(actionDeps(h), o1, call.sessionId, { profileId: PROFILES.o2 }))).toMatchObject({ status: 409 });
    expect(await fail(addCallParty(actionDeps(h), o1, call.sessionId, { profileId: PROFILES.o1 }))).toMatchObject({ status: 400, code: "self_transfer" });
  });

  it("leaves the call untouched when the party never answers", async () => {
    const h = createTelephonyHarness();
    const call = await talkingWith(h);
    await addCallParty(actionDeps(h), o1, call.sessionId, { number: NUMBERS.external });
    const party = h.legByNumber(call.sessionId, NUMBERS.external)!;

    await h.legEvent(String(party.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer", direction: "outgoing" });
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: PROFILES.o1 });
    expect(h.session(call.sessionId).metadata).toMatchObject({ party_pending: null });
    expect(h.presence(PROFILES.o1).status).toBe("on_call");
  });

  it("writes an audit row naming the participant", async () => {
    const h = createTelephonyHarness();
    const call = await talkingWith(h);
    await addCallParty(actionDeps(h), o1, call.sessionId, { number: NUMBERS.external });
    expect(h.rows("motorist_audit_log")).toEqual([
      expect.objectContaining({ action: "telephony.conference.add_party", entity_type: "telephony_call", entity_id: call.sessionId, actor_profile_id: PROFILES.o1 }),
    ]);
  });
});

describe("mute, unmute and remove", () => {
  it("mutes and unmutes only the added participant", async () => {
    const h = createTelephonyHarness();
    const call = await threeWay(h);

    await setCallPartyMuted(actionDeps(h), o1, call.sessionId, String(call.partyLeg.id), true);
    expect(h.telnyx.of("conference:mute").at(-1)!.params).toMatchObject({ call_control_ids: [call.partyLeg.telnyx_call_control_id] });
    expect(h.legs(call.sessionId).find((leg) => leg.id === call.partyLeg.id)!.metadata).toMatchObject({ muted: true });

    await setCallPartyMuted(actionDeps(h), o1, call.sessionId, String(call.partyLeg.id), false);
    expect(h.telnyx.of("conference:unmute")).toHaveLength(1);
    expect(h.legs(call.sessionId).find((leg) => leg.id === call.partyLeg.id)!.metadata).toMatchObject({ muted: false });

    const customer = h.legs(call.sessionId).find((leg) => leg.role === "customer")!;
    expect(await fail(setCallPartyMuted(actionDeps(h), o1, call.sessionId, String(customer.id), true))).toMatchObject({ status: 409 });
  });

  it("removes a participant and falls back to the two-party call", async () => {
    const h = createTelephonyHarness();
    const call = await threeWay(h);

    await removeCallParty(actionDeps(h), o1, call.sessionId, String(call.partyLeg.id));
    expect(h.telnyx.of("conference:leave").at(-1)!.params).toMatchObject({ call_control_id: call.partyLeg.telnyx_call_control_id });
    expect(h.telnyx.of("hangup").at(-1)!.params).toMatchObject({ callControlId: call.partyLeg.telnyx_call_control_id });

    await h.legEvent(String(call.partyLeg.telnyx_call_control_id), "call.hangup", { hangup_cause: "normal_clearing" });
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: PROFILES.o1 });
    expect(h.rows("motorist_audit_log").map((row) => row.action)).toContain("telephony.conference.remove_party");
  });

  it("refuses a participant that already left", async () => {
    const h = createTelephonyHarness();
    const call = await threeWay(h);
    await h.legEvent(String(call.partyLeg.telnyx_call_control_id), "call.hangup", { hangup_cause: "normal_clearing" });
    expect(await fail(removeCallParty(actionDeps(h), o1, call.sessionId, String(call.partyLeg.id)))).toMatchObject({ status: 404, code: "party_not_found" });
  });

  it("restores the mute flag when Telnyx refuses the command", async () => {
    const h = createTelephonyHarness();
    const call = await threeWay(h);
    h.telnyx.failNext("conference:mute", new TelnyxCommandError({ code: "conference_not_found", status: 422, detail: "gone" }));

    const error = await fail(setCallPartyMuted(actionDeps(h), o1, call.sessionId, String(call.partyLeg.id), true));
    expect(error.status).toBe(502);
    expect(h.legs(call.sessionId).find((leg) => leg.id === call.partyLeg.id)!.metadata).toMatchObject({ muted: false });
    expect(h.session(call.sessionId).state).toBe("conference");
  });
});

describe("leaveConferenceCall", () => {
  it("hands the caller to the remaining party and releases the operator", async () => {
    const h = createTelephonyHarness();
    const call = await threeWay(h);

    const result = await leaveConferenceCall(actionDeps(h), o1, call.sessionId);
    expect(result.state).toBe("talking");
    expect(h.telnyx.of("conference:leave").at(-1)!.params).toMatchObject({ call_control_id: call.operatorLeg });
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: null });
    expect(h.session(call.sessionId).metadata).toMatchObject({ previous_operator: PROFILES.o1 });

    await h.legEvent(call.operatorLeg, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(h.presence(PROFILES.o1).status).toBe("after_call_work");
    // The caller and the third party are still up.
    expect(h.legs(call.sessionId).filter((leg) => !leg.ended_at)).toHaveLength(2);
    expect(h.rows("motorist_audit_log").map((row) => row.action)).toContain("telephony.conference.leave");
  });

  it("hands over to a colleague, who becomes the owner of the call", async () => {
    const h = createTelephonyHarness();
    const call = await talkingWith(h);
    await addCallParty(actionDeps(h), o1, call.sessionId, { profileId: PROFILES.o2 });
    // `legFor` would find the ring-offer leg that already ended.
    const party = h.openLegFor(call.sessionId, PROFILES.o2)!;
    await h.legEvent(String(party.telnyx_call_control_id), "call.answered");

    await leaveConferenceCall(actionDeps(h), o1, call.sessionId);
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: PROFILES.o2 });
    expect(h.call(call.sessionId)).toMatchObject({ operator_id: PROFILES.o2 });
    expect(h.presence(PROFILES.o2)).toMatchObject({ status: "on_call", current_session_id: call.sessionId });
  });

  it("refuses to leave a call nobody else is on", async () => {
    const h = createTelephonyHarness();
    const call = await talkingWith(h);
    expect(await fail(leaveConferenceCall(actionDeps(h), o1, call.sessionId))).toMatchObject({ status: 409 });
  });

  it("keeps the operator on the call when the conference command is rejected", async () => {
    const h = createTelephonyHarness();
    const call = await threeWay(h);
    h.telnyx.failNext("conference:leave", new TelnyxCommandError({ code: "call_not_participant", status: 422, detail: "nope" }));

    const error = await fail(leaveConferenceCall(actionDeps(h), o1, call.sessionId));
    expect(error.status).toBe(502);
    expect(h.session(call.sessionId)).toMatchObject({ state: "conference", answered_by_profile_id: PROFILES.o1 });
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "on_call", current_session_id: call.sessionId });
    // The hangup that would have followed never ran.
    expect(h.telnyx.of("hangup").some((command) => command.params.callControlId === call.operatorLeg)).toBe(false);
  });

  it("hands the call over when the operator's own leg simply dies", async () => {
    const h = createTelephonyHarness();
    const call = await threeWay(h);
    await h.legEvent(call.operatorLeg, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "callee" });
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: null });
    expect(h.session(call.sessionId).metadata).toMatchObject({ previous_operator: PROFILES.o1 });
    expect(h.presence(PROFILES.o1).status).toBe("after_call_work");
  });
});

describe("superviseCall", () => {
  it("refuses a dispatcher and a senior dispatcher", async () => {
    const h = createTelephonyHarness();
    giveSupervisorDevice(h);
    const call = await talkingWith(h);
    expect(await fail(superviseCall(actionDeps(h), o2, call.sessionId, "monitor"))).toMatchObject({ status: 403, code: "forbidden" });
    expect(await fail(superviseCall(actionDeps(h), senior, call.sessionId, "whisper"))).toMatchObject({ status: 403, code: "forbidden" });
    expect(h.telnyx.of("dial").filter((command) => String(command.params.clientState ?? "").length > 0).length).toBeGreaterThan(0);
    expect(h.legs(call.sessionId).some((leg) => leg.role === "supervisor")).toBe(false);
    expect(h.rows("motorist_audit_log")).toHaveLength(0);
  });

  it.each([
    ["monitor", undefined],
    ["whisper", true],
    ["barge", undefined],
  ] as const)("joins the conference as %s", async (mode, whispers) => {
    const h = createTelephonyHarness();
    giveSupervisorDevice(h);
    const call = await talkingWith(h);

    const result = await superviseCall(actionDeps(h), manager, call.sessionId, mode);
    expect(result.state).toBe("talking");
    const dial = h.telnyx.of("dial").at(-1)!.params;
    expect(dial).toMatchObject({ to: SUPERVISOR_SIP, linkTo: call.callControlId });
    const supervisorLeg = h.legFor(call.sessionId, PROFILES.o4)!;
    expect(supervisorLeg.role).toBe("supervisor");

    await h.legEvent(String(supervisorLeg.telnyx_call_control_id), "call.answered");
    const join = h.telnyx.of("conference:join").at(-1)!.params;
    expect(join).toMatchObject({ call_control_id: supervisorLeg.telnyx_call_control_id, supervisor_role: mode });
    expect(join.whisper_call_control_ids).toEqual(whispers ? [call.operatorLeg] : undefined);
    // Supervision never moves the supervised call.
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: PROFILES.o1 });
    expect(h.legs(call.sessionId).find((leg) => leg.id === supervisorLeg.id)!.metadata).toMatchObject({ supervisor_mode: mode });
    expect(h.rows("motorist_audit_log")).toEqual([
      expect.objectContaining({ action: "telephony.supervise.start", actor_profile_id: PROFILES.o4, after_payload: expect.objectContaining({ mode }) }),
    ]);
  });

  it("switches the mode of a live supervision through conference update", async () => {
    const h = createTelephonyHarness();
    giveSupervisorDevice(h);
    const call = await talkingWith(h);
    await superviseCall(actionDeps(h), manager, call.sessionId, "monitor");
    const supervisorLeg = h.legFor(call.sessionId, PROFILES.o4)!;
    await h.legEvent(String(supervisorLeg.telnyx_call_control_id), "call.answered");

    await superviseCall(actionDeps(h), manager, call.sessionId, "whisper");
    expect(h.telnyx.of("dial").filter((command) => command.params.to === SUPERVISOR_SIP)).toHaveLength(1);
    expect(h.telnyx.of("conference:update").at(-1)!.params).toMatchObject({
      call_control_id: supervisorLeg.telnyx_call_control_id,
      supervisor_role: "whisper",
      whisper_call_control_ids: [call.operatorLeg],
    });
    expect(h.session(call.sessionId).metadata).toMatchObject({ supervise: { [PROFILES.o4]: { mode: "whisper" } } });
    expect(h.rows("motorist_audit_log").map((row) => row.action)).toEqual(["telephony.supervise.start", "telephony.supervise.switch"]);
  });

  it("keeps the previous mode when the switch is rejected", async () => {
    const h = createTelephonyHarness();
    giveSupervisorDevice(h);
    const call = await talkingWith(h);
    await superviseCall(actionDeps(h), manager, call.sessionId, "monitor");
    const supervisorLeg = h.legFor(call.sessionId, PROFILES.o4)!;
    await h.legEvent(String(supervisorLeg.telnyx_call_control_id), "call.answered");
    h.telnyx.failNext("conference:update", new TelnyxCommandError({ code: "invalid_supervisor_role", status: 422, detail: "no" }));

    expect(await fail(superviseCall(actionDeps(h), manager, call.sessionId, "barge"))).toMatchObject({ status: 502 });
    expect(h.session(call.sessionId).metadata).toMatchObject({ supervise: { [PROFILES.o4]: { mode: "monitor" } } });
    expect(h.session(call.sessionId).state).toBe("talking");
  });

  it("hangs the supervisor leg up and forgets the supervision when the join is refused", async () => {
    const h = createTelephonyHarness();
    giveSupervisorDevice(h);
    const call = await talkingWith(h);
    await superviseCall(actionDeps(h), manager, call.sessionId, "monitor");
    const supervisorLeg = h.legFor(call.sessionId, PROFILES.o4)!;
    h.telnyx.failNext("conference:join", new TelnyxCommandError({ code: "conference_full", status: 422, detail: "full" }));

    await h.legEvent(String(supervisorLeg.telnyx_call_control_id), "call.answered");
    expect(h.telnyx.of("hangup").at(-1)!.params).toMatchObject({ callControlId: supervisorLeg.telnyx_call_control_id });
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: PROFILES.o1 });
    expect(h.session(call.sessionId).metadata).toMatchObject({ supervise: null });
  });

  it("refuses supervision of the supervisor's own call and of a call that is not live", async () => {
    const h = createTelephonyHarness();
    giveSupervisorDevice(h);
    h.setPresence(PROFILES.o4, { status: "available", current_session_id: null });
    // The manager's own outbound call: they are the operator, not a supervisor.
    const own = await startOutboundCall(actionDeps(h), manager, { to: "+421905123456" });
    await h.legEvent(own.operatorLegCallControlId, "call.answered");
    await h.legEvent("cc-2", "call.answered", { direction: "outgoing" });
    expect(h.session(own.sessionId).state).toBe("talking");
    expect(await fail(superviseCall(actionDeps(h), manager, own.sessionId, "monitor"))).toMatchObject({ status: 409, code: "own_call" });

    const other = await talkingWith(h, PROFILES.o1);
    h.db.update("motorist_call_sessions", { state: "wrap_up" }, (row) => row.id === other.sessionId);
    expect(await fail(superviseCall(actionDeps(h), manager, other.sessionId, "monitor"))).toMatchObject({ status: 409, code: "not_active" });
  });

  it("ends supervision without touching the call", async () => {
    const h = createTelephonyHarness();
    giveSupervisorDevice(h);
    const call = await talkingWith(h);
    await superviseCall(actionDeps(h), manager, call.sessionId, "barge");
    const supervisorLeg = h.legFor(call.sessionId, PROFILES.o4)!;
    await h.legEvent(String(supervisorLeg.telnyx_call_control_id), "call.answered");

    await stopSupervisingCall(actionDeps(h), manager, call.sessionId);
    expect(h.telnyx.of("hangup").at(-1)!.params).toMatchObject({ callControlId: supervisorLeg.telnyx_call_control_id });
    await h.legEvent(String(supervisorLeg.telnyx_call_control_id), "call.hangup", { hangup_cause: "normal_clearing" });

    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: PROFILES.o1 });
    expect(h.session(call.sessionId).metadata).toMatchObject({ supervise: null });
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "on_call", current_session_id: call.sessionId });
    expect(h.rows("motorist_audit_log").map((row) => row.action)).toEqual(["telephony.supervise.start", "telephony.supervise.stop"]);
    expect(await fail(stopSupervisingCall(actionDeps(h), manager, call.sessionId))).toMatchObject({ status: 409 });
  });

  it("leaves the supervisor available when the supervised call ends", async () => {
    const h = createTelephonyHarness();
    giveSupervisorDevice(h);
    const call = await talkingWith(h);
    await superviseCall(actionDeps(h), manager, call.sessionId, "monitor");
    const supervisorLeg = h.legFor(call.sessionId, PROFILES.o4)!;
    await h.legEvent(String(supervisorLeg.telnyx_call_control_id), "call.answered");

    // The caller hangs up: every remaining leg, the supervisor's included, is torn down.
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(h.telnyx.of("hangup").map((command) => command.params.callControlId)).toContain(supervisorLeg.telnyx_call_control_id);
    await h.legEvent(String(supervisorLeg.telnyx_call_control_id), "call.hangup", { hangup_cause: "normal_clearing" });

    // The operator who actually took the call gets the wrap-up; the supervisor,
    // who only listened, goes straight back into the ring plan.
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "after_call_work" });
    expect(h.presence(PROFILES.o4)).toMatchObject({ status: "available", current_session_id: null, wrap_up_until: null });
  });

  it("refuses supervision when the supervisor's own phone is not connected", async () => {
    const h = createTelephonyHarness();
    giveSupervisorDevice(h);
    const call = await talkingWith(h);
    h.touchDevice(PROFILES.o4, 300_000);
    expect(await fail(superviseCall(actionDeps(h), manager, call.sessionId, "monitor"))).toMatchObject({ status: 409, code: "device_offline" });
  });
});
