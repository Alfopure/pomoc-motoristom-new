import { afterEach, describe, expect, it, vi } from "vitest";
import { withRequestMetrics } from "@/server/request-metrics";

import { CONNECTION_ID, createTelephonyHarness, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";

import { sessionOwnership } from "../ownership";
import { WEBHOOK_LEASE_POLL_MS } from "../session-runner";
import { sweepOverdueRingSteps } from "../routing/ring-plan";
import { encodeClientState } from "./client-state";
import { INLINE_DRAIN_BUDGET_MS, processTelnyxEvent, replayDeferredSessionEvents } from "./event-processor";

// A pass-through spy: every inline sweep still runs the real sweep, its call
// shape is just observable.
vi.mock("../routing/ring-plan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../routing/ring-plan")>();
  return { ...actual, sweepOverdueRingSteps: vi.fn(actual.sweepOverdueRingSteps) };
});

describe("processTelnyxEvent", () => {
  it("audits claim, ownership and actual dispatch under the HTTP request identity", async () => {
    const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
    const envelope = h.envelope("call.initiated", { call_control_id: "timed-call", call_session_id: "timed-provider-session", direction: "incoming", to: NUMBERS.allianz, from: NUMBERS.customer }, "timed-delivery");
    envelope.meta = { attempt: 2, delivered_to: "https://example.test/webhook?private=secret" };
    const response = await withRequestMetrics("call.webhook", async () => Response.json(await h.process(envelope)), { logger: () => {} });
    const result = await response.json();
    expect(result.outcome).toBe("processed");
    const audit = h.rows("motorist_call_events").find(row => row.event_fingerprint === "timed-delivery");
    expect(audit?.normalized_payload).toMatchObject({ timing: { request_id: response.headers.get("x-request-id"), ingress_at: expect.any(String),
      claimed_at: expect.any(String), lease_acquired_at: expect.any(String), first_command_at: h.now().toISOString(),
      meta: { attempt: 2, delivered_to: "https://example.test/webhook" } } });
    expect(h.logs).toContainEqual(expect.objectContaining({ scope: "lease-timing", outcome: "finished", release_confirmed: true, request_id: response.headers.get("x-request-id") }));
    await h.process(envelope);
    expect(h.logs).toContainEqual(expect.objectContaining({ scope: "webhook-delivery", outcome: "duplicate", meta: { attempt: 2, delivered_to: "https://example.test/webhook" } }));
  });
  it("finishes a successful inbox claim only after releasing ownership", async () => {
    const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
    const rpc = h.client.rpc.bind(h.client);
    const owners: unknown[] = [];
    vi.spyOn(h.client, "rpc").mockImplementation((name, args) => {
      if (name === "motorist_telnyx_finish_webhook_event_v2" && (args as { p_result?: string })?.p_result === "processed") owners.push(sessionOwnership.getStore());
      return rpc(name, args);
    });
    await h.inbound({ to: NUMBERS.allianz });
    expect(owners.length).toBeGreaterThan(0);
    expect(owners.every(owner => owner === undefined)).toBe(true);
  });
  it("acknowledges durable call work before maintenance, with the session lease released", async () => {
    const h = createTelephonyHarness();
    const queued: Array<() => Promise<void>> = [];
    const event = h.envelope("call.initiated", { call_control_id: "fast-webhook", call_session_id: "fast-session", direction: "incoming", to: NUMBERS.allianz, from: NUMBERS.customer }, "fast-event");
    const result = await processTelnyxEvent({ ...h.deps, deferMaintenance: work => queued.push(work) }, event);

    expect(result).toMatchObject({ status: 200, outcome: "processed" });
    expect(h.telnyx.of("answer")).toHaveLength(1);
    expect(h.rows("motorist_telnyx_webhook_events")).toMatchObject([{ event_id: "fast-event", status: "processed" }]);
    expect(h.session(result.sessionId!).lease_token).toBeNull();
    expect(queued).toHaveLength(1);
    const replayReads = () => h.db.log.filter(entry => entry.table === "motorist_telnyx_webhook_events" && entry.operation === "select");
    expect(replayReads()).toHaveLength(0);
    await queued[0]();
    expect(replayReads()).toHaveLength(2);
    expect(h.telnyx.of("answer")).toHaveLength(1);
  });

  it("retains early-answer recovery after the response and awaits it if scheduling is unavailable", async () => {
    for (const schedulingFails of [false, true]) {
      const h = createTelephonyHarness();
      const queued: Array<() => Promise<void>> = [];
      const early = h.envelope("call.answered", { call_control_id: "deferred-early", call_session_id: "deferred-session" }, "deferred-answer");
      expect(await h.process(early)).toMatchObject({ outcome: "awaiting_correlation", status: 500 });
      const result = await processTelnyxEvent({ ...h.deps, deferMaintenance: work => {
        if (schedulingFails) throw new Error("host unavailable");
        queued.push(work);
      } }, h.envelope("call.initiated", { call_control_id: "deferred-early", call_session_id: "deferred-session", direction: "incoming", to: NUMBERS.allianz, from: NUMBERS.customer }, "deferred-init"));
      expect(result).toMatchObject({ status: 200, outcome: "processed" });
      if (!schedulingFails) {
        expect(h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === "deferred-answer")?.status).toBe("failed");
        expect(queued).toHaveLength(1);
        await queued[0]();
      }
      expect(h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === "deferred-answer")).toMatchObject({ status: "processed", attempts: 2 });
      expect(h.session(result.sessionId!).lease_token).toBeNull();
      expect(queued).toHaveLength(schedulingFails ? 0 : 1);
    }
  });

  it("schedules call notifications only after the offered legs have been persisted", async () => {
    const h = createTelephonyHarness();
    const afterResponse: Array<() => void> = [];
    h.deps.onCallTransition = vi.fn((sessionId) => {
      expect(h.session(sessionId).state).toBe("ringing");
      expect(h.attempts(sessionId).some((attempt) => attempt.result === "offered" && attempt.leg_id)).toBe(true);
      afterResponse.push(() => expect(h.session(sessionId).lease_token).toBeNull());
    });
    const call = await h.inbound();
    expect(call.results.every((result) => result.status === 200)).toBe(true);
    expect(h.deps.onCallTransition).toHaveBeenCalledTimes(1);
    afterResponse.forEach((work) => work());
  });

  it("keeps SIP processing successful when optional notification scheduling fails", async () => {
    const h = createTelephonyHarness();
    h.deps.onCallTransition = () => { throw new Error("push scheduling failed"); };
    const call = await h.inbound();
    expect(call.results.every((result) => result.status === 200 && result.outcome === "processed")).toBe(true);
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(h.logs).toContainEqual(expect.objectContaining({ scope: "call-push", message: "notification scheduling unavailable" }));
  });

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

  it("acknowledges completed duplicates but requests redelivery while control processing is busy", async () => {
    const h = createTelephonyHarness();
    const envelope = h.envelope("call.initiated", { call_control_id: "cc-1", call_session_id: "tsess-1", direction: "incoming", to: NUMBERS.allianz, from: NUMBERS.customer }, "evt-dup");
    expect(await h.process(envelope)).toMatchObject({ status: 200, outcome: "processed", claim: { outcome: "claimed", attempts: 1 } });
    expect(await h.process(envelope)).toMatchObject({ status: 200, outcome: "duplicate" });
    expect(h.telnyx.of("answer")).toHaveLength(1);

    h.db.seed("motorist_telnyx_webhook_events", [{ event_id: "evt-busy", event_type: "call.answered", status: "queued", attempts: 1, claimed_at: h.now().toISOString(), payload: {} }]);
    const busy = h.envelope("call.answered", { call_control_id: "cc-1", call_session_id: "tsess-1" }, "evt-busy");
    expect(await h.process(busy)).toMatchObject({ status: 500, outcome: "busy" });
    expect(h.logs).toContainEqual(expect.objectContaining({ scope: "webhook-delivery", outcome: "busy", timing: expect.objectContaining({ ingress_at: expect.any(String) }), meta: { attempt: 1, delivered_to: null } }));
    expect(h.session(String(h.rows("motorist_call_sessions")[0].id)).state).toBe("received");

    // A stale claim (older than 30 s) is taken over and processed.
    h.advance(31_000);
    expect(await h.process(busy)).toMatchObject({ status: 200, outcome: "processed", claim: { outcome: "claimed", attempts: 2 } });
    expect(h.session(String(h.rows("motorist_call_sessions")[0].id)).state).toBe("greeting");
    expect(h.telnyx.of("dial")).toHaveLength(0);
  });

  it("retains allowed-connection events awaiting exact session correlation", async () => {
    const h = createTelephonyHarness();
    const result = await h.process(h.envelope("call.answered", { call_control_id: "cc-unknown", call_session_id: "tsess-unknown" }));
    expect(result).toMatchObject({ status: 500, outcome: "awaiting_correlation" });
    expect(h.rows("motorist_telnyx_webhook_events")[0]).toMatchObject({ status: "failed", retry_state: "awaiting_correlation", effect_failure_count: 0 });
    expect(h.rows("motorist_call_events")).toHaveLength(0);
  });

  it("processes bookkeeping events without the reducer and returns 500 when the database fails", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const from = h.db.log.length;
    const cost = await h.legEvent(call.callControlId, "call.cost", { cost: "0.01" });
    expect(cost).toMatchObject({ status: 200, outcome: "processed", eventClass: "bookkeeping", notes: ["bookkeeping", "lease-free"] });
    expect(h.rows("motorist_call_events").at(-1)).toMatchObject({ event_type: "call.cost", handled_status: "processed" });

    // And without touching the session lease. This is where the redeliveries
    // came from: a callback that arrives while our own invocation holds the
    // lease is deferred, and the provider retries it up to six times — for an
    // event whose whole handling is one row in an unfenced table.
    expect(h.db.log.slice(from).filter((row) => row.table.includes("lease"))).toEqual([]);

    h.db.failNext("motorist_call_events", "insert", "disk full");
    const failed = await h.legEvent(call.callControlId, "call.speak.started", {});
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
    expect(h.logs.filter((entry) => entry.scope === "lease" && entry.message === "lease unavailable; checking whether event can safely proceed")).toHaveLength(1);
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

  it("inline sweep passes the drain with its own budget", async () => {
    const h = createTelephonyHarness({ sweepAfterEvent: true });
    const sweep = vi.mocked(sweepOverdueRingSteps);
    sweep.mockClear();
    const queued: Array<() => Promise<void>> = [];
    const event = h.envelope("call.initiated", { call_control_id: "drain-webhook", call_session_id: "drain-session", direction: "incoming", to: NUMBERS.allianz, from: NUMBERS.customer }, "drain-event");
    expect(await processTelnyxEvent({ ...h.deps, deferMaintenance: work => queued.push(work) }, event)).toMatchObject({ status: 200, outcome: "processed" });
    expect(queued).toHaveLength(1);
    await queued[0]();
    expect(sweep).toHaveBeenCalled();
    const deps = sweep.mock.calls.at(-1)![0];
    expect(deps).toMatchObject({ organizationId: ORG, limit: 2, drainCustomerTerminal: expect.any(Function) });
    expect(deps.drainBudgetMs).toBeLessThanOrEqual(INLINE_DRAIN_BUDGET_MS);
    expect(deps.drainBudgetMs).toBeGreaterThan(deps.budgetMs!);
  });

  it("uses the injected deps end to end with a plain call", async () => {
    const h = createTelephonyHarness();
    const result = await processTelnyxEvent(h.deps, h.envelope("call.initiated", { call_control_id: "cc-9", call_session_id: "tsess-9", connection_id: CONNECTION_ID, direction: "incoming", to: "+4210232408718", from: "0905123456" }));
    expect(result).toMatchObject({ status: 200, outcome: "processed", type: "call.initiated", eventClass: "control" });
    expect(h.rows("motorist_call_sessions")[0]).toMatchObject({ caller_number: "+421905123456", called_number: NUMBERS.allianz, state: "received" });
    expect(h.logs).toContainEqual(expect.objectContaining({ scope: "webhook", outcome: "processed", verified: true }));
  });
  it("replays an early answer when its exact incoming control ID becomes known", async () => {
    const h = createTelephonyHarness();
    const early = h.envelope("call.answered", { call_control_id: "early-cc", call_session_id: "early-provider-session" }, "early-answer");
    expect(await h.process(early)).toMatchObject({ outcome: "awaiting_correlation", status: 500 });
    await h.process(h.envelope("call.initiated", { call_control_id: "early-cc", call_session_id: "early-provider-session", direction: "incoming", to: NUMBERS.allianz, from: NUMBERS.customer }, "later-init"));
    expect(h.db.find("motorist_telnyx_webhook_events", (row) => row.event_id === "early-answer")).toMatchObject({ status: "processed", attempts: 2, delivery_count: 1 });
  });

  it("does not adopt a different unknown leg just because its provider session matches", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const providerSession = h.session(call.sessionId).telnyx_session_id;
    expect(await h.process(h.envelope("call.answered", { call_control_id: "unregistered-leg", call_session_id: providerSession }, "wrong-leg"))).toMatchObject({ status: 500, outcome: "awaiting_correlation" });
    expect(h.db.find("motorist_telnyx_webhook_events", (row) => row.event_id === "wrong-leg")).toMatchObject({ status: "failed", retry_state: "awaiting_correlation" });
  });

  it("expires unmatched events after sixty seconds from first receipt with an incident", async () => {
    const h = createTelephonyHarness();
    const event = h.envelope("call.answered", { call_control_id: "missing-cc" }, "expires");
    expect(await h.process(event)).toMatchObject({ outcome: "awaiting_correlation" });
    const received = h.rows("motorist_telnyx_webhook_events")[0].received_at;
    h.advance(60_001);
    expect(await h.process(event)).toMatchObject({ status: 200, outcome: "unresolved", error: "awaiting_correlation_expired" });
    expect(h.rows("motorist_telnyx_webhook_events")[0]).toMatchObject({ received_at: received, retry_state: "dead_letter", terminal_reason: "awaiting_correlation_expired" });
    expect(h.rows("motorist_job_incidents")).toHaveLength(1);
    expect(h.rows("motorist_call_sessions")).toHaveLength(0);
  });

  it("never creates a customer session for an unmatched credential-connection leg", async () => {
    const h = createTelephonyHarness();
    if (!h.deps.config.configured) throw new Error("Expected configured fixture");
    const result = await h.process(h.envelope("call.initiated", { connection_id: h.deps.config.credentialConnectionId,
      call_control_id: "credential-only", direction: "incoming", to: NUMBERS.allianz, from: NUMBERS.customer }, "credential-event"));
    expect(result).toMatchObject({ status: 500, outcome: "awaiting_correlation" });
    expect(h.rows("motorist_call_sessions")).toHaveLength(0);
    expect(h.rows("motorist_call_legs")).toHaveLength(0);
    expect(h.telnyx.of("answer")).toHaveLength(0);
  });

});

describe("deferred-event self-drain and lease-free ignores (E2)", () => {
  afterEach(() => vi.unstubAllEnvs());
  const acquires = (h: TelephonyHarness) => h.db.log.filter(entry => entry.table === "motorist_session_lease_acquire_v2").length;
  const ledgerSelects = (h: TelephonyHarness) => h.db.log.filter(entry => entry.table === "motorist_telnyx_webhook_events" && entry.operation === "select").length;
  const customerLeg = (h: TelephonyHarness, sessionId: string, callControlId: string) => h.legs(sessionId).find(leg => leg.telnyx_call_control_id === callControlId)!;
  const ledgerRow = (h: TelephonyHarness, eventId: string) => h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === eventId)!;
  const deferredTemplate = (h: TelephonyHarness, call: { telnyxSessionId: string; callControlId: string }) => ({
    organization_id: ORG, call_session_id: call.telnyxSessionId, call_control_id: call.callControlId, connection_id: CONNECTION_ID,
    status: "failed", retry_state: "deferred", attempts: 1, delivery_count: 1, deferral_count: 1, effect_failure_count: 0, contract_version: 2,
    claimed_at: null, next_attempt_at: h.now().toISOString(), received_at: h.now().toISOString(), occurred_at: h.now().toISOString(),
  });

  async function talkingCall(options: Parameters<typeof createTelephonyHarness>[0] = {}) {
    vi.stubEnv("TELNYX_CALL_ACTION_ANNOUNCEMENTS_ENABLED", "false");
    vi.stubEnv("TELNYX_RECORDING_ENABLED", "false");
    const h = createTelephonyHarness(options);
    const call = await h.inbound({ to: NUMBERS.allianz });
    const operator = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    await h.legEvent(operator, "call.answered");
    for (const leg of h.legs(call.sessionId)) {
      if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1 && !leg.ended_at) await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
    }
    expect(h.session(call.sessionId).state).toBe("talking");
    return { h, call, operator };
  }

  async function endedCall() {
    const { h, call, operator } = await talkingCall();
    await h.legEvent(call.callControlId, "call.hangup");
    await h.legEvent(operator, "call.hangup");
    expect(h.session(call.sessionId).state).toBe("ended");
    return { h, call, operator };
  }

  it("drains its own deferred row after the holder releases", async () => {
    // A talking call under the fenced contract; the customer's hangup is the deferred fact.
    const { h, call } = await talkingCall({ writerContract: 2, sweepAfterEvent: false });
    // The poll loop measures `Date.now()`, so a clock-only sleep would spin.
    let draining = false;
    let drainSleeps = 0;
    h.deps.sleep = async ms => {
      if (draining) { drainSleeps += 1; expect(sessionOwnership.getStore()).toBeUndefined(); }
      h.advance(ms);
      await new Promise(resolve => setTimeout(resolve, ms));
    };
    h.deps.random = () => 0;
    // Another invocation holds the lease for the whole callback wait.
    const lease = (name: string, args: Record<string, unknown>) => h.db.rpcHandlers.get(name)!(args, h.db);
    const held = lease("motorist_session_lease_acquire_v2", { p_session_id: call.sessionId, p_token: "holder", p_ttl_ms: 30_000 }) as { generation: number } | null;
    const generation = Number(held?.generation);
    expect(generation).toBeGreaterThan(0);

    const queued: Array<() => Promise<void>> = [];
    const beforeDeferral = acquires(h);
    const result = await processTelnyxEvent({ ...h.deps, deferMaintenance: work => { queued.push(work); } }, h.envelope("call.hangup", {
      call_control_id: call.callControlId, call_session_id: call.telnyxSessionId, hangup_cause: "normal_clearing",
      client_state: encodeClientState(h.clientStateOf(call.callControlId)),
    }, "deferred-hangup"));
    // Not applied yet, but durable and retained by this host: acknowledged instead of redelivered.
    expect(result).toMatchObject({ status: 200, outcome: "deferred", sessionId: call.sessionId });
    expect(ledgerRow(h, "deferred-hangup")).toMatchObject({ retry_state: "deferred", delivery_count: 1, deferral_count: 1, attempts: 1 });
    expect(ledgerRow(h, "deferred-hangup").error).toContain("deferral=lease_busy");
    expect(h.logs).toContainEqual(expect.objectContaining({ scope: "webhook", eventId: "deferred-hangup", deferral: "lease_busy", polls: expect.any(Number), lease_wait_ms: expect.any(Number) }));
    expect(acquires(h) - beforeDeferral).toBeGreaterThan(1);
    expect(acquires(h) - beforeDeferral).toBeLessThanOrEqual(WEBHOOK_LEASE_POLL_MS.length + 1);
    expect(customerLeg(h, call.sessionId, call.callControlId).ended_at).toBeNull();
    // The deferring host retained its own drain and ran nothing inline.
    expect(queued).toHaveLength(1);
    const selectsAfterResponse = ledgerSelects(h);

    expect(lease("motorist_session_lease_release_v2", { p_session_id: call.sessionId, p_token: "holder", p_generation: generation })).toBe(true);
    expect(ledgerSelects(h)).toBe(selectsAfterResponse);
    const before = acquires(h);
    draining = true;
    await queued[0]();
    // One acquire with the webhook budget (the lease was free), after the SQL backoff, outside any ownership scope.
    expect(drainSleeps).toBeGreaterThan(0);
    expect(acquires(h) - before).toBe(1);
    expect(ledgerRow(h, "deferred-hangup").error).toBeNull();
    expect(ledgerRow(h, "deferred-hangup")).toMatchObject({ status: "processed", attempts: 2, delivery_count: 1, deferral_count: 1 });
    expect(customerLeg(h, call.sessionId, call.callControlId).ended_at).toBe(ledgerRow(h, "deferred-hangup").occurred_at);
    expect(h.session(call.sessionId)).toMatchObject({ state: "wrap_up", lease_token: null });
  });

  it("waits read-only while the holder keeps the lease, then finishes the acknowledged delivery itself", async () => {
    const { h, call } = await talkingCall({ writerContract: 2, sweepAfterEvent: false });
    const lease = (name: string, args: Record<string, unknown>) => h.db.rpcHandlers.get(name)!(args, h.db);
    const held = lease("motorist_session_lease_acquire_v2", { p_session_id: call.sessionId, p_token: "holder", p_ttl_ms: 30_000 }) as { generation: number } | null;
    let draining = false;
    let drainSleeps = 0;
    h.deps.random = () => 0;
    h.deps.sleep = async ms => {
      if (draining) {
        drainSleeps += 1;
        expect(sessionOwnership.getStore()).toBeUndefined();
        // The holder finishes while this host is waiting.
        if (drainSleeps === 2) expect(lease("motorist_session_lease_release_v2", { p_session_id: call.sessionId, p_token: "holder", p_generation: Number(held?.generation) })).toBe(true);
      }
      h.advance(ms);
    };
    const queued: Array<() => Promise<void>> = [];
    const result = await processTelnyxEvent({ ...h.deps, deferMaintenance: work => { queued.push(work); } }, h.envelope("call.hangup", {
      call_control_id: call.callControlId, call_session_id: call.telnyxSessionId, hangup_cause: "normal_clearing",
      client_state: encodeClientState(h.clientStateOf(call.callControlId)),
    }, "held-hangup"));
    expect(result).toMatchObject({ status: 200, outcome: "deferred" });
    expect(queued).toHaveLength(1);

    const before = acquires(h);
    draining = true;
    await queued[0]();
    // No acquire polls while the lease was held: exactly one, after it was released.
    expect(drainSleeps).toBeGreaterThanOrEqual(2);
    expect(acquires(h) - before).toBe(1);
    expect(ledgerRow(h, "held-hangup")).toMatchObject({ status: "processed", delivery_count: 1 });
    expect(customerLeg(h, call.sessionId, call.callControlId).ended_at).not.toBeNull();
    expect(h.session(call.sessionId)).toMatchObject({ state: "wrap_up", lease_token: null });
  });

  it("still asks for redelivery when it cannot retain its own drain", async () => {
    const { h, call } = await talkingCall({ writerContract: 2, sweepAfterEvent: false });
    const lease = (name: string, args: Record<string, unknown>) => h.db.rpcHandlers.get(name)!(args, h.db);
    lease("motorist_session_lease_acquire_v2", { p_session_id: call.sessionId, p_token: "holder", p_ttl_ms: 30_000 });
    h.deps.random = () => 0;
    h.deps.sleep = async ms => { h.advance(ms); };
    const result = await processTelnyxEvent({ ...h.deps, deferMaintenance: () => { throw new Error("no request scope"); } }, h.envelope("call.hangup", {
      call_control_id: call.callControlId, call_session_id: call.telnyxSessionId, hangup_cause: "normal_clearing",
      client_state: encodeClientState(h.clientStateOf(call.callControlId)),
    }, "unretained-hangup"));
    expect(result).toMatchObject({ status: 500, outcome: "failed" });
    expect(ledgerRow(h, "unretained-hangup")).toMatchObject({ retry_state: "deferred" });
  });

  it("replays gather/playback/initiated after hangup/answered/bridged", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const now = h.now().getTime();
    const customerState = encodeClientState(h.clientStateOf(call.callControlId));
    h.db.seed("motorist_telnyx_webhook_events", [
      { ...deferredTemplate(h, call), event_id: "deferred-playback", event_type: "call.playback.ended",
        occurred_at: new Date(now - 2_000).toISOString(), payload: { status: "completed", client_state: customerState } },
      { ...deferredTemplate(h, call), event_id: "deferred-hangup", event_type: "call.hangup",
        occurred_at: new Date(now - 1_000).toISOString(), payload: { hangup_cause: "normal_clearing", client_state: customerState } },
    ]);
    const mark = h.db.log.length;
    await replayDeferredSessionEvents(h.deps, call.sessionId);
    // Rank beats occurred_at: the terminal fact goes first even though the audio row is older.
    expect(h.db.log.slice(mark).filter(entry => entry.table === "motorist_telnyx_claim_webhook_event_v2").map(entry => (entry.payload as { p_event_id: string }).p_event_id))
      .toEqual(["deferred-hangup", "deferred-playback"]);
    expect(ledgerRow(h, "deferred-hangup")).toMatchObject({ status: "processed", delivery_count: 1 });
    expect(ledgerRow(h, "deferred-playback")).toMatchObject({ status: "processed", delivery_count: 1 });
    expect(customerLeg(h, call.sessionId, call.callControlId).ended_at).toBe(ledgerRow(h, "deferred-hangup").occurred_at);
    expect(h.rows("motorist_call_events").filter(row => row.event_type === "call.playback.ended").at(-1)).toMatchObject({ handled_status: "ignored" });
  });

  it("drains a deferred operator call.initiated on a terminal session into an orphan hangup", async () => {
    const { h, call } = await endedCall();
    // The dial wrote this leg row before the session ended; its `call.initiated`
    // was deferred behind the terminating holder. Only exact leg ids are drained.
    h.db.insert("motorist_call_legs", { organization_id: ORG, session_id: call.sessionId, role: "operator", profile_id: PROFILES.o1,
      telnyx_call_control_id: "late-operator", state: "initiated", client_state: { sid: call.sessionId, role: "operator", operatorId: PROFILES.o1 } });
    h.db.seed("motorist_telnyx_webhook_events", [{ ...deferredTemplate(h, call), call_control_id: "late-operator", event_id: "late-operator-initiated", event_type: "call.initiated",
      payload: { direction: "outgoing", client_state: encodeClientState({ sid: call.sessionId, role: "operator", operatorId: PROFILES.o1 }) } }]);
    await replayDeferredSessionEvents(h.deps, call.sessionId);
    expect(ledgerRow(h, "late-operator-initiated")).toMatchObject({ status: "processed", delivery_count: 1 });
    expect(h.telnyx.of("hangup").some(command => command.params.callControlId === "late-operator")).toBe(true);
    expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === "late-operator")).toMatchObject({ hangup_cause: "terminal_session" });
  });

  it.each(["call.playback.ended", "call.speak.ended", "call.gather.ended"])("acknowledges %s for an ended customer leg without a lease", async type => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    await h.legEvent(call.callControlId, "call.hangup");
    expect(customerLeg(h, call.sessionId, call.callControlId).ended_at).toBeTruthy();
    const mark = h.db.log.length;
    const queued: Array<() => Promise<void>> = [];
    h.deps.deferMaintenance = work => { queued.push(work); };
    const result = await h.legEvent(call.callControlId, type, { status: "completed" }, "late-audio");
    expect(result).toMatchObject({ status: 200, outcome: "ignored", notes: ["customer leg ended", "lease-free"] });
    expect(h.db.log.slice(mark).filter(entry => entry.table.includes("lease"))).toEqual([]);
    expect(ledgerRow(h, "late-audio")).toMatchObject({ status: "processed" });
    expect(h.rows("motorist_call_events").at(-1)).toMatchObject({ event_type: type, handled_status: "ignored" });
    // Maintenance is retained for the host, not run inline.
    expect(queued).toHaveLength(1);
  });

  it("acknowledges late audio lease-free while the operator is still in wrap-up", async () => {
    const { h, call } = await talkingCall();
    await h.legEvent(call.callControlId, "call.hangup");
    expect(h.session(call.sessionId).state).toBe("wrap_up");
    const mark = h.db.log.length;
    const result = await h.legEvent(call.callControlId, "call.playback.ended", { status: "completed" }, "late-audio");
    expect(result).toMatchObject({ status: 200, outcome: "ignored", notes: ["customer leg ended", "lease-free"] });
    expect(h.db.log.slice(mark).filter(entry => entry.table.includes("lease"))).toEqual([]);
    expect(ledgerRow(h, "late-audio")).toMatchObject({ status: "processed" });
  });

  // The state-only branch: the customer leg is still open, the session is
  // already terminal or in wrap-up. The reducer would ignore the audio anyway
  // (`transitions.test.ts` pins that), so no lease is taken for it.
  it.each([
    ["failed", "call.playback.ended", "playback ended in failed"],
    ["failed", "call.gather.ended", "gather in failed"],
    ["ended", "call.speak.ended", "playback ended in ended"],
    ["wrap_up", "call.gather.ended", "gather in wrap_up"],
  ])("acknowledges late audio lease-free in %s with the customer leg still open (%s)", async (state, type, reason) => {
    const { h, call } = await talkingCall();
    h.db.update("motorist_call_sessions", { state }, row => row.id === call.sessionId);
    expect(customerLeg(h, call.sessionId, call.callControlId).ended_at).toBeNull();
    const before = acquires(h);
    const mark = h.db.log.length;
    const result = await h.legEvent(call.callControlId, type, { status: "completed" }, "late-audio");
    expect(result).toMatchObject({ status: 200, outcome: "ignored", notes: [reason, "lease-free"] });
    expect(acquires(h)).toBe(before);
    expect(h.db.log.slice(mark).filter(entry => entry.table.includes("lease"))).toEqual([]);
    expect(ledgerRow(h, "late-audio")).toMatchObject({ status: "processed" });
    expect(h.rows("motorist_call_events").at(-1)).toMatchObject({ event_type: type, handled_status: "ignored" });
    expect(h.session(call.sessionId).state).toBe(state);
  });

  // The boundary of the lease-free path: initiated/answered need the reducer's
  // orphan hangup and leg insert; hold/unhold write leg state and `sdk_hold`.
  it("never acknowledges call.initiated lease-free on an ended call", async () => {
    const { h, call } = await endedCall();
    const mark = h.db.log.length;
    const result = await h.process(h.envelope("call.initiated", { call_control_id: "late-operator", call_session_id: call.telnyxSessionId, direction: "outgoing",
      client_state: encodeClientState({ sid: call.sessionId, role: "operator", operatorId: PROFILES.o1 }) }, "late-init"));
    expect(result).toMatchObject({ status: 200, outcome: "processed" });
    expect(result.notes).not.toContain("lease-free");
    expect(h.db.log.slice(mark).some(entry => entry.table.includes("lease"))).toBe(true);
    expect(h.telnyx.of("hangup").some(command => command.params.callControlId === "late-operator")).toBe(true);
  });

  it("never acknowledges call.hold lease-free on an ended customer leg", async () => {
    const { h, call } = await endedCall();
    const mark = h.db.log.length;
    const result = await h.legEvent(call.callControlId, "call.hold", {}, "late-hold");
    expect(result).toMatchObject({ status: 200, outcome: "processed" });
    expect(result.notes).not.toContain("lease-free");
    expect(h.db.log.slice(mark).some(entry => entry.table.includes("lease"))).toBe(true);
  });
});
