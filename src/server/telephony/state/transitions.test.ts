import { describe, expect, it } from "vitest";

import { createTelephonyHarness, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";

import { advanceRingStep } from "../routing/ring-plan";
import { loadRoutingContext, loadSessionSnapshot, effectsDeps, runSessionEvent } from "../session-runner";
import { applyReduceResult, SessionConflictError } from "./effects";
import { reduce } from "./transitions";
import type { RingFanout } from "./types";

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
    expect(playbacks).toEqual(["https://media.test/telephony/greeting.mp3", "https://media.test/telephony/moh.mp3"]);

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

  it("creates a callback task as well when the caller matched an open case", async () => {
    const h = createTelephonyHarness();
    h.deps.findCallerMatches = async () => ({ degraded: false, matches: [{ id: "case:x", type: "open_case", label: "PM-2026-0001", caseId: "00000000-0000-4000-8000-000000000801", caseNumber: "PM-2026-0001", confidence: "high" }] });
    const call = await ringingInbound(h);
    expect(h.session(call.sessionId).case_id).toBe("00000000-0000-4000-8000-000000000801");
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "originator_cancel" });
    expect(h.rows("motorist_case_tasks")).toEqual([expect.objectContaining({ kind: "callback", case_id: "00000000-0000-4000-8000-000000000801", status: "open" })]);
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
    expect(gather.params).toMatchObject({ callControlId: call.callControlId, audioUrl: "https://media.test/telephony/callback-offer.mp3", validDigits: "1", maximumTries: 1 });

    await h.legEvent(call.callControlId, "call.gather.ended", { digits: "1", status: "valid", client_state: gather.params.clientState });
    expect(h.rows("motorist_callback_requests")).toEqual([expect.objectContaining({ source: "missed", status: "open" })]);
    expect(h.telnyx.of("playbackStart").at(-1)?.params.audioUrl).toBe("https://media.test/telephony/callback-confirmed.mp3");
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "completed" });
    expect(h.telnyx.of("hangup").at(-1)?.params.callControlId).toBe(call.callControlId);
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "callee" });
    expect(h.session(call.sessionId).state).toBe("ended");
    expect(h.call(call.sessionId)).toMatchObject({ status: "ended", end_reason: "callback_requested" });
  });

  it("puts the caller into the waiting room when the plan's fallback is waiting_room", async () => {
    const h = createTelephonyHarness({ fallbackKind: "waiting_room" });
    const call = await ringingInbound(h);
    for (const leg of [call.o1, call.o2, call.o5]) await h.legEvent(leg, "call.hangup", { hangup_cause: "timeout" });
    const external = h.legByNumber(call.sessionId, NUMBERS.external)!;
    await h.legEvent(String(external.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });

    expect(h.session(call.sessionId).state).toBe("waiting");
    const tick = h.telnyx.of("gatherUsingAudio").at(-1)!;
    expect(tick.params).toMatchObject({ audioUrl: "https://media.test/telephony/moh.mp3", timeoutMillis: 2_000, maximumTries: 1 });

    // Ticks re-arm; after park_max_minutes the caller gets the callback offer.
    h.advance(60_000);
    await h.legEvent(call.callControlId, "call.gather.ended", { status: "timeout", client_state: tick.params.clientState });
    expect(h.telnyx.of("gatherUsingAudio")).toHaveLength(2);
    h.advance(31 * 60_000);
    await h.legEvent(call.callControlId, "call.gather.ended", { status: "timeout", client_state: tick.params.clientState });
    expect(h.session(call.sessionId).state).toBe("callback_offered");
    expect(h.telnyx.of("gatherUsingAudio").at(-1)?.params.audioUrl).toBe("https://media.test/telephony/callback-offer.mp3");
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
    expect(h.telnyx.of("gatherUsingAudio").at(-1)?.params.audioUrl).toBe("https://media.test/telephony/moh.mp3");
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
    expect(gather.params).toMatchObject({ audioUrl: "https://media.test/telephony/after-hours.mp3", validDigits: "1" });
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
    expect(gather.params).toMatchObject({ audioUrl: "https://media.test/telephony/ivr-main.mp3", invalidAudioUrl: "https://media.test/telephony/invalid-input.mp3", validDigits: "12", maximumTries: 2, timeoutMillis: 5000 });

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
    expect(h.telnyx.of("gatherUsingAudio").at(-1)?.params).toMatchObject({ callControlId: call.callControlId, audioUrl: "https://media.test/telephony/moh.mp3" });
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
    expect(history).toEqual(["after_call_work"]);
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
