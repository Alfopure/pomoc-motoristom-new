import { describe, expect, it } from "vitest";

import { TELEPHONY_NOT_CONFIGURED_MESSAGE } from "@/lib/telephony/not-configured";
import { createTelephonyHarness, LINES, NUMBERS, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";

import {
  blindTransfer,
  callColleague,
  CallActionError,
  cancelConsult,
  completeTransfer,
  createRateLimiter,
  hangupCall,
  holdCall,
  isDestinationAllowed,
  listTransferTargets,
  parkCall,
  pickupWaitingCall,
  startConsult,
  startOutboundCall,
  unholdCall,
  type CallActionDeps,
  type CallActor,
} from "./call-actions";
import { TelnyxCommandError } from "./telnyx/client";
import { getTelnyxConfig } from "./telnyx/env";

const o1: CallActor = { profileId: PROFILES.o1, role: "dispatcher", displayName: "Jana" };
const o2: CallActor = { profileId: PROFILES.o2, role: "dispatcher", displayName: "Peter" };
const senior: CallActor = { profileId: PROFILES.o3, role: "senior_dispatcher" };

function actionDeps(h: TelephonyHarness, overrides: Partial<CallActionDeps> = {}): CallActionDeps {
  return { ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }), ...overrides };
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
    if (leg.role !== "customer" && leg.profile_id !== operator) await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup", { hangup_cause: "originator_cancel" });
  }
  expect(h.session(call.sessionId).state).toBe("talking");
  return { ...call, operatorLeg: String(winner.telnyx_call_control_id) };
}

describe("isDestinationAllowed", () => {
  it("accepts country codes, explicit prefixes and wildcards", () => {
    expect(isDestinationAllowed("+421905123456", ["SK", "CZ"])).toBe(true);
    expect(isDestinationAllowed("+420605123456", ["SK", "CZ"])).toBe(true);
    expect(isDestinationAllowed("+49151123456", ["SK", "CZ"])).toBe(false);
    expect(isDestinationAllowed("+49151123456", ["+4915"])).toBe(true);
    expect(isDestinationAllowed("+1555", ["*"])).toBe(true);
    expect(isDestinationAllowed("+421905123456", [])).toBe(false);
    expect(isDestinationAllowed("+421905123456", null)).toBe(false);
  });
});

describe("startOutboundCall", () => {
  it("returns 503 when telephony is not configured", async () => {
    const h = createTelephonyHarness();
    const error = await fail(startOutboundCall(actionDeps(h, { telnyx: null, config: getTelnyxConfig({}) }), o1, { to: "0905123456" }));
    expect(error).toMatchObject({ status: 503, message: TELEPHONY_NOT_CONFIGURED_MESSAGE });
    expect(h.rows("motorist_call_sessions")).toHaveLength(0);
  });

  it("creates the session, reserves the operator and dials their WebRTC leg with auto-answer", async () => {
    const h = createTelephonyHarness();
    const result = await startOutboundCall(actionDeps(h), o1, { to: "0905 123 456", caseId: "00000000-0000-4000-8000-000000000801" });
    expect(result).toMatchObject({ to: "+421905123456", from: NUMBERS.allianz, operatorLegCallControlId: "cc-1" });

    const session = h.session(result.sessionId);
    expect(session).toMatchObject({ direction: "outbound", state: "received", answered_by_profile_id: PROFILES.o1, caller_number: NUMBERS.allianz, called_number: "+421905123456", line_id: LINES.allianz, case_id: "00000000-0000-4000-8000-000000000801", telnyx_session_id: "tsess-cc-1" });
    const dial = h.telnyx.of("dial")[0].params;
    expect(dial).toMatchObject({ to: "sip:gencred001@sip.telnyx.com", from: NUMBERS.allianz, sipRegion: "Europe", mediaEncryption: "SRTP", customHeaders: [{ name: "X-PM-Auto-Answer", value: "1" }], fromDisplayName: "Jana" });
    expect(h.legs(result.sessionId)).toEqual([expect.objectContaining({ role: "operator", profile_id: PROFILES.o1, telnyx_call_control_id: "cc-1", client_state: expect.objectContaining({ intent: "outbound", autoAnswer: true }) })]);
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "on_call", current_session_id: result.sessionId });
    expect(h.call(result.sessionId)).toMatchObject({ status: "outbound", direction: "outbound", destination_number: "+421905123456", operator_id: PROFILES.o1 });
  });

  it("drives the outbound call to completion through the webhooks", async () => {
    const h = createTelephonyHarness();
    const result = await startOutboundCall(actionDeps(h), o1, { to: "+421905123456" });
    const own = result.operatorLegCallControlId;

    await h.legEvent(own, "call.initiated", { direction: "outgoing", state: "bridging" });
    await h.legEvent(own, "call.answered");
    expect(h.session(result.sessionId).state).toBe("ringing");
    const customerDial = h.telnyx.of("dial")[1].params;
    expect(customerDial).toMatchObject({ to: "+421905123456", from: NUMBERS.allianz, linkTo: own, timeoutSecs: 45 });
    expect(h.telnyx.of("bridge")[0].params).toMatchObject({ callControlId: own, targetCallControlId: "cc-2", playRingtone: true, ringtone: "cz" });
    const customerLeg = h.legs(result.sessionId).find((leg) => leg.role === "customer")!;
    expect(customerLeg.telnyx_call_control_id).toBe("cc-2");

    await h.legEvent("cc-2", "call.answered", { direction: "outgoing" });
    expect(h.session(result.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: PROFILES.o1 });
    expect(h.call(result.sessionId)).toMatchObject({ status: "answered" });

    h.advance(45_000);
    await h.legEvent("cc-2", "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "callee" });
    expect(h.session(result.sessionId).state).toBe("wrap_up");
    expect(h.presence(PROFILES.o1).status).toBe("after_call_work");
    await h.legEvent(own, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(h.session(result.sessionId).state).toBe("ended");
    expect(h.call(result.sessionId)).toMatchObject({ status: "ended", duration_seconds: 45, end_reason: "caller_hangup" });
  });

  it("lets the operator cancel an outbound call before their own leg answers", async () => {
    const h = createTelephonyHarness();
    const result = await startOutboundCall(actionDeps(h), o1, { to: "+421905123456" });
    const cancelled = await hangupCall(actionDeps(h), o1, result.sessionId);
    expect(cancelled.state).toBe("ended");
    expect(h.telnyx.of("hangup").at(-1)?.params.callControlId).toBe(result.operatorLegCallControlId);
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "available", current_session_id: null });
    expect(h.call(result.sessionId)).toMatchObject({ status: "ended", end_reason: "operator_hangup" });
  });

  it("ends the session when the customer never answers", async () => {
    const h = createTelephonyHarness();
    const result = await startOutboundCall(actionDeps(h), o1, { to: "+421905123456" });
    await h.legEvent(result.operatorLegCallControlId, "call.answered");
    await h.legEvent("cc-2", "call.hangup", { hangup_cause: "user_busy", direction: "outgoing" });
    expect(h.session(result.sessionId).state).toBe("ended");
    expect(h.call(result.sessionId)).toMatchObject({ status: "ended", end_reason: "busy" });
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "available", current_session_id: null });
  });

  it("rate-limits an operator to 10 dials per minute", async () => {
    const h = createTelephonyHarness();
    const deps = actionDeps(h);
    for (let index = 0; index < 10; index += 1) {
      const result = await startOutboundCall(deps, o1, { to: "+421905123456" });
      // Release the operator for the next call.
      h.setPresence(PROFILES.o1, { status: "available", current_session_id: null });
      h.db.update("motorist_call_sessions", { state: "ended" }, (row) => row.id === result.sessionId);
    }
    const error = await fail(startOutboundCall(deps, o1, { to: "+421905123456" }));
    expect(error).toMatchObject({ status: 429, code: "rate_limited" });
    h.advance(61_000);
    await expect(startOutboundCall(deps, o1, { to: "+421905123456" })).resolves.toBeTruthy();
  });

  it("counts every dialled leg and refuses new outbound calls over the daily soft cap", async () => {
    const h = createTelephonyHarness();
    const deps = actionDeps(h);

    await startOutboundCall(deps, o1, { to: "+421905123456" });
    expect(h.rows("motorist_telephony_daily_usage")).toEqual([expect.objectContaining({ legs: 1 })]);

    h.db.update("motorist_telephony_settings", { daily_leg_soft_cap: 1 }, () => true);
    h.setPresence(PROFILES.o1, { status: "available", current_session_id: null });
    const error = await fail(startOutboundCall(deps, o1, { to: "+421905123456" }));
    expect(error).toMatchObject({ status: 429, code: "daily_cap_reached" });
  });

  it("refuses destinations outside the allowlist and invalid numbers", async () => {
    const h = createTelephonyHarness();
    expect(await fail(startOutboundCall(actionDeps(h), o1, { to: "+49 151 123456" }))).toMatchObject({ status: 403, code: "destination_not_allowed" });
    expect(await fail(startOutboundCall(actionDeps(h), o1, { to: "abc" }))).toMatchObject({ status: 400, code: "invalid_number" });
    expect(h.telnyx.of("dial")).toHaveLength(0);
  });

  it("refuses when the operator's browser phone is not live or missing", async () => {
    const h = createTelephonyHarness();
    h.touchDevice(PROFILES.o1, 300_000);
    expect(await fail(startOutboundCall(actionDeps(h), o1, { to: "+421905123456" }))).toMatchObject({ status: 409, code: "device_offline" });
    expect(await fail(startOutboundCall(actionDeps(h), senior, { to: "+421905123456" }))).toMatchObject({ status: 409, code: "device_offline" });
  });

  it("refuses an operator who is already on a call", async () => {
    const h = createTelephonyHarness();
    h.setPresence(PROFILES.o1, { status: "on_call", current_session_id: "00000000-0000-4000-8000-00000000ffff" });
    expect(await fail(startOutboundCall(actionDeps(h), o1, { to: "+421905123456" }))).toMatchObject({ status: 409, code: "operator_busy" });
    expect(h.rows("motorist_call_sessions")[0].state).toBe("failed");
  });

  it("fails closed with 423 when the kill switch is off and releases the reservation", async () => {
    const h = createTelephonyHarness({ liveCalls: false });
    const error = await fail(startOutboundCall(actionDeps(h), o1, { to: "+421905123456" }));
    expect(error).toMatchObject({ status: 423, code: "live_calls_disabled" });
    expect(h.telnyx.of("dial")).toHaveLength(0);
    expect(h.rows("motorist_call_sessions")[0].state).toBe("failed");
    expect(h.call(String(h.rows("motorist_call_sessions")[0].id))).toMatchObject({ status: "failed", end_reason: "live_calls_disabled" });
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "available", current_session_id: null });
  });
});

describe("callColleague", () => {
  it("dials the caller first, then the colleague, and bridges on answer", async () => {
    const h = createTelephonyHarness();
    const result = await callColleague(actionDeps(h), o1, { targetProfileId: PROFILES.o2 });
    expect(h.session(result.sessionId)).toMatchObject({ direction: "internal", state: "received" });
    await h.legEvent(result.operatorLegCallControlId, "call.answered");
    expect(h.telnyx.of("dial")[1].params).toMatchObject({ to: "sip:gencred002@sip.telnyx.com", linkTo: result.operatorLegCallControlId, timeoutSecs: 30 });
    const callee = h.legFor(result.sessionId, PROFILES.o2)!;
    await h.legEvent(String(callee.telnyx_call_control_id), "call.answered");
    expect(h.session(result.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: PROFILES.o1 });
    expect(h.presence(PROFILES.o2)).toMatchObject({ status: "on_call", current_session_id: result.sessionId });
    expect(await fail(callColleague(actionDeps(h), o1, { targetProfileId: PROFILES.o1 }))).toMatchObject({ status: 400 });
    expect(await fail(callColleague(actionDeps(h), o2, { targetProfileId: PROFILES.o4 }))).toMatchObject({ status: 409, code: "target_unavailable" });
  });
});

describe("ownership", () => {
  it("lets the answering operator or a senior control the call, not another dispatcher", async () => {
    const h = createTelephonyHarness();
    const call = await talkingWith(h);
    expect(await fail(holdCall(actionDeps(h), o2, call.sessionId))).toMatchObject({ status: 403, code: "forbidden" });
    await expect(holdCall(actionDeps(h), senior, call.sessionId)).resolves.toMatchObject({ state: "held" });
    await expect(unholdCall(actionDeps(h), o1, call.sessionId)).resolves.toMatchObject({ state: "talking" });
    expect(await fail(holdCall(actionDeps(h), o1, "00000000-0000-4000-8000-00000000dead"))).toMatchObject({ status: 404 });
  });
});

describe("hold / unhold", () => {
  it("promotes to a conference lazily and holds the customer with music", async () => {
    const h = createTelephonyHarness();
    const call = await talkingWith(h);
    const held = await holdCall(actionDeps(h), o1, call.sessionId);
    expect(held.state).toBe("held");
    // The operator leg creates the conference (it is the leg the bridge does not
    // protect with `park_after_unbridge`); the customer joins it.
    expect(h.telnyx.of("createConference")[0].params).toMatchObject({ callControlId: call.operatorLeg, name: `sess-${call.sessionId}`, startConferenceOnCreate: true });
    const conferenceId = String(h.session(call.sessionId).conference_id);
    expect(conferenceId).toMatch(/^conf-/);
    expect(h.telnyx.of("conference:join")[0].params).toMatchObject({ conferenceId, call_control_id: call.callControlId });
    expect(h.telnyx.of("conference:hold")[0].params).toMatchObject({ conferenceId, call_control_ids: [call.callControlId], audio_url: "https://media.test/telephony/moh.mp3" });
    expect(h.session(call.sessionId)).toMatchObject({ state: "held", conference_id: conferenceId });
    expect(h.session(call.sessionId).hold_started_at).toBe(h.now().toISOString());

    await unholdCall(actionDeps(h), o1, call.sessionId);
    expect(h.telnyx.of("conference:unhold")[0].params).toMatchObject({ call_control_ids: [call.callControlId] });
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", hold_started_at: null, conference_id: conferenceId });
    // Second hold reuses the conference.
    await holdCall(actionDeps(h), o1, call.sessionId);
    expect(h.telnyx.of("createConference")).toHaveLength(1);
    expect(await fail(holdCall(actionDeps(h), o1, call.sessionId))).toMatchObject({ status: 409 });
  });

  it("keeps the call bridged and reports 502 when the conference cannot be created", async () => {
    const h = createTelephonyHarness();
    const call = await talkingWith(h);
    h.telnyx.failNext("createConference", "conference limit");
    const error = await fail(holdCall(actionDeps(h), o1, call.sessionId));
    expect(error).toMatchObject({ status: 502, code: "command_failed" });
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", conference_id: null, hold_started_at: null });
    expect(h.telnyx.of("conference:hold")).toHaveLength(0);
  });
});

describe("park / pickup", () => {
  it("parks the customer with music, releases the operator and lets a colleague pick up", async () => {
    const h = createTelephonyHarness();
    const call = await talkingWith(h);
    const parked = await parkCall(actionDeps(h), o1, call.sessionId);
    expect(parked.state).toBe("parked");
    expect(h.telnyx.of("hangup").at(-1)?.params.callControlId).toBe(call.operatorLeg);
    expect(h.telnyx.of("playbackStart").at(-1)?.params).toMatchObject({ callControlId: call.callControlId, audioUrl: "https://media.test/telephony/moh.mp3", loop: "infinity" });
    expect(h.telnyx.of("gather").at(-1)?.params).toMatchObject({ callControlId: call.callControlId, timeoutMillis: 60_000 });
    expect(h.session(call.sessionId)).toMatchObject({ state: "parked", answered_by_profile_id: null });
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "after_call_work", current_session_id: null });
    await h.legEvent(call.operatorLeg, "call.hangup", { hangup_cause: "normal_clearing" });

    expect(await fail(pickupWaitingCall(actionDeps(h), senior, call.sessionId))).toMatchObject({ status: 409 });
    const picked = await pickupWaitingCall(actionDeps(h), o2, call.sessionId);
    expect(picked.state).toBe("parked");
    const dial = h.telnyx.of("dial").at(-1)!.params;
    expect(dial).toMatchObject({ to: "sip:gencred002@sip.telnyx.com", linkTo: call.callControlId, customHeaders: [{ name: "X-PM-Auto-Answer", value: "1" }] });
    const pickerLeg = h.openLegFor(call.sessionId, PROFILES.o2)!;
    await h.legEvent(String(pickerLeg.telnyx_call_control_id), "call.answered");
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: PROFILES.o2 });
    expect(h.telnyx.of("gatherStop")).toHaveLength(1);
    expect(h.telnyx.of("bridge").at(-1)?.params).toMatchObject({ callControlId: call.callControlId, targetCallControlId: pickerLeg.telnyx_call_control_id, parkAfterUnbridge: "self" });
    expect(h.presence(PROFILES.o2).status).toBe("on_call");
    expect(h.call(call.sessionId)).toMatchObject({ status: "answered", operator_id: PROFILES.o2 });
  });
});

describe("transfers", () => {
  it("blind-transfers to a colleague and attributes the answer to them", async () => {
    const h = createTelephonyHarness();
    const call = await talkingWith(h);
    const result = await blindTransfer(actionDeps(h), o1, call.sessionId, { profileId: PROFILES.o2 });
    expect(result.state).toBe("ringing");
    const transfer = h.telnyx.of("transfer")[0].params;
    expect(transfer).toMatchObject({ callControlId: call.callControlId, to: "sip:gencred002@sip.telnyx.com", from: NUMBERS.allianz, parkAfterUnbridge: "self", timeoutSecs: 30 });
    expect(h.telnyx.of("hangup").at(-1)?.params.callControlId).toBe(call.operatorLeg);
    expect(h.presence(PROFILES.o1).status).toBe("after_call_work");

    // Telnyx creates the target leg with target_leg_client_state.
    await h.process(h.envelope("call.initiated", { call_control_id: "cc-target", call_leg_id: "leg-target", call_session_id: call.telnyxSessionId, client_state: transfer.targetLegClientState, direction: "outgoing", to: "sip:gencred002@sip.telnyx.com" }));
    await h.legEvent("cc-target", "call.answered");
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: PROFILES.o2 });
    expect(h.presence(PROFILES.o2).status).toBe("on_call");
  });

  it("validates transfer targets: unknown, self, busy colleague, disallowed number", async () => {
    const h = createTelephonyHarness();
    const call = await talkingWith(h);
    expect(await fail(blindTransfer(actionDeps(h), o1, call.sessionId, { profileId: PROFILES.o1 }))).toMatchObject({ status: 400 });
    expect(await fail(blindTransfer(actionDeps(h), o1, call.sessionId, { profileId: PROFILES.o3 }))).toMatchObject({ status: 409, code: "target_unavailable" });
    expect(await fail(blindTransfer(actionDeps(h), o1, call.sessionId, { number: "+49 151 12345678" }))).toMatchObject({ status: 403 });
    expect(await fail(blindTransfer(actionDeps(h), o1, call.sessionId, { number: "+49151" }))).toMatchObject({ status: 400 });
    expect(await fail(blindTransfer(actionDeps(h), o1, call.sessionId, {}))).toMatchObject({ status: 400 });
    await expect(blindTransfer(actionDeps(h), o1, call.sessionId, { number: "0900 000 000" })).resolves.toMatchObject({ state: "ringing" });
    expect(h.telnyx.of("transfer")[0].params.to).toBe(NUMBERS.external);
  });

  it("moves the customer to the waiting room when the transfer target does not answer", async () => {
    const h = createTelephonyHarness();
    const call = await talkingWith(h);
    const result = await blindTransfer(actionDeps(h), o1, call.sessionId, { profileId: PROFILES.o2 });
    expect(result.state).toBe("ringing");
    const transfer = h.telnyx.of("transfer")[0].params;
    await h.process(h.envelope("call.initiated", { call_control_id: "cc-target", call_session_id: call.telnyxSessionId, client_state: transfer.targetLegClientState, direction: "outgoing" }));
    await h.legEvent("cc-target", "call.hangup", { hangup_cause: "timeout" });
    expect(h.session(call.sessionId).state).toBe("waiting");
    expect(h.telnyx.of("playbackStart").at(-1)?.params).toMatchObject({ audioUrl: "https://media.test/telephony/moh.mp3", loop: "infinity" });
  });

  it("runs an attended transfer: consult, join, complete", async () => {
    const h = createTelephonyHarness();
    const call = await talkingWith(h);
    const consult = await startConsult(actionDeps(h), o1, call.sessionId, { profileId: PROFILES.o2 });
    expect(consult.state).toBe("consulting");
    expect(h.telnyx.of("createConference")).toHaveLength(1);
    expect(h.telnyx.of("conference:hold")[0].params.call_control_ids).toEqual([call.callControlId]);
    const dial = h.telnyx.of("dial").at(-1)!.params;
    expect(dial).toMatchObject({ to: "sip:gencred002@sip.telnyx.com", linkTo: call.callControlId });
    const consultLeg = h.legs(call.sessionId).find((leg) => leg.role === "consult")!;
    expect(consultLeg.profile_id).toBe(PROFILES.o2);

    expect(await fail(completeTransfer(actionDeps(h), o1, call.sessionId))).toMatchObject({ status: 409 });
    await h.legEvent(String(consultLeg.telnyx_call_control_id), "call.answered");
    expect(h.telnyx.of("conference:join").at(-1)?.params.call_control_id).toBe(consultLeg.telnyx_call_control_id);
    expect(h.presence(PROFILES.o2).status).toBe("on_call");

    const completed = await completeTransfer(actionDeps(h), o1, call.sessionId);
    expect(completed.state).toBe("talking");
    expect(h.telnyx.of("conference:unhold").at(-1)?.params.call_control_ids).toEqual([call.callControlId]);
    expect(h.telnyx.of("hangup").at(-1)?.params.callControlId).toBe(call.operatorLeg);
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: PROFILES.o2 });
    expect(h.legs(call.sessionId).find((leg) => leg.telnyx_call_control_id === consultLeg.telnyx_call_control_id)?.role).toBe("operator");
    expect(h.presence(PROFILES.o1).status).toBe("after_call_work");
    expect(h.call(call.sessionId)?.operator_id).toBe(PROFILES.o2);
  });

  it("cancels a consult and returns to the customer", async () => {
    const h = createTelephonyHarness();
    const call = await talkingWith(h);
    await startConsult(actionDeps(h), o1, call.sessionId, { number: "0900 000 000" });
    const consultLeg = h.legs(call.sessionId).find((leg) => leg.role === "consult")!;
    const cancelled = await cancelConsult(actionDeps(h), o1, call.sessionId);
    expect(cancelled.state).toBe("talking");
    expect(h.telnyx.of("hangup").at(-1)?.params.callControlId).toBe(consultLeg.telnyx_call_control_id);
    expect(h.telnyx.of("conference:unhold").at(-1)?.params.call_control_ids).toEqual([call.callControlId]);
    await h.legEvent(String(consultLeg.telnyx_call_control_id), "call.hangup", { hangup_cause: "originator_cancel" });
    expect(h.session(call.sessionId).state).toBe("talking");
  });
});

describe("hangupCall", () => {
  it("hangs up every leg and moves the session to wrap-up", async () => {
    const h = createTelephonyHarness();
    const call = await talkingWith(h);
    const result = await hangupCall(actionDeps(h), o1, call.sessionId);
    expect(result.state).toBe("wrap_up");
    expect(h.telnyx.of("hangup").slice(-2).map((entry) => entry.params.callControlId).sort()).toEqual([call.callControlId, call.operatorLeg].sort());
    expect(h.presence(PROFILES.o1).status).toBe("after_call_work");
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing" });
    await h.legEvent(call.operatorLeg, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(h.session(call.sessionId).state).toBe("ended");
    expect(h.call(call.sessionId)).toMatchObject({ status: "ended", end_reason: "operator_hangup" });
    expect(await fail(hangupCall(actionDeps(h), o1, call.sessionId))).toMatchObject({ status: 409, code: "not_active" });
  });

  it("succeeds when Telnyx no longer knows the leg (the caller hung up a moment earlier)", async () => {
    const h = createTelephonyHarness();
    const call = await talkingWith(h);
    // 404/422 for a leg that already ended is the outcome we asked for, not a
    // failed transition: the operator must not see "Ukončenie hovoru zlyhalo".
    h.telnyx.failNext("hangup", new TelnyxCommandError({ code: "not_found", status: 404, detail: "Call has already ended" }));

    const result = await hangupCall(actionDeps(h), o1, call.sessionId);

    expect(result.state).toBe("wrap_up");
    expect(h.session(call.sessionId).state).toBe("wrap_up");
    expect(h.presence(PROFILES.o1).status).toBe("after_call_work");
  });
});

describe("listTransferTargets", () => {
  it("flags colleagues by presence and device liveness", async () => {
    const h = createTelephonyHarness();
    const targets = await listTransferTargets(actionDeps(h), o1);
    expect(targets.map((target) => [target.profileId, target.available, target.status])).toEqual([
      [PROFILES.o5, true, "available"],
      [PROFILES.o2, true, "available"],
      [PROFILES.o4, false, "offline"],
      [PROFILES.o3, false, "offline"],
    ]);
  });
});
