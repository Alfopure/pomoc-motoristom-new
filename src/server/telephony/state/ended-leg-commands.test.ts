import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, NUMBERS, PROFILES } from "@/test/telephony-harness";
import { loadSessionSnapshot, effectsDeps } from "../session-runner";
import { TelnyxCommandError } from "../telnyx/client";
import { applyReduceResult } from "./effects";
import { emptyTransition, type Command, type ReduceResult, type SessionEvent } from "./types";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const callGone = () => new TelnyxCommandError({ code: "90018", status: 422, detail: "Call has already ended" });

/** Provider commands addressed to one leg, in send order. */
function sentTo(h: ReturnType<typeof createTelephonyHarness>, callControlId: string, from = 0) {
  return h.telnyx.calls.slice(from).filter((call) => call.params.callControlId === callControlId).map((call) => call.method);
}

describe("commands for a leg the provider reported ended", () => {
  it("stops follow-up commands for that leg after a best-effort 90018, logs it once and retires them", async () => {
    const h = createTelephonyHarness({ sweepAfterEvent: false });
    const call = await h.inbound({ to: NUMBERS.allianz });
    const operator = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    const snapshot = await loadSessionSnapshot(h.deps, call.sessionId);
    const customer = { callControlId: call.callControlId };
    const commands: Command[] = [
      { kind: "playback_stop", commandId: "cmd-stop", leg: customer, bestEffort: true },
      { kind: "gather_stop", commandId: "cmd-gather-stop", leg: customer, bestEffort: true },
      { kind: "playback_start", commandId: "cmd-moh", leg: customer, media: { key: "moh" }, bestEffort: true },
      { kind: "hangup", commandId: "cmd-hangup-customer", leg: customer, reason: "test", bestEffort: true },
      // Another leg is unaffected by the customer's refusal.
      { kind: "hangup", commandId: "cmd-hangup-operator", leg: { callControlId: operator }, reason: "test", bestEffort: true },
    ];
    const result: ReduceResult = { next: emptyTransition(), commands, compensations: [], guard: null, ignored: null };
    const event: SessionEvent = { kind: "app", type: "sweep", id: "evt-ended-leg", actorProfileId: null, occurredAt: h.now().toISOString() };
    h.telnyx.failNext("playbackStop", callGone());
    const before = h.telnyx.calls.length;
    const logsBefore = h.logs.length;

    const applied = await applyReduceResult(effectsDeps(h.deps), { session: snapshot.session, result, event, expectedVersion: snapshot.session.version });

    expect(sentTo(h, call.callControlId, before)).toEqual(["playbackStop"]);
    expect(sentTo(h, operator, before)).toEqual(["hangup"]);
    expect(applied.failed).toBe(false);
    const byKind = Object.fromEntries(applied.commands.map((outcome) => [outcome.commandId, outcome]));
    expect(byKind["cmd-stop"]).toMatchObject({ ok: false, skipped: false });
    expect(byKind["cmd-gather-stop"]).toMatchObject({ ok: false, skipped: true, detail: { reason: "call_gone", notSent: true } });
    expect(byKind["cmd-moh"]).toMatchObject({ ok: false, skipped: true, detail: { reason: "call_gone", notSent: true } });
    // A hangup for an ended leg is the outcome it asked for.
    expect(byKind["cmd-hangup-customer"]).toMatchObject({ ok: true, skipped: true, detail: { alreadyGone: true } });
    expect(byKind["cmd-hangup-operator"]).toMatchObject({ ok: true, skipped: false });
    const warnings = h.logs.slice(logsBefore).filter((entry) => entry.scope === "effects" && entry.bestEffort === true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ command: "playback_stop" });
  });

  it("refuses a required command for an ended leg locally with the same call-gone failure, without an incident", async () => {
    const h = createTelephonyHarness({ sweepAfterEvent: false });
    const call = await h.inbound({ to: NUMBERS.allianz });
    const operator = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    const snapshot = await loadSessionSnapshot(h.deps, call.sessionId);
    const customer = { callControlId: call.callControlId };
    const result: ReduceResult = { next: emptyTransition(), commands: [
      { kind: "playback_stop", commandId: "cmd-stop", leg: customer, bestEffort: true },
      { kind: "bridge", commandId: "cmd-bridge", leg: customer, target: { callControlId: operator } },
    ], compensations: [], guard: null, ignored: null };
    const event: SessionEvent = { kind: "app", type: "sweep", id: "evt-ended-bridge", actorProfileId: null, occurredAt: h.now().toISOString() };
    h.telnyx.failNext("playbackStop", callGone());
    const before = h.telnyx.calls.length;

    const applied = await applyReduceResult(effectsDeps(h.deps), { session: snapshot.session, result, event, expectedVersion: snapshot.session.version });

    expect(h.telnyx.calls.slice(before).map((entry) => entry.method)).toEqual(["playbackStop"]);
    expect(applied.failure).toMatchObject({ callGone: true });
    expect(applied.failure?.error).toMatch(/^90018\(422\):/);
    expect(h.rows("motorist_job_incidents").filter((row) => row.status === "open")).toEqual([]);
  });

  it.each([
    ["a prose-only refusal", new TelnyxCommandError({ code: "10005", status: 422, detail: "Resource does not exist" })],
    ["another call-gone code", new TelnyxCommandError({ code: "90003", status: 422, detail: "Call control id invalid" })],
  ])("does not treat %s as proof that the leg ended", async (_label, refusal) => {
    const h = createTelephonyHarness({ sweepAfterEvent: false });
    const call = await h.inbound({ to: NUMBERS.allianz });
    const snapshot = await loadSessionSnapshot(h.deps, call.sessionId);
    const customer = { callControlId: call.callControlId };
    const result: ReduceResult = { next: emptyTransition(), commands: [
      { kind: "playback_stop", commandId: "cmd-stop", leg: customer, bestEffort: true },
      { kind: "gather_stop", commandId: "cmd-gather-stop", leg: customer, bestEffort: true },
    ], compensations: [], guard: null, ignored: null };
    const event: SessionEvent = { kind: "app", type: "sweep", id: "evt-prose", actorProfileId: null, occurredAt: h.now().toISOString() };
    h.telnyx.failNext("playbackStop", refusal);
    const before = h.telnyx.calls.length;

    await applyReduceResult(effectsDeps(h.deps), { session: snapshot.session, result, event, expectedVersion: snapshot.session.version });

    expect(sentTo(h, call.callControlId, before)).toEqual(["playbackStop", "gatherStop"]);
  });
});

describe("revoked ring offers", () => {
  it.each([false, true])("hangs each losing leg up once per invocation with durable effects=%s", async (durable) => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", String(durable));
    const h = createTelephonyHarness({ sweepAfterEvent: false, ...(durable ? { writerContract: 2 as const } : {}) });
    const call = await h.inbound({ to: NUMBERS.allianz });
    const operator = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    const losing = h.legs(call.sessionId).filter((leg) => leg.role === "operator" && leg.telnyx_call_control_id !== operator)
      .map((leg) => String(leg.telnyx_call_control_id));
    expect(losing.length).toBeGreaterThan(0);

    const answered = h.telnyx.calls.length;
    await h.legEvent(operator, "call.answered");
    // The answer transition hangs the other offers up; the cancellation pass
    // behind it must not send each of them a second, doomed hangup.
    for (const leg of losing) expect(sentTo(h, leg, answered)).toEqual(["hangup"]);

    // Each losing leg's own `call.hangup` arrives next, while the sibling's has
    // not been recorded yet: neither may be hung up again by that invocation.
    const delivered = h.telnyx.calls.length;
    for (const leg of losing) await h.legEvent(leg, "call.hangup", { hangup_cause: "normal_clearing" });
    for (const leg of losing) expect(sentTo(h, leg, delivered)).toEqual([]);

    const ended = h.telnyx.calls.length;
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing" });
    for (const leg of [operator, ...losing]) expect(sentTo(h, leg, ended).filter((method) => method === "hangup").length).toBeLessThanOrEqual(1);
    expect(h.session(call.sessionId).state).not.toBe("talking");
  });
});
