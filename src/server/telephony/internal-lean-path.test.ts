import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { callColleague, createRateLimiter, hangupCall } from "./call-actions";
import { defaultLatencyFlags } from "./latency-flags";
import { readPendingEffects } from "./state/continuation";
import { recordingFrozenOff } from "./state/recording";
import { runSessionEvent } from "./session-runner";
import { readMeta, type SessionRow } from "./state/types";

/**
 * Call-speed S1.1 (`internal_lean_path`): a colleague call takes the paths of a
 * call whose recording is frozen off — the bridge before the history, the
 * fenced row reused for validity, no participant intervals — and nothing about
 * the call's outcome changes.
 */

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };

function harness(lean: boolean) {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  h.deps.latencyFlags = { ...defaultLatencyFlags(), internal_lean_path: lean };
  return h;
}

async function ringing(h: TelephonyHarness) {
  const call = await callColleague({ ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) }, actor,
    { targetProfileId: PROFILES.o2, requestId: "00000000-0000-4000-8000-000000009501" });
  h.telnyx.physical.answered(call.operatorLegCallControlId);
  await h.legEvent(call.operatorLegCallControlId, "call.answered");
  const callee = String(h.openLegFor(call.sessionId, PROFILES.o2)!.telnyx_call_control_id);
  h.telnyx.physical.answered(callee);
  return { call, callee };
}

describe("recordingFrozenOff", () => {
  const session = (direction: string, metadata: Record<string, unknown>) => ({ direction, metadata } as unknown as SessionRow);
  const off = { policy: { enabled: false }, recorders: [], barrier: null, pendingAudio: null };

  it("is today's predicate with the switch off", () => {
    expect(recordingFrozenOff(session("inbound", { recording: off }))).toBe(true);
    expect(recordingFrozenOff(session("inbound", { recording: { ...off, policy: { enabled: true } } }))).toBe(false);
    expect(recordingFrozenOff(session("inbound", { recording: { ...off, recorders: [{ id: "r" }] } }))).toBe(false);
    expect(recordingFrozenOff(session("inbound", { recording: off, announcement_sequence: { id: "s" } }))).toBe(false);
    expect(recordingFrozenOff(session("internal", {}))).toBe(false);
  });

  it("adds only a colleague call without capture state or a pending announcement", () => {
    expect(recordingFrozenOff(session("internal", {}), true)).toBe(true);
    expect(recordingFrozenOff(session("internal", { announcement_sequence: { id: "s" } }), true)).toBe(false);
    expect(recordingFrozenOff(session("outbound", {}), true)).toBe(false);
    expect(recordingFrozenOff(session("inbound", {}), true)).toBe(false);
    expect(recordingFrozenOff(session("internal", { recording: { ...off, policy: { enabled: true } } }), true)).toBe(false);
  });
});

describe("colleague call on the lean path", () => {
  it("sends the bridge before the call history only with the switch on, and ends in the same state", async () => {
    const order = async (lean: boolean) => {
      const h = harness(lean);
      const { call, callee } = await ringing(h);
      const from = h.db.log.length;
      await h.legEvent(callee, "call.answered");
      const log = h.db.log.slice(from);
      const prepare = log.findIndex(row => row.table === "motorist_provider_command_prepare_v2");
      const history = log.findIndex(row => row.table === "motorist_calls");
      return { h, call, prepare, history };
    };
    const off = await order(false), on = await order(true);

    expect(off.history).toBeLessThan(off.prepare);
    expect(on.prepare).toBeLessThan(on.history);
    for (const { h, call } of [off, on]) {
      expect(h.session(call.sessionId).state).toBe("talking");
      expect(h.call(call.sessionId)).toMatchObject({ status: "answered" });
      expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries).toHaveLength(0);
      expect(h.telnyx.of("bridge")).toHaveLength(1);
    }
  });

  it("keeps the call connected when its history write fails, and finishes the history later", async () => {
    const h = harness(true);
    const { call, callee } = await ringing(h);
    h.db.failNext("motorist_calls", "update", "history unavailable");

    await h.legEvent(callee, "call.answered");

    expect(h.session(call.sessionId).state).toBe("talking");
    expect(h.telnyx.of("bridge")).toHaveLength(1);
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries.length).toBeGreaterThan(0);

    // As for any call whose recording is frozen off, the projection is the
    // sweep's durable obligation (the cron's effects recovery runs it too).
    await runSessionEvent(h.deps, call.sessionId, { kind: "app", type: "sweep", id: "recover-history", actorProfileId: null, occurredAt: h.now().toISOString() });
    expect(readPendingEffects(h.session(call.sessionId) as SessionRow).entries).toHaveLength(0);
    expect(h.call(call.sessionId)).toMatchObject({ status: "answered", answered_at: expect.any(String) });
    expect(h.telnyx.of("bridge")).toHaveLength(1);
  });

  it("writes no participant intervals for a colleague call, as no recording can exist", async () => {
    const h = harness(true);
    const { call, callee } = await ringing(h);
    await h.legEvent(callee, "call.answered");
    await h.legEvent(callee, "call.bridged");
    await hangupCall(h.deps, actor, call.sessionId);

    expect(readMeta(h.session(call.sessionId) as SessionRow).recording).toBeUndefined();
    expect(h.rows("motorist_call_participant_intervals")).toEqual([]);
  });
});
