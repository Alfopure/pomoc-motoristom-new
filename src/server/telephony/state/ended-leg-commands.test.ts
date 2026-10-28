import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, NUMBERS, PROFILES } from "@/test/telephony-harness";
import { loadSessionSnapshot, effectsDeps, ownedSessionWork } from "../session-runner";
import { TelnyxCommandError } from "../telnyx/client";
import { cancelRevokedOffers } from "./cancelled-offers";
import { applyReduceResult, type EffectsDeps } from "./effects";
import { emptyTransition, type Command, type ReduceResult, type SessionEvent, type SessionRow } from "./types";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const callGone = () => new TelnyxCommandError({ code: "90018", status: 422, detail: "Call has already ended" });

type Harness = ReturnType<typeof createTelephonyHarness>;

/** Provider commands addressed to one leg, in send order. */
function sentTo(h: Harness, callControlId: string, from = 0) {
  return h.telnyx.calls.slice(from).filter((call) => call.params.callControlId === callControlId).map((call) => call.method);
}

let eventSerial = 0;
async function apply(h: Harness, effects: EffectsDeps, sessionId: string, commands: Command[]) {
  const snapshot = await loadSessionSnapshot(h.deps, sessionId);
  const result: ReduceResult = { next: emptyTransition(), commands, compensations: [], guard: null, ignored: null };
  const event: SessionEvent = { kind: "app", type: "sweep", id: `evt-ended-leg-${++eventSerial}`, actorProfileId: null, occurredAt: h.now().toISOString() };
  return applyReduceResult(effects, { session: snapshot.session, result, event, expectedVersion: snapshot.session.version });
}

const byCommandId = (applied: Awaited<ReturnType<typeof apply>>) => Object.fromEntries(applied.commands.map((outcome) => [outcome.commandId, outcome]));

async function ringingCall(durable = false) {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", String(durable));
  if (durable) vi.stubEnv("TELNYX_RECORDING_ENABLED", "false");
  const h = createTelephonyHarness({ sweepAfterEvent: false, ...(durable ? { writerContract: 2 as const } : {}) });
  const call = await h.inbound({ to: NUMBERS.allianz });
  const operator = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
  return { h, call, operator, customer: { callControlId: call.callControlId } };
}

describe("commands for a leg the provider reported ended (90018)", () => {
  it("stops media follow-ups for that leg, logs once and retires them, but still sends its hangup", async () => {
    const { h, call, operator, customer } = await ringingCall();
    h.telnyx.failNext("playbackStop", callGone());
    const before = h.telnyx.calls.length;
    const logsBefore = h.logs.length;

    const applied = await apply(h, effectsDeps(h.deps), call.sessionId, [
      { kind: "playback_stop", commandId: "cmd-stop", leg: customer, bestEffort: true },
      { kind: "gather_stop", commandId: "cmd-gather-stop", leg: customer, bestEffort: true },
      { kind: "playback_start", commandId: "cmd-moh", leg: customer, media: { key: "moh" }, bestEffort: true },
      // The safety net for an inbound customer leg is never skipped on a 90018 alone.
      { kind: "hangup", commandId: "cmd-hangup-customer", leg: customer, reason: "test", bestEffort: true },
      // Another leg is unaffected by the customer's refusal.
      { kind: "hangup", commandId: "cmd-hangup-operator", leg: { callControlId: operator }, reason: "test", bestEffort: true },
    ]);

    expect(sentTo(h, call.callControlId, before)).toEqual(["playbackStop", "hangup"]);
    expect(sentTo(h, operator, before)).toEqual(["hangup"]);
    expect(applied.failed).toBe(false);
    const outcome = byCommandId(applied);
    expect(outcome["cmd-stop"]).toMatchObject({ ok: false, skipped: false });
    expect(outcome["cmd-gather-stop"]).toMatchObject({ ok: false, skipped: true, detail: { reason: "call_gone", notSent: true } });
    expect(outcome["cmd-moh"]).toMatchObject({ ok: false, skipped: true, detail: { reason: "call_gone", notSent: true } });
    expect(outcome["cmd-hangup-customer"]).toMatchObject({ ok: true, skipped: false });
    expect(outcome["cmd-hangup-operator"]).toMatchObject({ ok: true, skipped: false });
    const warnings = h.logs.slice(logsBefore).filter((entry) => entry.scope === "effects" && entry.bestEffort === true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ command: "playback_stop" });
  });

  it("refuses a required media command locally with the same call-gone failure, without an incident", async () => {
    const { h, call, customer } = await ringingCall();
    h.telnyx.failNext("playbackStop", callGone());
    const before = h.telnyx.calls.length;

    const applied = await apply(h, effectsDeps(h.deps), call.sessionId, [
      { kind: "playback_stop", commandId: "cmd-stop", leg: customer, bestEffort: true },
      { kind: "playback_start", commandId: "cmd-all-busy", leg: customer, media: { key: "allBusy" } },
    ]);

    expect(h.telnyx.calls.slice(before).map((entry) => entry.method)).toEqual(["playbackStop"]);
    expect(applied.failure).toMatchObject({ callGone: true });
    expect(applied.failure?.error).toMatch(/^90018\(422\):/);
    expect(h.rows("motorist_job_incidents").filter((row) => row.status === "open")).toEqual([]);
  });

  it.each([
    ["a prose-only refusal", new TelnyxCommandError({ code: "10005", status: 422, detail: "Resource does not exist" })],
    ["another call-gone code", new TelnyxCommandError({ code: "90003", status: 422, detail: "Call control id invalid" })],
  ])("does not treat %s as proof that the leg ended", async (_label, refusal) => {
    const { h, call, customer } = await ringingCall();
    h.telnyx.failNext("playbackStop", refusal);
    const before = h.telnyx.calls.length;

    await apply(h, effectsDeps(h.deps), call.sessionId, [
      { kind: "playback_stop", commandId: "cmd-stop", leg: customer, bestEffort: true },
      { kind: "gather_stop", commandId: "cmd-gather-stop", leg: customer, bestEffort: true },
    ]);

    expect(sentTo(h, call.callControlId, before)).toEqual(["playbackStop", "gatherStop"]);
  });
});

describe("commands for a leg this invocation hung up", () => {
  it("refuses every later command for that leg, including STOP and a different hangup", async () => {
    const { h, call, customer } = await ringingCall();
    const before = h.telnyx.calls.length;

    const applied = await apply(h, effectsDeps(h.deps), call.sessionId, [
      { kind: "hangup", commandId: "cmd-hangup", leg: customer, reason: "test", bestEffort: true },
      { kind: "playback_stop", commandId: "cmd-stop", leg: customer, bestEffort: true },
      { kind: "recording_stop", commandId: "cmd-record-stop", leg: customer, recorderId: "recorder-1", epoch: 1, bestEffort: true },
      { kind: "hangup", commandId: "cmd-hangup-again", leg: customer, reason: "terminal_session", bestEffort: true },
    ]);

    expect(sentTo(h, call.callControlId, before)).toEqual(["hangup"]);
    const outcome = byCommandId(applied);
    expect(outcome["cmd-hangup"]).toMatchObject({ ok: true, skipped: false });
    expect(outcome["cmd-stop"]).toMatchObject({ ok: false, skipped: true, detail: { reason: "call_gone", notSent: true } });
    // Not reported as a STOP that reached the provider.
    expect(outcome["cmd-record-stop"]).toMatchObject({ ok: true, skipped: true, detail: { reason: "call_gone", notSent: true } });
    expect(outcome["cmd-hangup-again"]).toMatchObject({ ok: true, skipped: true, detail: { alreadyGone: true, notSent: true } });
  });

  it("still dispatches a replay of the very hangup that ended the leg", async () => {
    const { h, call, customer } = await ringingCall();
    const effects = effectsDeps(h.deps);
    const hangup: Command = { kind: "hangup", commandId: "cmd-hangup", leg: customer, reason: "test", bestEffort: true };
    const before = h.telnyx.calls.length;

    await apply(h, effects, call.sessionId, [hangup]);
    const replay = await apply(h, effects, call.sessionId, [{ ...hangup }]);
    const other = await apply(h, effects, call.sessionId, [{ ...hangup, commandId: "cmd-hangup-other" }]);

    expect(sentTo(h, call.callControlId, before)).toEqual(["hangup", "hangup"]);
    expect(h.telnyx.of("hangup").slice(-2).map((entry) => entry.params.commandId)).toEqual(["cmd-hangup", "cmd-hangup"]);
    expect(byCommandId(replay)["cmd-hangup"]).toMatchObject({ ok: true, skipped: false });
    expect(byCommandId(other)["cmd-hangup-other"]).toMatchObject({ skipped: true, detail: { alreadyGone: true, notSent: true } });
  });
});

describe("an overlapped teardown run", () => {
  /** Two audio stops on the customer and a losing operator's hangup: one run under contract 2. */
  async function overlapped(ended?: (legs: { customer: string; losing: string }) => Map<string, string | null>) {
    const { h, call, customer } = await ringingCall(true);
    const losing = String(h.legs(call.sessionId).find((leg) => leg.role === "operator" && leg.profile_id !== PROFILES.o1)!.telnyx_call_control_id);
    const many = vi.spyOn(h.telnyx.client, "callActionMany");
    const effects = { ...effectsDeps(h.deps), ...(ended ? { endedLegs: ended({ customer: call.callControlId, losing }) } : {}) };
    const before = h.telnyx.calls.length;
    const applied = await ownedSessionWork(h.deps, call.sessionId, () => apply(h, effects, call.sessionId, [
      { kind: "playback_stop", commandId: "cmd-stop", leg: customer, bestEffort: true },
      { kind: "gather_stop", commandId: "cmd-gather-stop", leg: customer, bestEffort: true },
      { kind: "hangup", commandId: "cmd-hangup-losing", leg: { callControlId: losing }, reason: "answered_elsewhere", bestEffort: true },
    ]));
    return { h, many, sent: h.telnyx.calls.slice(before), outcome: byCommandId(applied) };
  }

  it("sends its members together when no leg is known to have ended", async () => {
    const { many } = await overlapped();
    expect(many).toHaveBeenCalledTimes(1);
    expect(many.mock.calls[0][0]).toHaveLength(3);
  });

  it("never calls the provider when every member is refused locally", async () => {
    // A 90018 on the customer blocks its audio stops; our earlier accepted
    // hangup (another command id) blocks the losing leg's.
    const { many, sent, outcome } = await overlapped(({ customer, losing }) => new Map([[customer, null], [losing, "earlier-hangup"]]));
    expect(many).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(outcome["cmd-stop"]).toMatchObject({ skipped: true, detail: { reason: "call_gone", notSent: true } });
    expect(outcome["cmd-gather-stop"]).toMatchObject({ skipped: true, detail: { reason: "call_gone", notSent: true } });
    expect(outcome["cmd-hangup-losing"]).toMatchObject({ ok: true, skipped: true, detail: { alreadyGone: true, notSent: true } });
  });

  it("still sends the hangup of a leg that is only known by a 90018", async () => {
    const { many, outcome } = await overlapped(({ customer, losing }) => new Map([[customer, null], [losing, null]]));
    expect(many).toHaveBeenCalledTimes(1);
    expect(many.mock.calls[0][0].map((action) => action.action)).toEqual(["hangup"]);
    expect(outcome["cmd-hangup-losing"]).toMatchObject({ ok: true, skipped: false });
  });
});

describe("revoked ring offers", () => {
  it.each([false, true])("hangs each losing leg up exactly once with durable effects=%s", async (durable) => {
    const { h, call, operator } = await ringingCall(durable);
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

    // The customer's hangup tears down only the connected operator.
    const ended = h.telnyx.calls.length;
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(sentTo(h, operator, ended)).toEqual(["hangup"]);
    for (const leg of losing) expect(sentTo(h, leg, ended)).toEqual([]);
    expect(h.session(call.sessionId).state).not.toBe("talking");
  });

  it("still sends the cancellation hangup when the provider evidence cannot be read", async () => {
    const { h, call, operator } = await ringingCall(true);
    await h.legEvent(operator, "call.answered");
    const losing = h.legs(call.sessionId).filter((leg) => leg.role === "operator" && leg.telnyx_call_control_id !== operator && !leg.ended_at)
      .map((leg) => String(leg.telnyx_call_control_id));
    expect(losing.length).toBeGreaterThan(0);
    const session = h.session(call.sessionId) as SessionRow;

    // With readable evidence the accepted hangups prove the legs ended.
    const quiet = h.telnyx.calls.length;
    await cancelRevokedOffers(effectsDeps(h.deps), session);
    for (const leg of losing) expect(sentTo(h, leg, quiet)).toEqual([]);

    h.db.failNext("motorist_provider_commands", "select", "journal unavailable");
    const fallback = h.telnyx.calls.length;
    await cancelRevokedOffers(effectsDeps(h.deps), session);
    for (const leg of losing) expect(sentTo(h, leg, fallback)).toEqual(["hangup"]);
  });

  it("does not skip the cancellation hangup for a leg that is only known by a 90018", async () => {
    const { h, call, operator } = await ringingCall(true);
    await h.legEvent(operator, "call.answered");
    const losing = h.legs(call.sessionId).filter((leg) => leg.role === "operator" && leg.telnyx_call_control_id !== operator && !leg.ended_at)
      .map((leg) => String(leg.telnyx_call_control_id));
    const session = h.session(call.sessionId) as SessionRow;
    h.db.failNext("motorist_provider_commands", "select", "journal unavailable");
    const effects = { ...effectsDeps(h.deps), endedLegs: new Map<string, string | null>(losing.map((leg) => [leg, null])) };
    const before = h.telnyx.calls.length;

    await cancelRevokedOffers(effects, session);

    for (const leg of losing) expect(sentTo(h, leg, before)).toEqual(["hangup"]);
  });
});
