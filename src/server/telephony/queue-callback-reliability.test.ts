import { describe, expect, it } from "vitest";
import { createTelephonyHarness, NUMBERS, PROFILES, ORG, type TelephonyHarness } from "@/test/telephony-harness";
import { loadCallbackQueue } from "./callbacks";
import { runSessionEvent } from "./session-runner";
import { sweepOverdueRingSteps } from "./routing/ring-plan";
import { readMeta, type SessionRow } from "./state/types";

const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };
const queue = (h: TelephonyHarness) => loadCallbackQueue(h.deps, actor);
async function sweep(h: TelephonyHarness) {
  const result = await sweepOverdueRingSteps({ admin: h.admin, organizationId: ORG, now: h.now, runSessionEvent: (id, event) => runSessionEvent(h.deps, id, event) });
  expect(result.errors).toEqual([]);
  return result;
}
async function waiting(h = createTelephonyHarness({ fallbackKind: "waiting_room" })) {
  for (const id of Object.values(PROFILES)) h.setPresence(id, { status: "offline" });
  const call = await h.inbound({ to: NUMBERS.allianz });
  const backup = h.legByNumber(call.sessionId, NUMBERS.external)!;
  await h.legEvent(String(backup.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });
  expect(h.session(call.sessionId).state).toBe("waiting");
  return { h, call };
}
function gather(h: TelephonyHarness) { return h.telnyx.of("gatherUsingAudio").at(-1)!.params.clientState; }

describe("thirty-minute inbound queue", () => {
  it("can offer an operator who returns from a pause that originally forwarded to their mobile", async () => {
    const h = createTelephonyHarness({ fallbackKind: "waiting_room" });
    for (const id of Object.values(PROFILES)) h.setPresence(id, { status: "offline" });
    h.setPresence(PROFILES.o1, { status: "paused" });
    h.db.update("motorist_operator_telephony_settings", { pause_routing_mode: "default_mobile", default_mobile_number: "+421900000099" }, (row) => row.profile_id === PROFILES.o1);
    const call = await h.inbound({ to: NUMBERS.allianz });
    const mobile = h.legByNumber(call.sessionId, "+421900000099")!;
    await h.legEvent(String(mobile.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });
    const backup = h.legByNumber(call.sessionId, NUMBERS.external)!;
    await h.legEvent(String(backup.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });
    expect(h.session(call.sessionId).state).toBe("waiting");
    h.advance(5_000);
    h.setPresence(PROFILES.o1, { status: "available" });
    await sweep(h);
    expect(h.openLegFor(call.sessionId, PROFILES.o1)).toBeTruthy();
    expect(h.telnyx.of("dial").filter((dial) => !String(dial.params.to).startsWith("sip:"))).toHaveLength(2);
  });

  it("keeps silence/invalid digits in the queue for 30 minutes and creates no requested callback", async () => {
    const { h, call } = await waiting();
    const entered = h.now().toISOString();
    for (let minute = 1; minute < 30; minute++) {
      h.advance(60_000);
      await h.legEvent(call.callControlId, "call.gather.ended", { status: minute === 2 ? "invalid" : "timeout", digits: minute === 2 ? "9" : "", client_state: gather(h) });
      expect(h.session(call.sessionId).state).toBe("waiting");
      expect(h.rows("motorist_callback_requests")).toHaveLength(0);
    }
    expect(h.telnyx.of("dial")).toHaveLength(1); // the one backup attempt
    expect(h.telnyx.of("hangup")).toHaveLength(0);
    expect(readMeta(h.session(call.sessionId) as SessionRow).waiting?.since).toBe(entered);
    h.advance(60_000);
    await sweep(h);
    expect(h.session(call.sessionId).state).toBe("callback_offered");
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
    await h.legEvent(call.callControlId, "call.gather.ended", { status: "valid", digits: "1", client_state: gather(h) });
    expect((await queue(h)).open[0]).toMatchObject({ source: "park_timeout", origin: { kind: "requested", digit: "1", context: "park_timeout" } });
  });

  it("automatically offers an available operator without auto-answer, stops queue audio, and allows a 30-minute conversation", async () => {
    const { h, call } = await waiting();
    h.advance(5_000);
    h.setPresence(PROFILES.o1, { status: "available" });
    h.touchDevice(PROFILES.o1);
    await sweep(h);
    expect(h.session(call.sessionId).state).toBe("ringing");
    const offered = h.openLegFor(call.sessionId, PROFILES.o1)!;
    expect(offered).toBeTruthy();
    expect(h.telnyx.of("dial").at(-1)?.params).toMatchObject({ timeoutSecs: 20, timeLimitSecs: 14_400 });
    expect(h.clientStateOf(String(offered.telnyx_call_control_id)).autoAnswer).not.toBe(true);
    await h.legEvent(String(offered.telnyx_call_control_id), "call.answered");
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", answered_by_profile_id: PROFILES.o1 });
    expect(h.telnyx.of("gatherStop").at(-1)?.params.callControlId).toBe(call.callControlId);
    expect(readMeta(h.session(call.sessionId) as SessionRow)).toMatchObject({ queue: null, waiting: null });
    h.advance(30 * 60_000);
    await sweep(h);
    expect(h.session(call.sessionId).state).toBe("talking");
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
  });

  it("preserves the original deadline over retries and never redials the external backup", async () => {
    const { h, call } = await waiting();
    const entered = h.now().toISOString();
    h.setPresence(PROFILES.o1, { status: "available" });
    h.advance(5_000);
    await sweep(h);
    const first = h.openLegFor(call.sessionId, PROFILES.o1)!;
    await h.legEvent(String(first.telnyx_call_control_id), "call.hangup", { hangup_cause: "call_rejected" });
    expect(h.session(call.sessionId).state).toBe("waiting");
    h.advance(5_000);
    await sweep(h);
    expect(h.telnyx.of("dial")).toHaveLength(2);
    h.advance(55_000);
    h.touchDevice(PROFILES.o1);
    await sweep(h);
    expect(h.telnyx.of("dial")).toHaveLength(3);
    expect(h.attempts(call.sessionId).map((row) => row.step_index)).toEqual([1, 2, 3]);
    expect(readMeta(h.session(call.sessionId) as SessionRow).waiting?.since).toBe(entered);
    h.setNow(new Date(Date.parse(entered) + 30 * 60_000).toISOString());
    await sweep(h);
    expect(h.session(call.sessionId).state).toBe("callback_offered");
    expect(h.telnyx.of("dial").filter((dial) => dial.params.to === NUMBERS.external)).toHaveLength(1);
  });

  it("offers the oldest waiting caller first and does not double-book a single operator", async () => {
    const { h, call: first } = await waiting();
    h.advance(1_000);
    const { call: second } = await waiting(h);
    h.advance(5_000);
    h.setPresence(PROFILES.o1, { status: "available" });
    await sweep(h);
    expect(h.session(first.sessionId).state).toBe("ringing");
    expect(h.session(second.sessionId).state).toBe("waiting");
    expect(h.presence(PROFILES.o1).current_session_id).toBe(first.sessionId);
  });

  it("rejects a late answer from an expired offer while a newer offer is ringing", async () => {
    const { h, call } = await waiting();
    h.setPresence(PROFILES.o1, { status: "available" });
    h.advance(5_000);
    await sweep(h);
    const old = h.openLegFor(call.sessionId, PROFILES.o1)!;
    await h.legEvent(String(old.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });
    h.advance(60_000);
    h.touchDevice(PROFILES.o1);
    await sweep(h);
    const current = h.openLegFor(call.sessionId, PROFILES.o1)!;
    await h.legEvent(String(old.telnyx_call_control_id), "call.answered");
    expect(h.telnyx.of("bridge")).toHaveLength(0);
    await h.legEvent(String(current.telnyx_call_control_id), "call.answered");
    expect(h.telnyx.of("bridge")).toHaveLength(1);
  });
});

describe("callback choice from provider event through dispatcher payload", () => {
  it("records 1 and its timestamp, cancels offers, rejects a late answer and ignores stale queue audio", async () => {
    const { h, call } = await waiting();
    const queueState = gather(h);
    h.advance(5_000);
    h.setPresence(PROFILES.o1, { status: "available" });
    await sweep(h);
    const offered = h.openLegFor(call.sessionId, PROFILES.o1)!;
    const at = h.now().toISOString();
    await h.legEvent(call.callControlId, "call.gather.ended", { status: "valid", digits: "1", client_state: queueState }, "queue-choice-one");
    expect((await queue(h)).open[0]).toMatchObject({ source: "missed", origin: { kind: "requested", digit: "1", requestedAt: at, context: "waiting_room", evidence: "dtmf" } });
    expect(h.rows("motorist_callback_requests")[0].metadata).toMatchObject({ request: { event_id: "queue-choice-one", digit: "1" } });
    await h.legEvent(String(offered.telnyx_call_control_id), "call.answered");
    await h.legEvent(call.callControlId, "call.gather.ended", { status: "timeout", client_state: queueState });
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "completed", client_state: queueState });
    expect(h.telnyx.of("bridge")).toHaveLength(0);
    expect(h.telnyx.of("hangup").filter((command) => command.params.callControlId === call.callControlId)).toHaveLength(0);
    const confirmation = h.telnyx.of("playbackStart").at(-1)!;
    await h.legEvent(call.callControlId, "call.playback.ended", { status: "completed", client_state: confirmation.params.clientState });
    expect(h.telnyx.of("hangup").at(-1)?.params.callControlId).toBe(call.callControlId);
    await h.legEvent(call.callControlId, "call.hangup");
    expect(h.call(call.sessionId)?.end_reason).toBe("callback_requested");
    expect((await queue(h)).open).toHaveLength(1);
  });

  it("shows a plain abandonment separately from a requested callback", async () => {
    const { h, call } = await waiting();
    await h.legEvent(call.callControlId, "call.hangup");
    expect((await queue(h)).open[0].origin).toMatchObject({ kind: "missed", digit: null, requestedAt: null });
  });

  it("does not reopen a request already resolved before the customer hangup arrives", async () => {
    const { h, call } = await waiting();
    await h.legEvent(call.callControlId, "call.gather.ended", { status: "valid", digits: "1", client_state: gather(h) });
    h.db.update("motorist_callback_requests", { status: "done", resolved_at: h.now().toISOString() }, () => true);
    await h.legEvent(call.callControlId, "call.hangup");
    const result = await queue(h);
    expect(result.open).toHaveLength(0);
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].origin?.kind).toBe("requested");
  });

  it("records the actual configured IVR digit 2, not a fabricated 1", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.neutral });
    await h.legEvent(call.callControlId, "call.gather.ended", { digits: "2", status: "valid", client_state: gather(h) });
    expect((await queue(h)).open[0]).toMatchObject({ source: "ivr", origin: { kind: "requested", digit: "2", context: "ivr" } });
  });

  it.each(["retry", "hangup"])("does not announce success before persistence and recovers the choice after a failed insert via %s", async (recovery) => {
    const { h, call } = await waiting();
    const state = gather(h);
    const extra = { status: "valid", digits: "1", client_state: state };
    h.db.failNext("motorist_callback_requests", "insert", "database temporarily unavailable");
    await h.legEvent(call.callControlId, "call.gather.ended", extra, "retry-choice");
    expect(h.rows("motorist_callback_requests")).toHaveLength(0);
    expect(h.telnyx.of("playbackStart").filter((command) => String(command.params.audioUrl).includes("callback-confirmed"))).toHaveLength(0);
    if (recovery === "retry") {
      h.advance(31_000); // The webhook ledger retains failed claims for 30 seconds.
      await h.legEvent(call.callControlId, "call.gather.ended", extra, "retry-choice");
    }
    else await h.legEvent(call.callControlId, "call.hangup");
    expect((await queue(h)).open[0].origin).toMatchObject({ kind: "requested", digit: "1" });
  });
});
