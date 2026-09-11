import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, LINES, NUMBERS, ORG, PROFILES } from "@/test/telephony-harness";
import { hangupCall } from "../call-actions";
import { loadRoutingContext, loadSessionSnapshot, runSessionEvent } from "../session-runner";
import { parseTelnyxEnvelope } from "./events";
import { reduce } from "./transitions";

afterEach(() => vi.unstubAllEnvs());

async function talking() {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  const h = createTelephonyHarness({ sweepAfterEvent: false });
  const call = await h.inbound({ to: NUMBERS.allianz });
  const operator = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
  h.telnyx.physical.answered(operator);
  await h.legEvent(operator, "call.answered");
  for (const leg of h.legs(call.sessionId)) {
    if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1) {
      await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup", { hangup_cause: "originator_cancel" });
    }
  }
  expect(h.session(call.sessionId).state).toBe("talking");
  return { h, call, operator };
}

describe("terminal call hangup recovery", () => {
  it.each(["reconciled", "timeout"])("a late %s operator hangup cannot reopen wrap-up from a stale customer-leg snapshot", async (cause) => {
    const { h, call, operator } = await talking();
    const before = await loadSessionSnapshot(h.deps, call.sessionId);
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "caller" });
    const closing = await loadSessionSnapshot(h.deps, call.sessionId);
    expect(closing.session.state).toBe("wrap_up");
    const event = parseTelnyxEnvelope(h.envelope("call.hangup", { call_control_id: operator, hangup_cause: cause }))!;
    const context = await loadRoutingContext(h.deps, closing.session);

    // Session and leg rows are read independently. The session's wrap-up write
    // can be visible before the matching customer-leg hangup write arrives.
    const result = reduce(closing.session, before.legs, closing.attempts, event, context);

    expect(result.next.session.state ?? closing.session.state).toBe("wrap_up");
    expect(result.next.session.metadata).not.toHaveProperty("waiting");
    expect(result.commands).toEqual([]);
    expect(result.next.legs).toContainEqual(expect.objectContaining({ callControlId: operator, values: expect.objectContaining({ state: "ended" }) }));
  });

  it.each(["customer", "operator"] as const)("finishes with %s hangup first and stays ended after repeated hangups", async (first) => {
    const { h, call, operator } = await talking();
    h.advance(28_000);
    const order = first === "customer" ? [call.callControlId, operator] : [operator, call.callControlId];
    for (const cc of order) await h.legEvent(cc, "call.hangup", { hangup_cause: "normal_clearing" });
    expect(h.session(call.sessionId)).toMatchObject({ state: "ended", ended_at: h.now().toISOString() });
    const commands = h.telnyx.calls.length;
    const presence = { ...h.presence(PROFILES.o1) };
    h.advance(5_000);
    for (const cc of [...order].reverse()) await h.legEvent(cc, "call.hangup", { hangup_cause: "reconciled" });
    expect(h.session(call.sessionId).state).toBe("ended");
    expect(h.telnyx.calls).toHaveLength(commands);
    expect(h.presence(PROFILES.o1)).toEqual(presence);
  });

  it.each(["waiting", "parked", "talking"])("explicit hangup closes a stale %s session with all legs ended and preserves its actual end", async (state) => {
    const { h, call, operator } = await talking();
    const boundPresence = { ...h.presence(PROFILES.o1) };
    h.advance(28_000);
    const endedAt = h.now().toISOString();
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "caller" });
    await h.legEvent(operator, "call.hangup", { hangup_cause: "normal_clearing" });
    h.db.update("motorist_call_sessions", { state, ended_at: null }, (row) => row.id === call.sessionId);
    h.setPresence(PROFILES.o1, boundPresence);
    const commands = h.telnyx.calls.length;
    h.advance(5 * 60_000);

    const result = await hangupCall(h.deps, { profileId: PROFILES.o1, role: "dispatcher" }, call.sessionId);

    expect(result.state).toBe("ended");
    expect(h.session(call.sessionId)).toMatchObject({ state: "ended", ended_at: endedAt });
    expect(h.call(call.sessionId)).toMatchObject({ status: "ended", end_reason: "caller_hangup", ended_at: endedAt, duration_seconds: 28 });
    expect(h.telnyx.calls).toHaveLength(commands);
    expect(h.presence(PROFILES.o1).current_session_id).toBeNull();
  });

  it("the sweep repairs an all-closed waiting call without changing the historical call end", async () => {
    const { h, call, operator } = await talking();
    h.advance(28_000);
    const endedAt = h.now().toISOString();
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "caller" });
    await h.legEvent(operator, "call.hangup", { hangup_cause: "normal_clearing" });
    h.db.update("motorist_call_sessions", { state: "waiting", ended_at: null }, (row) => row.id === call.sessionId);
    // A failed leg is terminal even when its final timestamp was not saved.
    h.db.update("motorist_call_legs", { state: "failed", ended_at: null }, (row) => row.telnyx_call_control_id === operator);
    const commands = h.telnyx.calls.length;
    h.advance(5 * 60_000);

    await runSessionEvent(h.deps, call.sessionId, { kind: "app", type: "sweep", id: "all-closed-sweep", actorProfileId: null, occurredAt: h.now().toISOString() });

    expect(h.session(call.sessionId)).toMatchObject({ state: "ended", ended_at: endedAt });
    expect(h.call(call.sessionId)).toMatchObject({ end_reason: "caller_hangup", ended_at: endedAt, duration_seconds: 28 });
    expect(h.telnyx.calls).toHaveLength(commands);
  });

  it("the sweep retains a known ended customer while another leg is still open", async () => {
    const { h, call } = await talking();
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing" });
    h.db.update("motorist_call_sessions", { state: "waiting" }, (row) => row.id === call.sessionId);
    const commands = h.telnyx.calls.length;
    await runSessionEvent(h.deps, call.sessionId, { kind: "app", type: "sweep", id: "open-operator-sweep", actorProfileId: null, occurredAt: h.now().toISOString() });
    expect(h.session(call.sessionId)).toMatchObject({ state: "waiting", ended_at: null });
    expect(h.telnyx.calls).toHaveLength(commands);
  });

  it("the sweep does not finalize an outbound session before its initial leg exists", async () => {
    const h = createTelephonyHarness({ sweepAfterEvent: false });
    const [session] = h.db.insert("motorist_call_sessions", { organization_id: ORG, direction: "outbound", state: "received", line_id: LINES.allianz, customer_leg_id: null });
    await runSessionEvent(h.deps, String(session.id), { kind: "app", type: "sweep", id: "pending-dial-sweep", actorProfileId: null, occurredAt: h.now().toISOString() });
    expect(h.session(String(session.id))).toMatchObject({ state: "received", ended_at: null });
    expect(h.telnyx.calls).toEqual([]);
  });

  it("still requires ownership before finalizing a stale talking session", async () => {
    const { h, call, operator } = await talking();
    await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing" });
    await h.legEvent(operator, "call.hangup", { hangup_cause: "normal_clearing" });
    h.db.update("motorist_call_sessions", { state: "talking", ended_at: null }, (row) => row.id === call.sessionId);
    await expect(hangupCall(h.deps, { profileId: PROFILES.o2, role: "dispatcher" }, call.sessionId)).rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect(h.session(call.sessionId).state).toBe("talking");
  });
});
