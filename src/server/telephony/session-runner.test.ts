import { afterEach, describe, expect, it, vi } from "vitest";

import { completeAnnouncedAction, completeCallAnnouncements } from "@/test/complete-call-announcements";
import { fakeError } from "@/test/fake-supabase";
import { createTelephonyHarness, LINES, NUMBERS, ORG, PLAN_ID, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";

import { callColleague, createRateLimiter, HANGUP_LEASE_WAIT_MS, hangupCall, parkCall, pickupWaitingCall, startOutboundCall } from "./call-actions";
import { loadRoutingContext, loadSessionSnapshot, WEBHOOK_LEASE_POLL_MS, WEBHOOK_LEASE_WAIT_MS } from "./session-runner";
import { parseTelnyxEnvelope } from "./state/events";
import { readMeta, type SessionRow } from "./state/types";

const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };
const deps = (h: TelephonyHarness) => ({ ...h.deps, rateLimiter: createRateLimiter({ now: () => h.now().getTime() }) });
const inboundTables = [
  "motorist_business_hours", "motorist_business_hours_intervals", "motorist_business_hours_exceptions",
  "motorist_ivr_menus", "motorist_ivr_options", "motorist_ring_plans", "motorist_ring_plan_steps",
  "motorist_ring_groups", "motorist_ring_group_members",
];

afterEach(() => vi.unstubAllEnvs());

describe("session routing setup", () => {
  it.each(["call.playback.ended", "call.speak.ended", "conference.participant.joined", "conference.participant.left"])("keeps passive %s observations independent of fresh routing configuration", async type => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ answer: false });
    const session = { ...h.session(call.sessionId), state: "talking" } as SessionRow;
    const event = parseTelnyxEnvelope(h.envelope(type, { call_control_id: call.callControlId }))!;
    h.db.log.length = 0;
    await loadRoutingContext(h.deps, session, event);
    expect(h.db.log).toEqual([]);
    // An active announcement is a continuation, even with recording disabled.
    const active = { ...session, metadata: { ...(session.metadata as object), announcement_sequence: { id: "pending-action" } } } as SessionRow;
    await loadRoutingContext(h.deps, active, event);
    expect(h.db.log.some(entry => entry.table === "motorist_telephony_settings")).toBe(true);
  });

  it("still loads waiting-room media policy to restart music after a playback completion", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ answer: false });
    const session = { ...h.session(call.sessionId), state: "waiting" } as SessionRow;
    h.db.log.length = 0;
    await loadRoutingContext(h.deps, session, parseTelnyxEnvelope(h.envelope("call.playback.ended", { call_control_id: call.callControlId }))!);
    expect(h.db.log.some(entry => entry.table === "motorist_telephony_settings")).toBe(true);
  });

  it("loads no routing for a known answered bridge fact, but retains it for a first bridge", async () => {
    const h = createTelephonyHarness({ sweepAfterEvent: false });
    const call = await h.inbound({ answer: false });
    const session = h.session(call.sessionId) as SessionRow;
    const event = parseTelnyxEnvelope(h.envelope("call.bridged", { call_control_id: call.callControlId }))!;
    const { legs } = await loadSessionSnapshot(h.deps, call.sessionId);
    h.db.log.length = 0;
    await loadRoutingContext(h.deps, session, event, legs.map(leg => ({ ...leg, answered_at: h.now().toISOString() })));
    expect(h.db.log).toEqual([]);
    await loadRoutingContext(h.deps, session, event, legs);
    expect(h.db.log.some(entry => entry.table === "motorist_telephony_settings")).toBe(true);
    expect(h.db.log.some(entry => entry.table === "motorist_telephony_lines")).toBe(true);
  });

  it("answers an initiated caller before loading unrelated IVR and ring configuration", async () => {
    const h = createTelephonyHarness();
    for (const table of inboundTables) h.db.failNext(table, "select", fakeError("routing unavailable"));
    const call = await h.inbound({ to: NUMBERS.neutral, answer: false });

    expect(call.results[0]).toMatchObject({ status: 200, outcome: "processed" });
    expect(h.telnyx.of("answer")).toHaveLength(1);
    expect(h.telnyx.of("dial")).toHaveLength(0);
    expect(h.db.log.filter(entry => inboundTables.includes(entry.table))).toEqual([]);
    expect(h.db.log.filter(entry => entry.table === "motorist_operator_devices")).toEqual([]);
    // The answered event still checks the actual route; it cannot bypass a
    // broken business-hours/menu configuration and call an arbitrary operator.
    expect(await h.legEvent(call.callControlId, "call.answered")).toMatchObject({ status: 500, outcome: "failed" });
    expect(h.telnyx.of("dial")).toHaveLength(0);
  });

  it("retries an answered event after a transient routing read failure without waiting for cron", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.allianz, answer: false });
    h.db.failNext("motorist_telephony_settings", "select", fakeError("temporary read failure"));
    const eventId = "routing-read-retry";
    expect(await h.legEvent(call.callControlId, "call.answered", {}, eventId)).toMatchObject({ status: 500, outcome: "failed" });
    expect(h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === eventId)).toMatchObject({ status: "failed", claimed_at: null });
    h.advance(500);
    expect(await h.legEvent(call.callControlId, "call.answered", {}, eventId)).toMatchObject({ status: 200, outcome: "processed", claim: { attempts: 2 } });
    expect(h.session(call.sessionId).state).toBe("greeting");
    expect(h.telnyx.of("answer")).toHaveLength(1);
  });

  it.each(["outbound", "internal"] as const)("starts the %s recipient without waiting for unrelated inbound routing", async (direction) => {
    const h = createTelephonyHarness();
    const call = direction === "outbound"
      ? await startOutboundCall(deps(h), actor, { to: NUMBERS.customer, lineId: LINES.neutral })
      : await callColleague(deps(h), actor, { targetProfileId: PROFILES.o2 });
    h.db.log.length = 0;
    for (const table of inboundTables) h.db.failNext(table, "select", fakeError("unrelated inbound routing unavailable"));

    const result = await h.legEvent(call.operatorLegCallControlId, "call.answered");

    expect(result).toMatchObject({ outcome: "processed" });
    expect(h.session(call.sessionId).state).toBe("ringing");
    expect(h.telnyx.of("dial")).toHaveLength(2);
    expect(h.telnyx.of("dial")[1].params.to).toBe(direction === "outbound" ? NUMBERS.customer : "sip:gencred002@sip.telnyx.com");
    expect(h.db.log.filter((entry) => inboundTables.includes(entry.table))).toEqual([]);
  });

  it("still resolves inbound IVR, ring plans and operator eligibility", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.neutral, completeGreeting: false });

    const context = await loadRoutingContext(h.deps, h.session(call.sessionId) as SessionRow);

    expect(context.businessHours).not.toBeNull();
    expect(context.ivr?.options).toHaveLength(2);
    expect(context.ringPlan?.planId).toBe(PLAN_ID);
    expect(context.presence.map((row) => row.profile_id)).toContain(PROFILES.o1);
    expect(context.devices.map((row) => row.profile_id)).toContain(PROFILES.o1);
    expect(context.activeLegCount).toBe(1);
  });

  it("retains explicit saved routing when the original call was outgoing", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const session = h.session(call.sessionId) as SessionRow;
    expect(readMeta(session).ring?.plan).toBeTruthy();

    const context = await loadRoutingContext(h.deps, { ...session, direction: "outbound" });

    expect(context.ringPlan?.planId).toBe(PLAN_ID);
    expect(context.presence.map((row) => row.profile_id)).toContain(PROFILES.o1);
    expect(context.devices.map((row) => row.profile_id)).toContain(PROFILES.o1);
  });

  it.each(["ringing", "waiting", "parked"] as const)("uses the frozen plan in %s while unrelated entry routing is unavailable", async state => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const session = { ...h.session(call.sessionId), state } as SessionRow;
    h.db.log.length = 0;
    for (const table of inboundTables) h.db.failNext(table, "select", fakeError("entry routing unavailable"));

    const context = await loadRoutingContext(h.deps, session);

    expect(context.businessHours).toBeNull();
    expect(context.ivr).toBeNull();
    expect(context.ringPlan?.planId).toBe(PLAN_ID);
    expect(context.presence.map(row => row.profile_id)).toContain(PROFILES.o1);
    expect(context.devices.map(row => row.profile_id)).toContain(PROFILES.o1);
    expect(context.activeLegCount).toBeGreaterThan(0);
    expect(h.db.log.filter(entry => inboundTables.includes(entry.table))).toEqual([]);
    expect(h.db.log.some(entry => entry.table === "motorist_operator_telephony_settings")).toBe(true);
  });

  it("enforces capacity when another operator picks up a parked outgoing call", async () => {
    const h = createTelephonyHarness();
    const call = await startOutboundCall(deps(h), actor, { to: NUMBERS.customer });
    await h.legEvent(call.operatorLegCallControlId, "call.answered");
    const customer = h.legs(call.sessionId).find((leg) => leg.role === "customer")!;
    await h.legEvent(String(customer.telnyx_call_control_id), "call.answered");
    await completeCallAnnouncements(h, call.sessionId);
    await completeAnnouncedAction(h, parkCall(deps(h), actor, call.sessionId));
    await h.legEvent(call.operatorLegCallControlId, "call.hangup");
    h.db.update("motorist_telephony_settings", { max_concurrent_legs: 1 }, () => true);
    const before = h.telnyx.of("dial").length;

    await expect(pickupWaitingCall(deps(h), { profileId: PROFILES.o2, role: "dispatcher" }, call.sessionId)).rejects.toThrow("Kapacita hovorov je obsadená");

    expect(h.session(call.sessionId).state).toBe("parked");
    expect(h.telnyx.of("dial")).toHaveLength(before);
  });

  it("continues to read the current recording policy for outgoing setup", async () => {
    for (const key of ["TELNYX_RECORDING_ENABLED", "TELNYX_RECORDING_CONTRACT_VERIFIED", "RECORDING_PROCESSING_ENABLED"]) vi.stubEnv(key, "true");
    const h = createTelephonyHarness();
    h.db.insert("motorist_call_recording_policies", { organization_id: ORG, revision: 1, recording_enabled: true, approved_at: h.now().toISOString(), inbound_enabled: true, outbound_enabled: true, max_segment_seconds: 1800 });
    const call = await startOutboundCall(deps(h), actor, { to: NUMBERS.customer });
    const session = h.session(call.sessionId) as SessionRow;

    expect((await loadRoutingContext(h.deps, session)).recordingPolicy).toMatchObject({ enabled: true, outbound: true });
    h.db.update("motorist_call_recording_policies", { recording_enabled: false }, () => true);
    expect((await loadRoutingContext(h.deps, session)).recordingPolicy?.enabled).toBe(false);
  });
});

describe("per-action lease budget", () => {
  const acquires = (h: TelephonyHarness, from = 0) => h.db.log.slice(from).filter(entry => entry.table === "motorist_session_lease_acquire_v2").length;

  /** Contract 2, operator o1 talking to the customer, and a lease nobody can take. */
  async function talkingBehindHeldLease() {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
    const call = await h.inbound({ to: NUMBERS.allianz });
    const winner = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
    await h.legEvent(winner, "call.answered");
    for (const leg of h.legs(call.sessionId)) {
      if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1 && !leg.ended_at) await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
    }
    expect(h.session(call.sessionId)).toMatchObject({ state: "talking", writer_contract: 2 });
    h.db.registerRpc("motorist_session_lease_acquire_v2", () => null);
    h.deps.random = () => 0;
    // The harness sleep only moves the harness clock; the v2 wait loop reads
    // `Date.now()`, so it needs real timers driven under fake time.
    h.deps.sleep = ms => new Promise<void>(resolve => setTimeout(resolve, ms));
    h.db.log.length = 0;
    h.telnyx.calls.length = 0;
    return { h, sid: call.sessionId, customerCc: call.callControlId };
  }

  it("hangup waits longer than a webhook for the lease and keeps its durable intent", async () => {
    const { h, sid, customerCc } = await talkingBehindHeldLease();
    vi.useFakeTimers();
    try {
      const started = Date.now();
      const pending = hangupCall(h.deps, actor, sid).catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      const error = await pending;
      expect(error).toMatchObject({
        name: "SessionLeaseBusyError", status: 503, code: "session_busy", retryAfterMs: 1000,
        details: { leaseWaitMs: HANGUP_LEASE_WAIT_MS, eventType: "app.hangup" },
      });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(HANGUP_LEASE_WAIT_MS);
      expect(elapsed).toBeLessThan(9_000);
      // More polls than the 3 s interactive budget (7), bounded by the ladder.
      const hangupPolls = acquires(h);
      expect(hangupPolls).toBeGreaterThan(7);
      expect(hangupPolls).toBeLessThanOrEqual(13);
      expect((error as { details: { polls: number } }).details.polls).toBe(hangupPolls);
      // The intent is committed before the wait, so the longer wait loses nothing.
      expect(h.db.log.filter(entry => entry.table === "motorist_session_terminate_v2")).toHaveLength(1);
      expect(h.session(sid).termination_requested_at).toBeTruthy();
      expect(h.telnyx.of("hangup")).toEqual([]);

      // A provider fact on the same held session still gives up well before the operator does.
      const from = h.db.log.length;
      const factStarted = Date.now();
      const factPending = h.legEvent(customerCc, "call.playback.ended", {}, "busy-fact");
      await vi.runAllTimersAsync();
      const fact = await factPending;
      expect(fact).toMatchObject({ status: 500, outcome: "failed" });
      expect(acquires(h, from)).toBeLessThanOrEqual(WEBHOOK_LEASE_POLL_MS.length + 1);
      expect(Date.now() - factStarted).toBeLessThan(HANGUP_LEASE_WAIT_MS);
      const ledger = h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === "busy-fact");
      expect(ledger?.error).toContain("SessionLeaseBusyError");
      expect(ledger?.error).toContain(`lease_wait_ms=${WEBHOOK_LEASE_WAIT_MS}`);
      expect(ledger?.error).toContain("event=call.playback.ended");
    } finally { vi.useRealTimers(); }
  });
});
