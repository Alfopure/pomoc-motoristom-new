import { describe, expect, it } from "vitest";

import { CONNECTION_ID, createTelephonyHarness, NUMBERS, PROFILES } from "@/test/telephony-harness";

import { processTelnyxEvent } from "./event-processor";

describe("processTelnyxEvent", () => {
  it("rejects malformed envelopes with 400 and never touches the ledger", async () => {
    const h = createTelephonyHarness();
    expect(await h.process({ nope: true })).toMatchObject({ status: 400, outcome: "malformed" });
    expect(await h.process("garbage")).toMatchObject({ status: 400, outcome: "malformed" });
    expect(h.rows("motorist_telnyx_webhook_events")).toHaveLength(0);
  });

  it("ignores events from a connection that is not this environment's", async () => {
    const h = createTelephonyHarness();
    const result = await h.process(h.envelope("call.initiated", { call_control_id: "cc-x", connection_id: "someone-else", direction: "incoming", to: NUMBERS.allianz, from: NUMBERS.customer }));
    expect(result).toMatchObject({ status: 200, outcome: "unverified_connection" });
    expect(h.rows("motorist_telnyx_webhook_events")).toHaveLength(0);
    expect(h.rows("motorist_call_sessions")).toHaveLength(0);
  });

  it("claims each event once: duplicates and busy claims answer 200 without processing", async () => {
    const h = createTelephonyHarness();
    const envelope = h.envelope("call.initiated", { call_control_id: "cc-1", call_session_id: "tsess-1", direction: "incoming", to: NUMBERS.allianz, from: NUMBERS.customer }, "evt-dup");
    expect(await h.process(envelope)).toMatchObject({ status: 200, outcome: "processed", claim: { outcome: "claimed", attempts: 1 } });
    expect(await h.process(envelope)).toMatchObject({ status: 200, outcome: "duplicate" });
    expect(h.telnyx.of("answer")).toHaveLength(1);

    h.db.seed("motorist_telnyx_webhook_events", [{ event_id: "evt-busy", event_type: "call.answered", status: "queued", attempts: 1, claimed_at: h.now().toISOString(), payload: {} }]);
    const busy = h.envelope("call.answered", { call_control_id: "cc-1", call_session_id: "tsess-1" }, "evt-busy");
    expect(await h.process(busy)).toMatchObject({ status: 200, outcome: "busy" });
    expect(h.session(String(h.rows("motorist_call_sessions")[0].id)).state).toBe("received");

    // A stale claim (older than 30 s) is taken over and processed.
    h.advance(31_000);
    expect(await h.process(busy)).toMatchObject({ status: 200, outcome: "processed", claim: { outcome: "claimed", attempts: 2 } });
    expect(h.session(String(h.rows("motorist_call_sessions")[0].id)).state).toBe("ringing");
  });

  it("acknowledges events for unknown sessions and records them without a call", async () => {
    const h = createTelephonyHarness();
    const result = await h.process(h.envelope("call.answered", { call_control_id: "cc-unknown", call_session_id: "tsess-unknown" }));
    expect(result).toMatchObject({ status: 200, outcome: "unknown_session" });
    expect(h.rows("motorist_telnyx_webhook_events")[0]).toMatchObject({ status: "processed" });
    expect(h.rows("motorist_call_events")).toEqual([expect.objectContaining({ event_fingerprint: result.eventId, call_id: null, handled_status: "ignored" })]);
  });

  it("processes bookkeeping events without the reducer and returns 500 when the database fails", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const cost = await h.legEvent(call.callControlId, "call.cost", { cost: "0.01" });
    expect(cost).toMatchObject({ status: 200, outcome: "processed", eventClass: "bookkeeping", notes: ["bookkeeping"] });
    expect(h.rows("motorist_call_events").at(-1)).toMatchObject({ event_type: "call.cost", handled_status: "processed" });

    h.db.failNext("motorist_call_events", "insert", "disk full");
    const failed = await h.legEvent(call.callControlId, "call.speak.ended", {});
    expect(failed).toMatchObject({ status: 500, outcome: "failed" });
    expect(h.rows("motorist_telnyx_webhook_events").at(-1)).toMatchObject({ status: "failed", error: expect.stringContaining("disk full") });
    expect(h.rows("motorist_job_incidents")).toEqual([expect.objectContaining({ job_name: "telephony.telnyx.webhook" })]);
  });

  it("returns 200 for a control event whose processing throws, after recording the failure", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    h.db.failNext("motorist_call_legs", "update", "legs locked");
    const o1 = h.legFor(call.sessionId, PROFILES.o1)!;
    const result = await h.legEvent(String(o1.telnyx_call_control_id), "call.answered");
    expect(result).toMatchObject({ status: 200, outcome: "failed", error: expect.stringContaining("legs locked") });
    expect(h.rows("motorist_telnyx_webhook_events").at(-1)).toMatchObject({ status: "failed" });
    expect(h.rows("motorist_job_incidents")).toEqual([expect.objectContaining({ job_name: "telephony.telnyx.webhook", consecutive_failures: 1 })]);
    // The lease was released, so the retry (after the stale window) succeeds.
    h.advance(31_000);
    const retry = await h.legEvent(String(o1.telnyx_call_control_id), "call.answered");
    expect(retry).toMatchObject({ status: 200, outcome: "processed" });
    expect(h.session(call.sessionId).state).toBe("talking");
  });

  it("returns 500 when the inbound session could not be created (Telnyx must retry)", async () => {
    const h = createTelephonyHarness();
    h.db.failNext("motorist_call_sessions", "insert", "connection reset");

    const result = await h.process(h.envelope("call.initiated", { call_control_id: "cc-boom", call_session_id: "tsess-boom", direction: "incoming", to: NUMBERS.allianz, from: NUMBERS.customer }, "evt-boom"));

    expect(result).toMatchObject({ status: 500, outcome: "failed", sessionId: null, error: expect.stringContaining("connection reset") });
    expect(h.rows("motorist_call_sessions")).toHaveLength(0);
    expect(h.rows("motorist_telnyx_webhook_events").at(-1)).toMatchObject({ status: "failed" });
    // The redelivery after the stale window rescues the call.
    h.advance(31_000);
    const retry = await h.process(h.envelope("call.initiated", { call_control_id: "cc-boom", call_session_id: "tsess-boom", direction: "incoming", to: NUMBERS.allianz, from: NUMBERS.customer }, "evt-boom"));
    expect(retry).toMatchObject({ status: 200, outcome: "processed" });
    expect(h.rows("motorist_call_sessions")).toHaveLength(1);
  });

  it("finds the line even when its stored number is not canonical E.164", async () => {
    const h = createTelephonyHarness();
    h.db.update("motorist_telephony_lines", { phone_number: "02/3240 8718" }, (row) => row.id === "00000000-0000-4000-8000-000000000202");

    const call = await h.inbound({ to: NUMBERS.allianz });

    expect(h.session(call.sessionId).line_id).toBe("00000000-0000-4000-8000-000000000202");
    expect(h.logs.some((entry) => entry.message === "line number is not canonical E.164")).toBe(true);
  });

  it("waits for a contended lease and continues once it is released", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    await h.admin.rpc("motorist_session_lease_acquire", { p_session_id: call.sessionId, p_token: "other-invocation", p_ttl_ms: 4000 });
    let slept = 0;
    h.deps.sleep = async (ms) => {
      slept += ms;
      h.advance(ms);
      if (slept >= 300) await h.admin.rpc("motorist_session_lease_release", { p_session_id: call.sessionId, p_token: "other-invocation" });
    };
    const o1 = h.legFor(call.sessionId, PROFILES.o1)!;
    const result = await h.legEvent(String(o1.telnyx_call_control_id), "call.answered");
    expect(result).toMatchObject({ status: 200, outcome: "processed" });
    expect(slept).toBeGreaterThanOrEqual(300);
    expect(h.logs.some((entry) => entry.scope === "lease")).toBe(false);
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", lease_token: null });
  });

  it("processes anyway (CAS-protected) when the lease cannot be acquired within the budget", async () => {
    const h = createTelephonyHarness({ leaseWaitMs: 500 });
    const call = await h.inbound({ to: NUMBERS.allianz });
    // A holder that keeps renewing its lease.
    h.deps.sleep = async (ms) => {
      h.advance(ms);
      await h.admin.rpc("motorist_session_lease_acquire", { p_session_id: call.sessionId, p_token: "greedy", p_ttl_ms: 4000 });
    };
    await h.admin.rpc("motorist_session_lease_acquire", { p_session_id: call.sessionId, p_token: "greedy", p_ttl_ms: 4000 });
    const o1 = h.legFor(call.sessionId, PROFILES.o1)!;
    const result = await h.legEvent(String(o1.telnyx_call_control_id), "call.answered");
    expect(result).toMatchObject({ status: 200, outcome: "processed" });
    expect(h.logs.filter((entry) => entry.scope === "lease" && entry.message === "processing without lease (CAS protected)")).toHaveLength(1);
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", lease_token: "greedy" });
  });

  it("runs the overdue sweep for other sessions after a control event", async () => {
    const h = createTelephonyHarness({ sweepAfterEvent: true });
    const stuck = await h.inbound({ to: NUMBERS.allianz, callControlId: "cc-stuck", telnyxSessionId: "tsess-stuck" });
    h.advance(30_000);
    const other = await h.inbound({ to: NUMBERS.allianz, callControlId: "cc-other", telnyxSessionId: "tsess-other" });
    expect(other.results.at(-1)).toMatchObject({ outcome: "processed" });
    const attempts = h.attempts(stuck.sessionId).filter((attempt) => attempt.step_index === 0);
    expect(attempts.every((attempt) => attempt.result === "no_answer")).toBe(true);
    expect(h.rows("motorist_call_events").some((row) => row.event_type === "app.sweep")).toBe(true);
  });

  it("uses the injected deps end to end with a plain call", async () => {
    const h = createTelephonyHarness();
    const result = await processTelnyxEvent(h.deps, h.envelope("call.initiated", { call_control_id: "cc-9", call_session_id: "tsess-9", connection_id: CONNECTION_ID, direction: "incoming", to: "+4210232408718", from: "0905123456" }));
    expect(result).toMatchObject({ status: 200, outcome: "processed", type: "call.initiated", eventClass: "control" });
    expect(h.rows("motorist_call_sessions")[0]).toMatchObject({ caller_number: "+421905123456", called_number: NUMBERS.allianz, state: "received" });
    expect(h.logs.at(-1)).toMatchObject({ scope: "webhook", outcome: "processed", verified: true });
  });
});
