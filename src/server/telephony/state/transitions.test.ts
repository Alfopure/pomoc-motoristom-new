import { describe, expect, it } from "vitest";

import { createTelephonyHarness, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { completeAnnouncedAction } from "@/test/complete-call-announcements";
import { hangupCall, parkCall, pickupWaitingCall } from "../call-actions";

import { advanceRingStep, sweepOverdueRingSteps } from "../routing/ring-plan";
import { loadRoutingContext, loadSessionSnapshot, effectsDeps, runSessionEvent } from "../session-runner";
import { applyReduceResult, SessionConflictError } from "./effects";
import { reduce } from "./transitions";
import { emptyTransition, readMeta, type RingFanout, type SessionRow } from "./types";

/**
 * End-to-end reducer tests through the real pipeline (claim ledger → lease →
 * reducer → effects) on the fake Supabase and fake Telnyx.
 */

async function ringingInbound(h: TelephonyHarness, to: string = NUMBERS.allianz) {
  const call = await h.inbound({ to });
  const session = h.session(call.sessionId);
  expect(session.state).toBe("ringing");
  const o1 = h.legFor(call.sessionId, PROFILES.o1)!;
  const o2 = h.legFor(call.sessionId, PROFILES.o2)!;
  const o5 = h.legFor(call.sessionId, PROFILES.o5)!;
  return { ...call, o1: String(o1.telnyx_call_control_id), o2: String(o2.telnyx_call_control_id), o5: String(o5.telnyx_call_control_id) };
}

describe("inbound ring plan", () => {
  it("answers, plays greeting + MOH and fans out step 0 to registered available operators", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: "+4210232408718" });

    expect(call.results[0]).toMatchObject({ status: 200, outcome: "processed" });
    expect(h.telnyx.of("answer")).toHaveLength(1);
    const session = h.session(call.sessionId);
    expect(session).toMatchObject({ state: "ringing", direction: "inbound", caller_number: NUMBERS.customer, called_number: NUMBERS.allianz, current_step: 1 });
    expect(session.line_id).toBe("00000000-0000-4000-8000-000000000202");
    expect((session.metadata as { partner_name: string }).partner_name).toBe("Allianz Assistance");

    const playbacks = h.telnyx.of("playbackStart").map((entry) => entry.params.audioUrl);
    expect(playbacks).toEqual(["https://media.test/telephony/announcements-v4/sk/greeting.mp3", "https://media.test/telephony/announcements-v1/moh.mp3"]);

    const dials = h.telnyx.of("dial");
    expect(dials.map((entry) => entry.params.to).sort()).toEqual(["sip:gencred001@sip.telnyx.com", "sip:gencred002@sip.telnyx.com", "sip:gencred003@sip.telnyx.com"]);
    expect(dials[0].params).toMatchObject({ from: NUMBERS.allianz, linkTo: call.callControlId, timeoutSecs: 20, sipRegion: "Europe", mediaEncryption: "SRTP" });

    const attempts = h.attempts(call.sessionId);
    expect(attempts).toHaveLength(3);
    expect(attempts.every((attempt) => attempt.result === "offered" && attempt.leg_id)).toBe(true);
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "ringing", current_session_id: call.sessionId });
    expect(h.presence(PROFILES.o3).status).toBe("offline");
    expect(h.call(call.sessionId)).toMatchObject({ status: "ringing_agent", direction: "inbound", line_id: "00000000-0000-4000-8000-000000000202" });
    expect(h.rows("motorist_telnyx_webhook_events").every((row) => row.status === "processed")).toBe(true);
  });

  it("treats call.bridged arriving before call.answered as the answer, once", async () => {
    const h = createTelephonyHarness();
    const call = await ringingInbound(h);

    const bridged = await h.legEvent(call.o1, "call.bridged");
    expect(bridged).toMatchObject({ outcome: "processed" });
    const session = h.session(call.sessionId);
    expect(session).toMatchObject({ state: "talking", answered_by_profile_id: PROFILES.o1 });
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "on_call", current_session_id: call.sessionId });
    // Already bridged by Telnyx → no bridge command, but MOH stopped and losers hung up.
    expect(h.telnyx.of("bridge")).toHaveLength(0);
    expect(h.telnyx.of("playbackStop")).toHaveLength(1);
    expect(h.telnyx.of("hangup").map((entry) => entry.params.callControlId).sort()).toEqual([call.o2, call.o5].sort());
    expect(h.presence(PROFILES.o2).status).toBe("available");
    expect(h.attempts(call.sessionId).map((attempt) => attempt.result).sort()).toEqual(["answered", "cancelled", "cancelled"]);

    const answered = await h.legEvent(call.o1, "call.answered");
    expect(answered).toMatchObject({ outcome: "ignored" });
    expect(h.telnyx.of("bridge")).toHaveLength(0);
    expect(h.session(call.sessionId).version).toBe(session.version);
  });

  it("bridges the winner from the customer leg with park_after_unbridge and records the call", async () => {
    const h = createTelephonyHarness();
    const call = await ringingInbound(h);
    await h.legEvent(call.o2, "call.answered");

    const bridge = h.telnyx.of("bridge");
    expect(bridge).toHaveLength(1);
    expect(bridge[0].params).toMatchObject({ callControlId: call.callControlId, targetCallControlId: call.o2, parkAfterUnbridge: "self" });
    expect(h.call(call.sessionId)).toMatchObject({ status: "answered", operator_id: PROFILES.o2, ring_group_id: "00000000-0000-4000-8000-000000002201" });
    expect(h.rows("motorist_ring_group_members").find((member) => member.profile_id === PROFILES.o2)?.last_answered_at).toBe(h.now().toISOString());
  });

  it("ignores a duplicate hangup event and a repeated hangup for the same leg", async () => {
    const h = createTelephonyHarness();
    const call = await ringingInbound(h);
    await h.legEvent(call.o1, "call.answered");

    for (const loser of [call.o2, call.o5]) await h.legEvent(loser, "call.hangup", { hangup_cause: "originator_cancel" });
    const first = await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "caller" }, "evt-hangup-1");
    expect(first).toMatchObject({ outcome: "processed" });
    expect(h.session(call.sessionId).state).toBe("wrap_up");
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "after_call_work" });
    expect(h.presence(PROFILES.o1).wrap_up_until).toBe(new Date(h.now().getTime() + 30_000).toISOString());
    const hangups = h.telnyx.of("hangup").length;

    const duplicate = await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing" }, "evt-hangup-1");
    expect(duplicate).toMatchObject({ outcome: "duplicate", status: 200 });
    const repeated = await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing" }, "evt-hangup-2");
    expect(repeated).toMatchObject({ outcome: "ignored" });
    expect(h.telnyx.of("hangup").length).toBe(hangups);

    await h.legEvent(call.o1, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "callee" });
    expect(h.session(call.sessionId).state).toBe("ended");
    expect(h.call(call.sessionId)).toMatchObject({ status: "ended", end_reason: "caller_hangup" });
    expect(h.rows("motorist_calls")).toHaveLength(1);
  });

  it("lets exactly one of two answering operators win; the second is hung up", async () => {
    const h = createTelephonyHarness();
    const call = await ringingInbound(h);

    await h.legEvent(call.o1, "call.answered");
    const late = await h.legEvent(call.o2, "call.answered");
    expect(late).toMatchObject({ outcome: "processed" });
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: PROFILES.o1 });
    expect(h.telnyx.of("bridge")).toHaveLength(1);
    expect(h.telnyx.of("hangup").filter((entry) => entry.params.callControlId === call.o2).length).toBeGreaterThanOrEqual(1);
    expect(h.attempts(call.sessionId).find((attempt) => attempt.profile_id === PROFILES.o2)?.result).toBe("cancelled");
    expect(h.presence(PROFILES.o2).status).toBe("available");
    expect(h.presence(PROFILES.o1).status).toBe("on_call");
  });

  it("hangs up an operator whose reservation fails because another session already holds them", async () => {
    const h = createTelephonyHarness();
    const call = await ringingInbound(h);
    // Meanwhile o1 was reserved by another session.
    h.setPresence(PROFILES.o1, { status: "on_call", current_session_id: "00000000-0000-4000-8000-00000000ffff" });

    await h.legEvent(call.o1, "call.answered");
    expect(h.session(call.sessionId)).toMatchObject({ state: "ringing", answered_by_profile_id: null });
    expect(h.telnyx.of("bridge")).toHaveLength(0);
    expect(h.telnyx.of("hangup").map((entry) => entry.params.callControlId)).toEqual([call.o1]);
    expect(h.attempts(call.sessionId).find((attempt) => attempt.profile_id === PROFILES.o1)?.result).toBe("cancelled");
    expect(h.presence(PROFILES.o1).current_session_id).toBe("00000000-0000-4000-8000-00000000ffff");
  });

  it("skips operators with an open offer in another session (second inbound call falls through to step 1)", async () => {
    const h = createTelephonyHarness();
    const first = await ringingInbound(h);
    const second = await h.inbound({ to: NUMBERS.allianz, callControlId: "cc-cust-2" });

    expect(h.session(second.sessionId).state).toBe("ringing");
    const secondAttempts = h.attempts(second.sessionId);
    expect(secondAttempts.map((attempt) => [attempt.step_index, attempt.member_kind, attempt.external_number])).toEqual([[1, "external_number", NUMBERS.external]]);
    expect(h.telnyx.of("dial").filter((entry) => entry.params.to === NUMBERS.external)).toHaveLength(1);
    expect(h.attempts(first.sessionId).every((attempt) => attempt.result === "offered")).toBe(true);
    expect(h.presence(PROFILES.o1).current_session_id).toBe(first.sessionId);
  });

  it("marks the call missed and records a callback when the customer hangs up while ringing", async () => {
    const h = createTelephonyHarness();
    const call = await ringingInbound(h);

    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "originator_cancel", hangup_source: "caller" });
    expect(h.session(call.sessionId).state).toBe("missed");
    expect(h.telnyx.of("hangup").map((entry) => entry.params.callControlId).sort()).toEqual([call.o1, call.o2, call.o5].sort());
    expect(h.attempts(call.sessionId).every((attempt) => attempt.result === "cancelled")).toBe(true);
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "available", current_session_id: null });
    expect(h.rows("motorist_callback_requests")).toEqual([expect.objectContaining({ source: "missed", caller_number: NUMBERS.customer, session_id: call.sessionId, status: "open" })]);
    expect(h.call(call.sessionId)).toMatchObject({ status: "missed", end_reason: "caller_hangup" });

    for (const leg of [call.o1, call.o2, call.o5]) await h.legEvent(leg, "call.hangup", { hangup_cause: "originator_cancel" });
    expect(h.session(call.sessionId).state).toBe("ended");
    expect(h.call(call.sessionId)?.status).toBe("missed");
    expect(h.rows("motorist_callback_requests")).toHaveLength(1);
  });

  it("does not attach an inbound call to a case from the caller number", async () => {
    const h = createTelephonyHarness();
    const call = await ringingInbound(h);
    expect(h.session(call.sessionId).case_id).toBeNull();
    expect(h.session(call.sessionId).metadata).not.toHaveProperty("match");
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "originator_cancel" });
    expect(h.rows("motorist_case_tasks")).toEqual([]);
  });

  it("advances through ordered step 1 to the external member and falls back to the callback prompt", async () => {
    const h = createTelephonyHarness();
    const call = await ringingInbound(h);

    for (const leg of [call.o1, call.o2]) await h.legEvent(leg, "call.hangup", { hangup_cause: "timeout" });
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(h.telnyx.of("dial")).toHaveLength(3);
    await h.legEvent(call.o5, "call.hangup", { hangup_cause: "timeout" });

    // Step 1 is ordered: o4/o3 offline → only the external number is dialed, for its own 15 s.
    const external = h.legByNumber(call.sessionId, NUMBERS.external)!;
    expect(external).toBeTruthy();
    expect(h.telnyx.of("dial").at(-1)?.params).toMatchObject({ to: NUMBERS.external, timeoutSecs: 15 });
    expect(h.session(call.sessionId)).toMatchObject({ current_step: 2 });
    expect(h.attempts(call.sessionId).filter((attempt) => attempt.step_index === 0).map((attempt) => attempt.result)).toEqual(["no_answer", "no_answer", "no_answer"]);

    await h.legEvent(String(external.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });
    const session = h.session(call.sessionId);
    expect(session.state).toBe("callback_offered");
    expect((session.metadata as { ring: { exhausted: boolean; fallback: string } }).ring).toMatchObject({ exhausted: true, fallback: "callback_prompt" });
    expect(h.telnyx.of("playbackStop")).toHaveLength(1);
    const gather = h.telnyx.of("gatherUsingAudio").at(-1)!;
    expect(gather.params).toMatchObject({ callControlId: call.callControlId, audioUrl: "https://media.test/telephony/announcements-v4/sk/callback-offer.mp3", validDigits: "1", maximumTries: 1 });

    await h.legEvent(call.callControlId, "call.gather.ended", { digits: "1", status: "valid", client_state: gather.params.clientState });
    expect(h.rows("motorist_callback_requests")).toEqual([expect.objectContaining({ source: "missed", status: "open" })]);
    expect(h.telnyx.of("playbackStart").at(-1)?.params.audioUrl).toBe("https://media.test/telephony/announcements-v4/sk/callback-confirmed.mp3");
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "completed", client_state: h.telnyx.of("playbackStart").at(-1)?.params.clientState });
    expect(h.telnyx.of("hangup").at(-1)?.params.callControlId).toBe(call.callControlId);
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "callee" });
    expect(h.session(call.sessionId).state).toBe("ended");
    expect(h.call(call.sessionId)).toMatchObject({ status: "ended", end_reason: "callback_requested" });
  });

  it("dials the external fallback number and offers a callback when it does not answer either", async () => {
    const h = createTelephonyHarness({ fallbackKind: "external_number" });
    const call = await ringingInbound(h);
    for (const leg of [call.o1, call.o2, call.o5]) await h.legEvent(leg, "call.hangup", { hangup_cause: "timeout" });

    // Step 1 (ordered) reaches the ring group's own external member first.
    const stepLeg = h.legByNumber(call.sessionId, NUMBERS.external)!;
    await h.legEvent(String(stepLeg.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });

    // The plan is exhausted: the synthetic fallback step (`stepIndex = steps.length`) dials the number.
    const fallbackLeg = h.legs(call.sessionId).find((leg) => leg.to_number === NUMBERS.external && !leg.ended_at)!;
    expect(fallbackLeg.telnyx_call_control_id).not.toBe(stepLeg.telnyx_call_control_id);
    expect(h.session(call.sessionId)).toMatchObject({ state: "ringing" });
    expect((h.session(call.sessionId).metadata as { ring: { fallback: string } }).ring.fallback).toBe("external_number");

    // Hanging that leg up used to crash the reducer: the active step points past
    // the last real plan step, so `planStep` had no step to read.
    const result = await h.legEvent(String(fallbackLeg.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });
    expect(result).toMatchObject({ outcome: "processed" });
    expect(h.session(call.sessionId).state).toBe("callback_offered");
    expect(h.telnyx.of("gatherUsingAudio").at(-1)?.params.audioUrl).toBe("https://media.test/telephony/announcements-v4/sk/callback-offer.mp3");
  });

  it("puts the caller into the waiting room when the plan's fallback is waiting_room", async () => {
    const h = createTelephonyHarness({ fallbackKind: "waiting_room" });
    const call = await ringingInbound(h);
    for (const leg of [call.o1, call.o2, call.o5]) await h.legEvent(leg, "call.hangup", { hangup_cause: "timeout" });
    const external = h.legByNumber(call.sessionId, NUMBERS.external)!;
    await h.legEvent(String(external.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });

    expect(h.session(call.sessionId).state).toBe("waiting");
    // Queue audio combines the reminder, callback choice and a minute of music.
    expect(h.telnyx.of("playbackStart").at(-1)?.params).toMatchObject({ audioUrl: "https://media.test/telephony/announcements-v1/moh.mp3", loop: "infinity" });
    const tick = h.telnyx.of("gatherUsingAudio").at(-1)!;
    // DTMF interrupts the audio; the timeout starts after the music finishes.
    expect(tick.params).toMatchObject({ timeoutMillis: 1_000, validDigits: "1", audioUrl: "https://media.test/telephony/announcements-v4/sk/queueWaiting.mp3" });
    const playbacksBefore = h.telnyx.of("playbackStart").length;

    // Ticks re-arm without touching the music; after park_max_minutes the caller gets the callback offer.
    h.advance(60_000);
    await h.legEvent(call.callControlId, "call.gather.ended", { status: "timeout", client_state: tick.params.clientState });
    expect(h.telnyx.of("gatherUsingAudio")).toHaveLength(2);
    expect(h.telnyx.of("playbackStart")).toHaveLength(playbacksBefore);
    h.advance(31 * 60_000);
    const currentTick = h.telnyx.of("gatherUsingAudio").at(-1)!;
    await h.legEvent(call.callControlId, "call.gather.ended", { status: "timeout", client_state: currentTick.params.clientState });
    expect(h.session(call.sessionId).state).toBe("callback_offered");
    expect(h.telnyx.of("gatherUsingAudio").at(-1)?.params.audioUrl).toBe("https://media.test/telephony/announcements-v4/sk/callback-offer.mp3");
    // The loop is silenced before the prompt plays.
    expect(h.telnyx.of("playbackStop").length).toBeGreaterThan(0);
  });

  it("tells a caller nobody could be rung apart from a plan that rang and got no answer", async () => {
    const h = createTelephonyHarness({ fallbackKind: "waiting_room" });
    // Operators only, as in the plan that met three callers on 17 Sep.
    h.db.delete("motorist_ring_group_members", row => row.member_kind === "external_number");
    for (const profileId of Object.values(PROFILES)) h.setPresence(profileId, { status: "offline" });

    const call = await h.inbound({ to: NUMBERS.allianz });

    // Nobody's phone rang: the plan had members and none of them was reachable.
    // Eight seconds into the waiting room on 17 Sep, this was indistinguishable
    // from a plan that had simply run out.
    expect(h.session(call.sessionId).state).toBe("waiting");
    expect(h.attempts(call.sessionId)).toEqual([]);
    expect(readMeta(h.session(call.sessionId) as SessionRow).waiting?.reason).toBe("no_operator_reachable");
  });

  it("still calls it ring_exhausted once somebody has actually been rung", async () => {
    const h = createTelephonyHarness({ fallbackKind: "waiting_room" });
    const call = await ringingInbound(h);
    for (const leg of [call.o1, call.o2, call.o5]) await h.legEvent(leg, "call.hangup", { hangup_cause: "timeout" });
    const external = h.legByNumber(call.sessionId, NUMBERS.external)!;
    await h.legEvent(String(external.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });

    expect(h.session(call.sessionId).state).toBe("waiting");
    expect(h.attempts(call.sessionId).length).toBeGreaterThan(0);
    expect(readMeta(h.session(call.sessionId) as SessionRow).waiting?.reason).toBe("ring_exhausted");
  });

  it("queues both kinds of exhaustion for automatic offers", async () => {
    const h = createTelephonyHarness({ fallbackKind: "waiting_room" });
    h.db.delete("motorist_ring_group_members", row => row.member_kind === "external_number");
    for (const profileId of Object.values(PROFILES)) h.setPresence(profileId, { status: "offline" });

    const call = await h.inbound({ to: NUMBERS.allianz });

    // The console is told something different; the caller is treated the same.
    expect(readMeta(h.session(call.sessionId) as SessionRow).queue).toBeTruthy();
  });

  it("keeps a caller who is already waiting on the limit that applied when they entered", async () => {
    const h = createTelephonyHarness({ fallbackKind: "waiting_room" });
    const call = await ringingInbound(h);
    for (const leg of [call.o1, call.o2, call.o5]) await h.legEvent(leg, "call.hangup", { hangup_cause: "timeout" });
    const external = h.legByNumber(call.sessionId, NUMBERS.external)!;
    await h.legEvent(String(external.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });
    expect(h.session(call.sessionId).state).toBe("waiting");

    // An admin lowers the waiting-room limit while the caller is in the queue.
    // `loadRoutingSettings` re-reads the row on every event, so without the
    // frozen `meta.waiting.max_minutes` the next tick would eject them — a
    // configuration change disturbing a call in progress.
    h.db.update("motorist_telephony_settings", { park_max_minutes: 5 }, () => true);
    const tick = h.telnyx.of("gatherUsingAudio").at(-1)!;
    h.advance(6 * 60_000);
    await h.legEvent(call.callControlId, "call.gather.ended", { status: "timeout", client_state: tick.params.clientState });
    // Six minutes of nobody to ring also spends the queue escalation on the
    // backup number, so the state here is `ringing` rather than `waiting`.
    // Either way the caller is still on the call, which is the point: the
    // lowered limit did not eject them.
    expect(h.session(call.sessionId).state).toBe("ringing");
    const escalation = h.legs(call.sessionId).find((leg) => leg.to_number === NUMBERS.external && !leg.ended_at)!;
    await h.legEvent(String(escalation.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });
    expect(h.session(call.sessionId).state).toBe("waiting");

    // The limit they arrived with (30 min) still ends the wait.
    const next = h.telnyx.of("gatherUsingAudio").at(-1)!;
    h.advance(25 * 60_000);
    await h.legEvent(call.callControlId, "call.gather.ended", { status: "timeout", client_state: next.params.clientState });
    expect(h.session(call.sessionId).state).toBe("callback_offered");
  });

  it("fans out a step exactly once when two invocations race on the same snapshot", async () => {
    const h = createTelephonyHarness();
    const call = await ringingInbound(h);
    for (const leg of [call.o1, call.o2]) await h.legEvent(leg, "call.hangup", { hangup_cause: "timeout" });

    // Two processors reduce the last hangup against the same snapshot.
    const snapshot = await loadSessionSnapshot(h.deps, call.sessionId);
    const context = await loadRoutingContext(h.deps, snapshot.session);
    const event = {
      kind: "telnyx" as const,
      id: "evt-race",
      type: "call.hangup",
      occurredAt: h.now().toISOString(),
      callControlId: call.o5,
      callLegId: null,
      callSessionId: call.telnyxSessionId,
      connectionId: "app-test",
      clientState: h.clientStateOf(call.o5),
      rawClientState: null,
      from: null,
      to: null,
      direction: null,
      state: null,
      hangupCause: "timeout",
      hangupSource: null,
      sipHangupCause: null,
      digits: null,
      status: null,
      conferenceId: null,
      customHeaders: [],
      payload: {},
    };
    const resultA = reduce(snapshot.session, snapshot.legs, snapshot.attempts, event, context);
    const resultB = reduce(snapshot.session, snapshot.legs, snapshot.attempts, { ...event, id: "evt-race-b" }, context);
    const fanoutA = resultA.commands.find((command): command is RingFanout => command.kind === "ring_fanout");
    expect(fanoutA).toMatchObject({ step: 1, guard: { expectedStep: 1, setStep: 2 } });
    expect(resultB.commands.some((command) => command.kind === "ring_fanout")).toBe(true);

    const effects = effectsDeps(h.deps);
    const applied = await applyReduceResult(effects, { session: snapshot.session, result: resultA, event, expectedVersion: snapshot.session.version });
    expect(applied.failed).toBe(false);
    await expect(applyReduceResult(effects, { session: snapshot.session, result: resultB, event: { ...event, id: "evt-race-b" }, expectedVersion: snapshot.session.version })).rejects.toBeInstanceOf(SessionConflictError);
    expect(h.telnyx.of("dial").filter((entry) => entry.params.to === NUMBERS.external)).toHaveLength(1);
    expect(h.attempts(call.sessionId).filter((attempt) => attempt.step_index === 1)).toHaveLength(1);

    // And the RPC guard alone refuses a second advance from the same expected step.
    expect(await advanceRingStep(h.admin, call.sessionId, 1)).toBe(false);
  });

  it("holds the ring step while the org is at the concurrent-leg cap and rings once capacity frees up", async () => {
    const h = createTelephonyHarness();
    // Nine open legs of another call: `max_concurrent_legs` is exhausted.
    const [other] = h.db.seed("motorist_call_sessions", [{ organization_id: ORG, direction: "inbound", state: "talking" }]);
    const blockers = h.db.seed(
      "motorist_call_legs",
      Array.from({ length: 9 }, (unused, index) => ({
        organization_id: ORG,
        session_id: other.id,
        telnyx_call_control_id: `cc-block-${index}`,
        role: "operator" as const,
        state: "answered",
        initiated_at: h.now().toISOString(),
      })),
    );

    const call = await h.inbound({ to: NUMBERS.allianz });
    const session = h.session(call.sessionId);
    expect(session.state).toBe("ringing");
    expect(session.current_step).toBe(0);
    expect((session.metadata as { ring: { capacity_wait_since: string | null } }).ring.capacity_wait_since).toBe(h.now().toISOString());
    expect(h.telnyx.of("dial")).toHaveLength(0);
    expect(h.rows("motorist_job_incidents")).toEqual([expect.objectContaining({ job_name: "telephony.routing.capacity" })]);

    // Capacity frees up; the sweep re-drives the same step instead of falling back.
    for (const leg of blockers) h.db.update("motorist_call_legs", { ended_at: h.now().toISOString(), state: "ended" }, (row) => row.id === leg.id);
    h.advance(6_000);
    const { sweepOverdueRingSteps } = await import("../routing/ring-plan");
    await sweepOverdueRingSteps({ admin: h.admin, organizationId: ORG, now: () => h.now(), runSessionEvent: (id, event) => runSessionEvent(h.deps, id, event) });

    expect(h.telnyx.of("dial").length).toBeGreaterThan(0);
    // The same step is re-fanned (no guard, so `current_step` stays where the hold left it).
    expect(h.session(call.sessionId)).toMatchObject({ state: "ringing", current_step: 0 });
    expect(h.attempts(call.sessionId).filter((attempt) => attempt.step_index === 0).length).toBeGreaterThan(0);
    expect((h.session(call.sessionId).metadata as { ring: { capacity_wait_since: string | null } }).ring.capacity_wait_since).toBeNull();
  });

  it("gives up the capacity wait after CAPACITY_WAIT_MAX_MS and falls back", async () => {
    const h = createTelephonyHarness();
    const [other] = h.db.seed("motorist_call_sessions", [{ organization_id: ORG, direction: "inbound", state: "talking" }]);
    h.db.seed(
      "motorist_call_legs",
      Array.from({ length: 9 }, (unused, index) => ({
        organization_id: ORG,
        session_id: other.id,
        telnyx_call_control_id: `cc-full-${index}`,
        role: "operator" as const,
        state: "answered",
        initiated_at: h.now().toISOString(),
      })),
    );
    const call = await h.inbound({ to: NUMBERS.allianz });
    expect(h.session(call.sessionId).state).toBe("ringing");

    h.advance(40_000);
    const { sweepOverdueRingSteps } = await import("../routing/ring-plan");
    await sweepOverdueRingSteps({ admin: h.admin, organizationId: ORG, now: () => h.now(), runSessionEvent: (id, event) => runSessionEvent(h.deps, id, event) });

    expect(h.session(call.sessionId).state).toBe("callback_offered");
  });

  it("keeps the answer when a lost version CAS makes the reservation guard run twice", async () => {
    const h = createTelephonyHarness();
    const call = await ringingInbound(h);

    const snapshot = await loadSessionSnapshot(h.deps, call.sessionId);
    const context = await loadRoutingContext(h.deps, snapshot.session);
    const event = {
      kind: "telnyx" as const,
      id: "evt-answer-retry",
      type: "call.answered",
      occurredAt: h.now().toISOString(),
      callControlId: call.o1,
      callLegId: null,
      callSessionId: call.telnyxSessionId,
      connectionId: "app-test",
      clientState: h.clientStateOf(call.o1),
      rawClientState: null,
      from: null,
      to: null,
      direction: null,
      state: null,
      hangupCause: null,
      hangupSource: null,
      sipHangupCause: null,
      digits: null,
      status: null,
      conferenceId: null,
      customHeaders: [],
      payload: {},
    };
    const result = reduce(snapshot.session, snapshot.legs, snapshot.attempts, event, context);
    expect(result.guard?.profileId).toBe(PROFILES.o1);

    // Another event for the same session lands first, so the CAS below loses.
    await h.legEvent(call.o2, "call.hangup", { hangup_cause: "timeout" });
    const effects = effectsDeps(h.deps);
    await expect(applyReduceResult(effects, { session: snapshot.session, result, event, expectedVersion: snapshot.session.version })).rejects.toBeInstanceOf(SessionConflictError);
    // The guard already reserved the operator for this session.
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "on_call", current_session_id: call.sessionId });

    // The runner retries the whole reduce + apply; the reservation must be re-entrant.
    const retrySnapshot = await loadSessionSnapshot(h.deps, call.sessionId);
    const retryContext = await loadRoutingContext(h.deps, retrySnapshot.session);
    const retryResult = reduce(retrySnapshot.session, retrySnapshot.legs, retrySnapshot.attempts, event, retryContext);
    const applied = await applyReduceResult(effects, { session: retrySnapshot.session, result: retryResult, event, expectedVersion: retrySnapshot.session.version });

    expect(applied.branch).toBe("main");
    expect(applied.failed).toBe(false);
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: PROFILES.o1 });
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "on_call", current_session_id: call.sessionId });
    expect(h.telnyx.of("hangup").some((entry) => entry.params.callControlId === call.o1)).toBe(false);
  });

  it("compensates a failed answer: hangs up, marks the session failed, records the incident and still returns 200", async () => {
    const h = createTelephonyHarness();
    h.telnyx.failNext("answer", "answer refused");
    const call = await h.inbound({ to: NUMBERS.allianz, answer: false });

    expect(call.results[0]).toMatchObject({ status: 200, outcome: "failed" });
    expect(h.session(call.sessionId)).toMatchObject({ state: "failed" });
    expect(h.telnyx.of("hangup").map((entry) => entry.params.callControlId)).toEqual([call.callControlId]);
    expect(h.call(call.sessionId)).toMatchObject({ status: "failed", end_reason: "answer_failed" });
    expect(h.rows("motorist_job_incidents")).toEqual([expect.objectContaining({ job_name: "telephony.telnyx.commands", status: "open", consecutive_failures: 1 })]);
    expect(h.rows("motorist_telnyx_webhook_events")[0]).toMatchObject({ status: "failed" });
    expect(h.rows("motorist_call_events").at(-1)).toMatchObject({ handled_status: "failed" });
  });

  it("compensates a failed bridge: operator leg hung up, customer to the waiting room", async () => {
    const h = createTelephonyHarness();
    const call = await ringingInbound(h);
    h.telnyx.failNext("bridge", "bridge refused");

    const result = await h.legEvent(call.o1, "call.answered");
    expect(result).toMatchObject({ outcome: "failed", status: 200 });
    expect(h.session(call.sessionId)).toMatchObject({ state: "waiting", answered_by_profile_id: null });
    expect(h.telnyx.of("hangup").some((entry) => entry.params.callControlId === call.o1)).toBe(true);
    expect(h.telnyx.of("playbackStart").at(-1)?.params).toMatchObject({ audioUrl: "https://media.test/telephony/announcements-v1/moh.mp3", loop: "infinity" });
    expect(h.presence(PROFILES.o1).status).toBe("available");
  });

  it("sweeps an overdue step: open offers become no_answer, legs are hung up and the next step starts", async () => {
    const h = createTelephonyHarness();
    const call = await ringingInbound(h);
    await h.legEvent(call.o1, "call.hangup", { hangup_cause: "timeout" });
    h.advance(26_000);

    const { sweepOverdueRingSteps } = await import("../routing/ring-plan");
    const { runSessionEvent } = await import("../session-runner");
    const swept = await sweepOverdueRingSteps({ admin: h.admin, organizationId: "00000000-0000-4000-8000-000000000001", now: () => h.now(), runSessionEvent: (id, event) => runSessionEvent(h.deps, id, event) });
    expect(swept.swept).toEqual([call.sessionId]);
    expect(h.attempts(call.sessionId).filter((attempt) => attempt.step_index === 0).map((attempt) => attempt.result)).toEqual(["no_answer", "no_answer", "no_answer"]);
    expect(h.telnyx.of("hangup").map((entry) => entry.params.callControlId).sort()).toEqual([call.o2, call.o5].sort());
    expect(h.presence(PROFILES.o2).status).toBe("available");
    expect(h.telnyx.of("dial").at(-1)?.params.to).toBe(NUMBERS.external);
  });
});

describe("after hours and IVR", () => {
  it("offers a callback outside business hours and records it when the caller presses 1", async () => {
    const h = createTelephonyHarness({ now: "2026-09-06T10:00:00.000Z" }); // Sunday
    const call = await h.inbound({ to: NUMBERS.allianz });
    expect(h.session(call.sessionId).state).toBe("after_hours");
    const gather = h.telnyx.of("gatherUsingAudio")[0];
    expect(gather.params).toMatchObject({ audioUrl: "https://media.test/telephony/announcements-v4/sk/after-hours.mp3", validDigits: "1" });
    expect(h.telnyx.of("dial")).toHaveLength(0);

    await h.legEvent(call.callControlId, "call.gather.ended", { digits: "1", status: "valid", client_state: gather.params.clientState });
    expect(h.rows("motorist_callback_requests")).toEqual([expect.objectContaining({ source: "after_hours" })]);
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(h.call(call.sessionId)).toMatchObject({ status: "ended", end_reason: "callback_requested" });
  });

  it("hangs up without a callback when the after-hours offer times out", async () => {
    const h = createTelephonyHarness({ now: "2026-12-24T10:00:00.000Z" }); // closed exception
    const call = await h.inbound({ to: NUMBERS.allianz });
    expect(h.session(call.sessionId).state).toBe("after_hours");
    await h.legEvent(call.callControlId, "call.gather.ended", { status: "timeout", client_state: h.telnyx.of("gatherUsingAudio")[0].params.clientState });
    expect(h.telnyx.of("hangup").at(-1)?.params.callControlId).toBe(call.callControlId);
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
    expect(h.call(call.sessionId)).toMatchObject({ status: "missed", end_reason: "after_hours" });
  });

  it("plays the IVR on the neutral line (normalising Telnyx's +4210… form) and routes digit 1 to the plan, 2 to a callback", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: "+4210232408700", callControlId: "cc-ivr-1", telnyxSessionId: "tsess-ivr-1" });
    expect(h.session(call.sessionId)).toMatchObject({ state: "ivr", line_id: "00000000-0000-4000-8000-000000000201", called_number: NUMBERS.neutral });
    const gather = h.telnyx.of("gatherUsingAudio")[0];
    expect(gather.params).toMatchObject({ audioUrl: "https://media.test/telephony/announcements-v4/sk/ivr-main.mp3", invalidAudioUrl: "https://media.test/telephony/announcements-v4/sk/invalid-input.mp3", validDigits: "12", maximumTries: 1, timeoutMillis: 5000 });

    await h.legEvent(call.callControlId, "call.gather.ended", { digits: "1", status: "valid", client_state: gather.params.clientState });
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(h.telnyx.of("dial")).toHaveLength(3);

    const second = await h.inbound({ to: "+4210232408700", callControlId: "cc-ivr-2", telnyxSessionId: "tsess-ivr-2" });
    const gather2 = h.telnyx.of("gatherUsingAudio").at(-1)!;
    await h.legEvent(second.callControlId, "call.gather.ended", { digits: "2", status: "valid", client_state: gather2.params.clientState });
    expect(h.session(second.sessionId).state).toBe("callback_offered");
    expect(h.rows("motorist_callback_requests")).toEqual([expect.objectContaining({ source: "ivr", session_id: second.sessionId })]);
  });
});

describe("talking-phase transitions", () => {
  async function talking(h: TelephonyHarness) {
    const call = await ringingInbound(h);
    await h.legEvent(call.o1, "call.answered");
    for (const loser of [call.o2, call.o5]) await h.legEvent(loser, "call.hangup", { hangup_cause: "originator_cancel" });
    await h.legEvent(call.o1, "call.bridged");
    await h.legEvent(call.callControlId, "call.bridged");
    expect(h.session(call.sessionId).state).toBe("talking");
    return call;
  }

  it("moves the customer to the waiting room when the operator leg drops mid-call", async () => {
    const h = createTelephonyHarness();
    const call = await talking(h);
    await h.legEvent(call.o1, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "callee" });
    expect(h.session(call.sessionId)).toMatchObject({ state: "waiting", answered_by_profile_id: null });
    expect(h.telnyx.of("playbackStart").at(-1)?.params).toMatchObject({ callControlId: call.callControlId, audioUrl: "https://media.test/telephony/announcements-v1/moh.mp3", loop: "infinity" });
    expect(h.telnyx.of("gather").at(-1)?.params).toMatchObject({ callControlId: call.callControlId, timeoutMillis: 60_000 });
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "after_call_work", current_session_id: null });
    expect(h.call(call.sessionId)).toMatchObject({ status: "answered", operator_id: PROFILES.o1 });
  });

  it("finalises the call with a duration when the customer hangs up and the operator leg follows", async () => {
    const h = createTelephonyHarness();
    const call = await talking(h);
    h.advance(90_000);
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "caller" });
    await h.legEvent(call.o1, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "caller" });
    expect(h.session(call.sessionId).state).toBe("ended");
    expect(h.call(call.sessionId)).toMatchObject({ status: "ended", duration_seconds: 90, wait_seconds: 0, end_reason: "caller_hangup" });
    const history = h.rows("motorist_operator_statuses").filter((row) => row.profile_id === PROFILES.o1).map((row) => row.status);
    // The installed reservation RPC records the accepted call atomically too.
    expect(history).toEqual(["on_call", "after_call_work"]);
  });

  it("finalises a wrap_up session via the sweep when the remaining leg webhooks never arrive", async () => {
    const h = createTelephonyHarness();
    const call = await talking(h);
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "caller" });
    expect(h.session(call.sessionId).state).toBe("wrap_up");
    h.advance(3 * 60_000);
    const { sweepOverdueRingSteps } = await import("../routing/ring-plan");
    const { runSessionEvent } = await import("../session-runner");
    const swept = await sweepOverdueRingSteps({ admin: h.admin, organizationId: "00000000-0000-4000-8000-000000000001", now: () => h.now(), runSessionEvent: (id, event) => runSessionEvent(h.deps, id, event) });
    expect(swept.swept).toEqual([call.sessionId]);
    expect(h.session(call.sessionId).state).toBe("ended");
    expect(h.legs(call.sessionId).every((leg) => leg.ended_at)).toBe(true);
  });
});

describe("bridge before the best-effort audio stops", () => {
  const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };

  /** Provider methods issued after `from`, in order. */
  function methodsSince(h: TelephonyHarness, from: number) {
    return h.telnyx.calls.slice(from).map((entry) => entry.method);
  }

  async function parked(h: TelephonyHarness) {
    const call = await ringingInbound(h);
    await h.legEvent(call.o1, "call.answered");
    await completeAnnouncedAction(h, parkCall(h.deps, actor, call.sessionId));
    expect(h.session(call.sessionId).state).toBe("parked");
    expect(readMeta(h.session(call.sessionId) as SessionRow).queue ?? null).toBeNull();
    return call;
  }

  async function queued(h: TelephonyHarness) {
    const call = await ringingInbound(h);
    for (const leg of [call.o1, call.o2, call.o5]) await h.legEvent(leg, "call.hangup", { hangup_cause: "timeout" });
    const external = h.legByNumber(call.sessionId, NUMBERS.external)!;
    await h.legEvent(String(external.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });
    expect(h.session(call.sessionId).state).toBe("waiting");
    expect(readMeta(h.session(call.sessionId) as SessionRow).queue).toBeTruthy();
    return call;
  }

  it("bridges the ringing answer before stopping the ring music", async () => {
    const h = createTelephonyHarness();
    const call = await ringingInbound(h);
    const before = h.telnyx.calls.length;

    await h.legEvent(call.o2, "call.answered");

    const methods = methodsSince(h, before);
    expect(methods).toContain("playbackStop");
    expect(methods.indexOf("bridge")).toBeGreaterThan(-1);
    expect(methods.indexOf("bridge")).toBeLessThan(methods.indexOf("playbackStop"));
  });

  it("bridges a pickup from the waiting room before stopping the gather and the music", async () => {
    const h = createTelephonyHarness();
    const call = await parked(h);
    const picked = await pickupWaitingCall(h.deps, { profileId: PROFILES.o2, role: "dispatcher" }, call.sessionId);
    const before = h.telnyx.calls.length;

    await h.legEvent(picked.operatorLegCallControlId!, "call.answered");

    const methods = methodsSince(h, before);
    expect(methods).toContain("gatherStop");
    expect(methods).toContain("playbackStop");
    expect(methods.indexOf("bridge")).toBeLessThan(methods.indexOf("gatherStop"));
    expect(methods.indexOf("bridge")).toBeLessThan(methods.indexOf("playbackStop"));
    expect(h.session(call.sessionId).state).toBe("talking");
  });

  it("keeps the waiting-room music playing and re-arms the gather when the bridge fails", async () => {
    const h = createTelephonyHarness();
    const call = await parked(h);
    const picked = await pickupWaitingCall(h.deps, { profileId: PROFILES.o2, role: "dispatcher" }, call.sessionId);
    h.telnyx.failNext("bridge", "bridge refused");
    const before = h.telnyx.calls.length;

    await h.legEvent(picked.operatorLegCallControlId!, "call.answered");

    const methods = methodsSince(h, before);
    // The loop was never stopped, so the caller keeps hearing it and
    // `enterWaiting` does not restart it — a `playback_stop` here would leave a
    // silent waiting room.
    expect(methods).not.toContain("playbackStop");
    expect(methods).not.toContain("playbackStart");
    // The old gather is stopped by the compensation, right before the new one.
    expect(methods).toEqual(["bridge", "hangup", "gatherStop", "gather"]);
    expect(h.session(call.sessionId)).toMatchObject({ state: "waiting", answered_by_profile_id: null });
    expect(readMeta(h.session(call.sessionId) as SessionRow).waiting?.reason).toBe("bridge_failed");
  });

  it("leaves the queue gather alone when the bridge of a queued pickup fails", async () => {
    const h = createTelephonyHarness({ fallbackKind: "waiting_room" });
    const call = await queued(h);
    const picked = await pickupWaitingCall(h.deps, actor, call.sessionId);
    h.telnyx.failNext("bridge", "bridge refused");
    const before = h.telnyx.calls.length;

    await h.legEvent(picked.operatorLegCallControlId!, "call.answered");

    const methods = methodsSince(h, before);
    // The queued caller returns to the offers they already had: `enterWaiting`
    // issues no new gather, so stopping the running one would silence the queue.
    expect(methods).toEqual(["bridge", "hangup"]);
    expect(h.session(call.sessionId)).toMatchObject({ state: "waiting", answered_by_profile_id: null });
    expect(readMeta(h.session(call.sessionId) as SessionRow).queue).toBeTruthy();
  });
});

describe("late audio completions on a terminal or wrap-up session", () => {
  // The event processor acknowledges these without a lease (E2.4, state-only
  // branch: the customer leg is still open). That is only sound while the
  // reducer has nothing to do for them: no command, no patch, no guard.
  it.each(["ended", "wrap_up", "failed"] as const)("is a pure ignore in %s for gather/playback/speak.ended with an open customer leg", async (state) => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const snapshot = await loadSessionSnapshot(h.deps, call.sessionId);
    const customer = snapshot.legs.find((leg) => leg.telnyx_call_control_id === call.callControlId)!;
    expect(customer.ended_at).toBeNull();
    const session = { ...snapshot.session, state };
    const context = await loadRoutingContext(h.deps, session);
    for (const [type, reason] of [
      ["call.gather.ended", `gather in ${state}`],
      ["call.playback.ended", `playback ended in ${state}`],
      ["call.speak.ended", `playback ended in ${state}`],
    ] as const) {
      const event = {
        kind: "telnyx" as const,
        id: `evt-late-${type}`,
        type,
        occurredAt: h.now().toISOString(),
        callControlId: call.callControlId,
        callLegId: null,
        callSessionId: call.telnyxSessionId,
        connectionId: "app-test",
        clientState: h.clientStateOf(call.callControlId),
        rawClientState: null,
        from: null,
        to: null,
        direction: null,
        state: null,
        hangupCause: null,
        hangupSource: null,
        sipHangupCause: null,
        digits: null,
        status: "completed",
        conferenceId: null,
        customHeaders: [],
        payload: {},
      };
      const result = reduce(session, snapshot.legs, snapshot.attempts, event, context);
      expect(result.ignored).toBe(reason);
      expect(result.commands).toEqual([]);
      expect(result.compensations).toEqual([]);
      expect(result.guard).toBeNull();
      expect(result.next).toEqual(emptyTransition());
    }
  });
});

describe("customer gone at provider and ended_at provenance (E4)", () => {
  const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };
  const meta = (h: TelephonyHarness, sessionId: string) => readMeta(h.session(sessionId) as SessionRow);
  const customerLeg = (h: TelephonyHarness, call: { sessionId: string; callControlId: string }) => h.legs(call.sessionId).find((leg) => leg.telnyx_call_control_id === call.callControlId)!;
  const gather = (h: TelephonyHarness) => h.telnyx.of("gatherUsingAudio").at(-1)!.params.clientState;
  const sweepEvents = (h: TelephonyHarness, sessionId: string) => h.callEvents(sessionId).filter((row) => row.event_type === "app.sweep");
  async function sweep(h: TelephonyHarness) {
    const result = await sweepOverdueRingSteps({ admin: h.admin, organizationId: ORG, now: h.now, runSessionEvent: (id, event) => runSessionEvent(h.deps, id, event) });
    expect(result.errors).toEqual([]);
    return result;
  }
  /** Inbound call parked in the waiting room after the backup number did not answer (same as queue-callback-reliability). */
  async function waitingQueued() {
    const h = createTelephonyHarness({ fallbackKind: "waiting_room" });
    for (const id of Object.values(PROFILES)) h.setPresence(id, { status: "offline" });
    const call = await h.inbound({ to: NUMBERS.allianz });
    const backup = h.legByNumber(call.sessionId, NUMBERS.external)!;
    await h.legEvent(String(backup.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });
    expect(h.session(call.sessionId).state).toBe("waiting");
    expect(meta(h, call.sessionId).queue).toBeTruthy();
    return { h, call };
  }
  async function talkingCall(h: TelephonyHarness) {
    const call = await ringingInbound(h);
    await h.legEvent(call.o1, "call.answered");
    for (const loser of [call.o2, call.o5]) await h.legEvent(loser, "call.hangup", { hangup_cause: "originator_cancel" });
    await h.legEvent(call.o1, "call.bridged");
    await h.legEvent(call.callControlId, "call.bridged");
    expect(h.session(call.sessionId).state).toBe("talking");
    return call;
  }
  const plus = (h: TelephonyHarness, ms: number) => new Date(h.now().getTime() + ms).toISOString();

  it("gather call_hangup on the customer leg records customer_gone_at and stops the sweep from dialling", async () => {
    const { h, call } = await waitingQueued();
    const dials = h.telnyx.of("dial").length;
    const hangups = h.telnyx.of("hangup").length;
    const goneAt = h.now().toISOString();

    const marked = await h.legEvent(call.callControlId, "call.gather.ended", { status: "call_hangup", client_state: gather(h) });
    expect(marked).toMatchObject({ status: 200, outcome: "processed", notes: ["customer gone at provider"] });
    expect(meta(h, call.sessionId).customer_gone_at).toBe(goneAt);
    // Only the fact is recorded: no leg write, no state, no command, no callback.
    expect(customerLeg(h, call)).toMatchObject({ ended_at: null, hangup_cause: null });
    expect(h.session(call.sessionId)).toMatchObject({ state: "waiting", ended_at: null });
    expect(h.telnyx.of("hangup")).toHaveLength(hangups);
    expect(h.telnyx.of("dial")).toHaveLength(dials);
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);

    // The second provider report of the same fact is a cheap ignore.
    const again = await h.legEvent(call.callControlId, "call.playback.ended", { status: "call_hangup" });
    expect(again).toMatchObject({ outcome: "ignored", notes: ["playback call_hangup: customer already gone at provider"] });
    expect(meta(h, call.sessionId).customer_gone_at).toBe(goneAt);

    // An operator becomes available and the queue offer is due: no dial for a gone caller.
    h.setPresence(PROFILES.o1, { status: "available" });
    h.touchDevice(PROFILES.o1);
    h.advance(6_000);
    await sweep(h);
    expect(h.telnyx.of("dial")).toHaveLength(dials);
    expect(h.session(call.sessionId).state).toBe("waiting");
    expect(sweepEvents(h, call.sessionId).at(-1)).toMatchObject({ handled_status: "ignored", normalized_payload: { notes: ["sweep: customer already gone at provider"] } });
    expect(meta(h, call.sessionId).queue?.next_offer_at).toBeDefined();

    // The exact hangup still does everything: leg end from the provider clock,
    // `onCustomerHangup`, exactly one missed callback.
    h.advance(1_000);
    const hungUpAt = h.now().toISOString();
    const hangup = await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "caller" });
    expect(hangup).toMatchObject({ outcome: "processed" });
    expect(h.session(call.sessionId)).toMatchObject({ state: "ended", ended_at: hungUpAt });
    expect(customerLeg(h, call)).toMatchObject({ ended_at: hungUpAt, hangup_cause: "normal_clearing" });
    expect(h.rows("motorist_callback_requests").map((row) => row.source)).toEqual(["missed"]);
    expect(h.telnyx.of("dial")).toHaveLength(dials);
  });

  it("hangs up a late operator answer for a gone caller instead of bridging a dead leg", async () => {
    const { h, call } = await waitingQueued();
    h.setPresence(PROFILES.o1, { status: "available" });
    h.touchDevice(PROFILES.o1);
    h.advance(6_000);
    await sweep(h);
    const offer = h.openLegFor(call.sessionId, PROFILES.o1)!;
    expect(h.session(call.sessionId).state).toBe("ringing");

    await h.legEvent(call.callControlId, "call.gather.ended", { status: "call_hangup", client_state: gather(h) });
    expect(meta(h, call.sessionId).customer_gone_at).toBeTruthy();
    const bridges = h.telnyx.of("bridge").length;
    await h.legEvent(String(offer.telnyx_call_control_id), "call.answered");
    expect(h.telnyx.of("bridge")).toHaveLength(bridges);
    expect(h.telnyx.of("hangup").at(-1)?.params.callControlId).toBe(offer.telnyx_call_control_id);
    expect(h.session(call.sessionId).state).not.toBe("talking");
    expect(customerLeg(h, call).ended_at).toBeNull();
  });

  it("rejects a manual pickup for a gone caller before reserving or dialling the operator", async () => {
    const { h, call } = await waitingQueued();
    await h.legEvent(call.callControlId, "call.gather.ended", { status: "call_hangup", client_state: gather(h) });
    h.setPresence(PROFILES.o1, { status: "available" });
    h.touchDevice(PROFILES.o1);
    const dials = h.telnyx.of("dial").length;
    await expect(pickupWaitingCall(h.deps, actor, call.sessionId)).rejects.toMatchObject({ status: 409, code: "not_waiting" });
    // Also protect the reducer, including internal callers bypassing the action preflight.
    await expect(runSessionEvent(h.deps, call.sessionId, {
      kind: "app", type: "pickup", id: "pickup-after-customer-gone", actorProfileId: PROFILES.o1,
      occurredAt: h.now().toISOString(), picker: { profileId: PROFILES.o1, sipUri: "sip:gencred001@sip.telnyx.com" },
    })).rejects.toMatchObject({ status: 409 });
    expect(h.telnyx.of("dial")).toHaveLength(dials);
    expect(h.presence(PROFILES.o1)).toMatchObject({ status: "available", current_session_id: null });
    expect(customerLeg(h, call).ended_at).toBeNull();
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
  });

  it("gather cancelled stays a plain ignore", async () => {
    for (const status of ["cancelled", "cancelled_amd"]) {
      const { h, call } = await waitingQueued();
      const dials = h.telnyx.of("dial").length;
      const result = await h.legEvent(call.callControlId, "call.gather.ended", { status, client_state: gather(h) });
      expect(result).toMatchObject({ outcome: "ignored", notes: [`gather ${status}`] });
      expect(meta(h, call.sessionId).customer_gone_at).toBeUndefined();
      h.setPresence(PROFILES.o1, { status: "available" });
      h.touchDevice(PROFILES.o1);
      h.advance(6_000);
      await sweep(h);
      expect(h.telnyx.of("dial")).toHaveLength(dials + 1);
    }
  });

  it("greeting branch unchanged", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ completeGreeting: false });
    expect(h.session(call.sessionId).state).toBe("greeting");
    const greeting = h.telnyx.of("playbackStart").find((entry) => entry.params.callControlId === call.callControlId)!;
    const result = await h.legEvent(call.callControlId, "call.playback.ended", { status: "call_hangup", client_state: greeting.params.clientState });
    expect(result).toMatchObject({ outcome: "ignored", notes: ["introduction interrupted by hangup"] });
    expect(meta(h, call.sessionId).customer_gone_at).toBeUndefined();
    expect(h.session(call.sessionId).state).toBe("greeting");
  });

  it("a late exact hangup corrects a synthetic close without commands", async () => {
    const h = createTelephonyHarness();
    const call = await talkingCall(h);
    const t0 = h.now().toISOString();
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "caller" });
    expect(h.session(call.sessionId).state).toBe("wrap_up");
    h.advance(3 * 60_000);
    const staleAt = h.now().toISOString();
    await sweep(h);
    const operator = () => h.legs(call.sessionId).find((leg) => leg.telnyx_call_control_id === call.o1)!;
    expect(operator()).toMatchObject({ hangup_cause: "stale_finalise", ended_at: staleAt });
    expect(h.session(call.sessionId)).toMatchObject({ state: "ended", ended_at: staleAt });

    const commands = h.telnyx.calls.length;
    const presence = { ...h.presence(PROFILES.o1) };
    h.setNow(plus(h, 5_000 - 3 * 60_000));
    const exactAt = h.now().toISOString();
    expect(Date.parse(exactAt)).toBe(Date.parse(t0) + 5_000);
    const late = await h.legEvent(call.o1, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "callee" });
    expect(late).toMatchObject({ outcome: "processed", notes: ["provider end corrected"] });
    expect(operator()).toMatchObject({ state: "ended", ended_at: exactAt, hangup_cause: "normal_clearing", hangup_source: "callee" });
    // The stored session end came from the same synthetic close: max(customer T0, operator T+5).
    expect(h.session(call.sessionId)).toMatchObject({ state: "ended", ended_at: exactAt });
    expect(h.call(call.sessionId)?.ended_at).toBe(exactAt);
    expect(h.telnyx.calls).toHaveLength(commands);
    expect(h.presence(PROFILES.o1)).toEqual(presence);
  });

  it("a genuine duplicate is still ignored", async () => {
    const h = createTelephonyHarness();
    const call = await talkingCall(h);
    h.advance(10_000);
    const endedAt = h.now().toISOString();
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "caller" });
    expect(customerLeg(h, call)).toMatchObject({ ended_at: endedAt, hangup_cause: "normal_clearing" });
    const session = { ...h.session(call.sessionId) };

    h.setNow(plus(h, -5_000));
    const duplicate = await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "caller" });
    expect(duplicate).toMatchObject({ outcome: "ignored", notes: ["duplicate hangup"] });
    expect(customerLeg(h, call)).toMatchObject({ ended_at: endedAt, hangup_cause: "normal_clearing", hangup_source: "caller" });
    expect(h.session(call.sessionId)).toMatchObject({ state: session.state, ended_at: session.ended_at });
  });

  it("session end never precedes the customer's end", async () => {
    const h = createTelephonyHarness();
    const call = await talkingCall(h);
    const t0 = h.now().getTime();
    await hangupCall(h.deps, actor, call.sessionId);
    expect(h.session(call.sessionId).state).toBe("wrap_up");
    expect(h.telnyx.of("hangup").map((entry) => entry.params.callControlId)).toEqual(expect.arrayContaining([call.callControlId, call.o1]));

    h.setNow(new Date(t0 + 20_000).toISOString());
    const operatorEnd = h.now().toISOString();
    await h.legEvent(call.o1, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "callee" });
    expect(h.legs(call.sessionId).find((leg) => leg.telnyx_call_control_id === call.o1)).toMatchObject({ ended_at: operatorEnd });
    // The customer's hangup is lost; the stale sweep closes the leg minutes later.
    h.setNow(new Date(t0 + 200_000).toISOString());
    const staleAt = h.now().toISOString();
    await sweep(h);
    expect(customerLeg(h, call)).toMatchObject({ hangup_cause: "stale_finalise", ended_at: staleAt });
    expect(h.session(call.sessionId)).toMatchObject({ state: "ended", ended_at: staleAt });

    const commands = h.telnyx.calls.length;
    h.setNow(new Date(t0 + 10_000).toISOString());
    const customerEnd = h.now().toISOString();
    const late = await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "caller" });
    expect(late).toMatchObject({ outcome: "processed", notes: ["provider end corrected"] });
    expect(customerLeg(h, call)).toMatchObject({ ended_at: customerEnd, hangup_cause: "normal_clearing" });
    // Corrected downwards to the latest leg end, never below the customer's end.
    expect(h.session(call.sessionId)).toMatchObject({ state: "ended", ended_at: operatorEnd });
    expect(h.call(call.sessionId)).toMatchObject({ ended_at: operatorEnd, duration_seconds: 20 });
    expect(h.telnyx.calls).toHaveLength(commands);
  });

  it("an unanswered offer closed by the stale sweep does not stretch the call", async () => {
    // Production 2026-09-25 10:18: one minute of talk shown as 247 s because a
    // losing offer's hangup never arrived and the sweep closed it minutes later.
    const h = createTelephonyHarness();
    const call = await ringingInbound(h);
    await h.legEvent(call.o1, "call.answered");
    await h.legEvent(call.o2, "call.hangup", { hangup_cause: "originator_cancel" });
    await h.legEvent(call.o1, "call.bridged");
    await h.legEvent(call.callControlId, "call.bridged");
    expect(h.session(call.sessionId).state).toBe("talking");
    const answeredAt = String(h.call(call.sessionId)!.answered_at);

    h.setNow(new Date(Date.parse(answeredAt) + 60_000).toISOString());
    const customerEnd = h.now().toISOString();
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "caller" });
    await h.legEvent(call.o1, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "callee" });
    expect(h.session(call.sessionId).state).toBe("wrap_up");
    expect(h.call(call.sessionId)).toMatchObject({ ended_at: customerEnd, duration_seconds: 60 });

    h.advance(3 * 60_000);
    const staleAt = h.now().toISOString();
    await sweep(h);
    expect(h.legs(call.sessionId).find((leg) => leg.telnyx_call_control_id === call.o5)).toMatchObject({ hangup_cause: "stale_finalise", ended_at: staleAt });
    expect(h.session(call.sessionId)).toMatchObject({ state: "ended", ended_at: staleAt });
    expect(h.call(call.sessionId)).toMatchObject({ ended_at: customerEnd, duration_seconds: 60 });
  });

  it("session ended_at is the latest leg end after an out-of-order operator hangup", async () => {
    const h = createTelephonyHarness();
    const call = await talkingCall(h);
    const t0 = h.now().getTime();
    h.setNow(new Date(t0 + 10_000).toISOString());
    const customerEnd = h.now().toISOString();
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "caller" });
    expect(h.session(call.sessionId).state).toBe("wrap_up");
    expect(h.call(call.sessionId)?.ended_at).toBe(customerEnd);

    // The operator's hangup happened first at the provider but applied later.
    h.setNow(new Date(t0 + 5_000).toISOString());
    await h.legEvent(call.o1, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "callee" });
    expect(h.session(call.sessionId)).toMatchObject({ state: "ended", ended_at: customerEnd });
    expect(h.call(call.sessionId)?.ended_at).toBe(customerEnd);
  });
});
