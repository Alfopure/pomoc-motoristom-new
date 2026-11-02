import { afterEach, describe, expect, it, vi } from "vitest";

import { CONNECTION_ID, createTelephonyHarness, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { replayStalledWebhookEvents } from "../cron-jobs";
import { defaultLatencyFlags } from "../latency-flags";
import { sessionOwnership } from "../ownership";
import { encodeClientState } from "./client-state";
import { HELD_CLAIM_MAX_MS, processTelnyxEvent } from "./event-processor";

/**
 * Call-speed S1.3 (`claim_holding_drain`): a lease-busy control fact keeps its
 * webhook claim and is finished by its own host once the holder releases,
 * without the ledger's ≥ 500 ms deferral backoff.
 */

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function talkingCall(claimHolding = true) {
  vi.stubEnv("TELNYX_CALL_ACTION_ANNOUNCEMENTS_ENABLED", "false");
  vi.stubEnv("TELNYX_RECORDING_ENABLED", "false");
  const h = createTelephonyHarness({ writerContract: 2, sweepAfterEvent: false });
  h.deps.latencyFlags = { ...defaultLatencyFlags(), claim_holding_drain: claimHolding };
  const call = await h.inbound({ to: NUMBERS.allianz });
  const operator = String(h.legFor(call.sessionId, PROFILES.o1)!.telnyx_call_control_id);
  await h.legEvent(operator, "call.answered");
  for (const leg of h.legs(call.sessionId)) {
    if (leg.role !== "customer" && leg.profile_id !== PROFILES.o1 && !leg.ended_at) await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
  }
  expect(h.session(call.sessionId).state).toBe("talking");
  h.deps.random = () => 0;
  // Waiting advances the shared clock; the lease expires on that clock.
  h.deps.sleep = async ms => {
    expect(sessionOwnership.getStore()).toBeUndefined();
    h.advance(ms);
  };
  return { h, call, operator };
}

const ledger = (h: TelephonyHarness, eventId: string) => h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === eventId)!;
const acquires = (h: TelephonyHarness) => h.db.log.filter(entry => entry.table === "motorist_session_lease_acquire_v2").length;
/** Another invocation holds the lease until `ms` from now. */
const holdLease = (h: TelephonyHarness, sessionId: string, ms: number) =>
  h.db.rpcHandlers.get("motorist_session_lease_acquire_v2")!({ p_session_id: sessionId, p_token: "holder", p_ttl_ms: ms }, h.db) as { generation: number };

function hangupEnvelope(h: TelephonyHarness, call: { callControlId: string; telnyxSessionId: string }, id: string) {
  return h.envelope("call.hangup", { call_control_id: call.callControlId, call_session_id: call.telnyxSessionId, hangup_cause: "normal_clearing",
    client_state: encodeClientState(h.clientStateOf(call.callControlId)) }, id);
}

function deliver(h: TelephonyHarness, envelope: unknown, queued: Array<() => Promise<void>>) {
  return processTelnyxEvent({ ...h.deps, deferMaintenance: work => { queued.push(work); } }, envelope);
}

describe("claim-holding drain", () => {
  it("finishes a held fact within one 250 ms poll of the release, never deferring it in the ledger", async () => {
    const { h, call } = await talkingCall();
    holdLease(h, call.sessionId, 600);
    const queued: Array<() => Promise<void>> = [];

    const result = await deliver(h, hangupEnvelope(h, call, "held-hangup"), queued);

    expect(result).toMatchObject({ status: 200, outcome: "deferred", notes: ["claim held"] });
    // Still claimed by this host: not finished, not deferred, no backoff.
    expect(ledger(h, "held-hangup")).toMatchObject({ status: "queued", retry_state: "ready", deferral_count: 0, attempts: 1, next_attempt_at: null });
    expect(ledger(h, "held-hangup").claimed_at).toBeTruthy();
    expect(queued).toHaveLength(1);

    await queued[0]();

    const row = ledger(h, "held-hangup");
    expect(row).toMatchObject({ status: "processed", attempts: 1, deferral_count: 0, delivery_count: 1 });
    const latency = Date.parse(String(row.processed_at)) - Date.parse(String(row.received_at));
    // Released at 600 ms; the reads come at 100, 250, then every 250 ms (500, 750…).
    expect(latency).toBeGreaterThanOrEqual(600);
    expect(latency).toBeLessThanOrEqual(750);
    expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.callControlId)!.ended_at).toBeTruthy();
    expect(h.logs).toContainEqual(expect.objectContaining({ scope: "webhook-latency", eventId: "held-hangup", path: "held_claim", deferrals: 0, heldMs: expect.any(Number) }));
  });

  it("without the switch, defers the row and pays the SQL backoff", async () => {
    const { h, call } = await talkingCall(false);
    holdLease(h, call.sessionId, 300);
    const queued: Array<() => Promise<void>> = [];

    const result = await deliver(h, hangupEnvelope(h, call, "deferred-hangup"), queued);

    expect(result).toMatchObject({ status: 200, outcome: "deferred" });
    expect(result.notes).not.toContain("claim held");
    expect(ledger(h, "deferred-hangup")).toMatchObject({ retry_state: "deferred", deferral_count: 1 });
    await queued[0]();
    const row = ledger(h, "deferred-hangup");
    expect(row.status).toBe("processed");
    expect(Date.parse(String(row.processed_at)) - Date.parse(String(row.received_at))).toBeGreaterThanOrEqual(500);
  });

  it("takes the lease in rank order: a hangup before the bridge that arrived first", async () => {
    const { h, call } = await talkingCall();
    holdLease(h, call.sessionId, 300);
    const queued: Array<() => Promise<void>> = [];
    const bridged = h.envelope("call.bridged", { call_control_id: call.callControlId, call_session_id: call.telnyxSessionId,
      client_state: encodeClientState(h.clientStateOf(call.callControlId)) }, "held-bridged");

    expect(await deliver(h, bridged, queued)).toMatchObject({ status: 200, outcome: "deferred", notes: ["claim held"] });
    expect(await deliver(h, hangupEnvelope(h, call, "held-hangup"), queued)).toMatchObject({ status: 200, outcome: "deferred", notes: ["claim held"] });
    expect(queued).toHaveLength(2);

    await Promise.all(queued.map(work => work()));

    const order = h.logs.filter(entry => entry.scope === "webhook-latency" && ["held-bridged", "held-hangup"].includes(String(entry.eventId))).map(entry => entry.eventId);
    expect(order).toEqual(["held-hangup", "held-bridged"]);
    expect(ledger(h, "held-hangup")).toMatchObject({ status: "processed", deferral_count: 0 });
    expect(ledger(h, "held-bridged")).toMatchObject({ status: "processed", deferral_count: 0 });
  });

  it("takes along a fact that arrives while it waits, still in rank order", async () => {
    const { h, call } = await talkingCall();
    holdLease(h, call.sessionId, 300);
    const queued: Array<() => Promise<void>> = [];
    let joined: Promise<unknown> | null = null;
    h.deps.sleep = async ms => {
      // The hangup is delivered to this host during the bridge's first wait.
      joined ??= deliver(h, hangupEnvelope(h, call, "late-hangup"), queued);
      await joined;
      h.advance(ms);
    };
    const bridged = h.envelope("call.bridged", { call_control_id: call.callControlId, call_session_id: call.telnyxSessionId,
      client_state: encodeClientState(h.clientStateOf(call.callControlId)) }, "early-bridged");
    await deliver(h, bridged, queued);

    await queued[0]();

    expect(await joined).toMatchObject({ status: 200, outcome: "deferred", notes: ["claim held"] });
    expect(queued).toHaveLength(2);
    await queued[1]();
    const order = h.logs.filter(entry => entry.scope === "webhook-latency" && ["early-bridged", "late-hangup"].includes(String(entry.eventId))).map(entry => entry.eventId);
    expect(order).toEqual(["late-hangup", "early-bridged"]);
    expect(ledger(h, "late-hangup")).toMatchObject({ status: "processed", deferral_count: 0 });
    // The shared drain is gone: a late redelivery is an ordinary duplicate.
    expect(await deliver(h, hangupEnvelope(h, call, "late-hangup"), [])).toMatchObject({ status: 200, outcome: "duplicate" });
  });

  it("answers a redelivery during the hold without processing the event twice", async () => {
    const { h, call } = await talkingCall();
    holdLease(h, call.sessionId, 300);
    const queued: Array<() => Promise<void>> = [];
    await deliver(h, hangupEnvelope(h, call, "held-hangup"), queued);

    const redelivered = await deliver(h, hangupEnvelope(h, call, "held-hangup"), queued);

    expect(redelivered).toMatchObject({ status: 200, outcome: "busy", notes: ["claim held by this host"] });
    expect(queued).toHaveLength(1);
    await queued[0]();
    expect(ledger(h, "held-hangup")).toMatchObject({ status: "processed", attempts: 1, delivery_count: 2 });
    expect(h.callEvents(call.sessionId).filter(row => row.event_fingerprint === "held-hangup")).toHaveLength(1);
    // Once finished, a late redelivery is an ordinary duplicate.
    expect(await deliver(h, hangupEnvelope(h, call, "held-hangup"), queued)).toMatchObject({ status: 200, outcome: "duplicate" });
  });

  it("goes back to waiting when the lease is taken again before its turn", async () => {
    const { h, call } = await talkingCall();
    holdLease(h, call.sessionId, 300);
    const queued: Array<() => Promise<void>> = [];
    await deliver(h, hangupEnvelope(h, call, "held-hangup"), queued);
    // A competitor wins the first acquire after the release.
    const acquire = h.db.rpcHandlers.get("motorist_session_lease_acquire_v2")!;
    let refused = 0;
    h.db.registerRpc("motorist_session_lease_acquire_v2", (args, db) => {
      if (args.p_token !== "holder" && refused === 0) { refused += 1; return null; }
      return acquire(args, db);
    });
    const before = acquires(h);

    await queued[0]();

    // One refused acquire (no polling of the RPC), then one that succeeds.
    expect(refused).toBe(1);
    expect(acquires(h) - before).toBe(2);
    expect(ledger(h, "held-hangup")).toMatchObject({ status: "processed", attempts: 1, deferral_count: 0 });
  });

  it("gives the row back to the ledger before the claim could go stale", async () => {
    const { h, call } = await talkingCall();
    holdLease(h, call.sessionId, 30_000);
    const queued: Array<() => Promise<void>> = [];
    await deliver(h, hangupEnvelope(h, call, "held-hangup"), queued);
    const claimedAt = Date.parse(String(ledger(h, "held-hangup").claimed_at));

    await queued[0]();

    const row = ledger(h, "held-hangup");
    expect(row).toMatchObject({ status: "failed", retry_state: "deferred", deferral_count: 1, claimed_at: null });
    expect(String(row.error)).toContain("SessionLeaseBusyError");
    expect(h.now().getTime() - claimedAt).toBeGreaterThanOrEqual(HELD_CLAIM_MAX_MS);
    expect(h.now().getTime() - claimedAt).toBeLessThan(30_000);
    expect(h.logs).toContainEqual(expect.objectContaining({ scope: "webhook", eventId: "held-hangup", message: "held claim left for recovery", reason: "window" }));
  });

  it.each([
    ["is refused before its claim", false],
    ["throws", true],
  ])("gives the row back as deferred when the held run %s, so other drainers see it", async (_name, throws) => {
    const { h, call } = await talkingCall();
    holdLease(h, call.sessionId, 300);
    const logger = h.deps.logger;
    h.deps.logger = entry => {
      if (throws && entry.outcome === "unverified_connection") throw new Error("log sink unavailable");
      logger?.(entry);
    };
    const queued: Array<() => Promise<void>> = [];
    await deliver(h, hangupEnvelope(h, call, "held-hangup"), queued);
    // The run after the wait no longer accepts this connection.
    if (!h.deps.config.configured) throw new Error("Expected configured fixture");
    (h.deps.config as { callControlAppId: string }).callControlAppId = "another-app";

    await queued[0]();

    expect(ledger(h, "held-hangup")).toMatchObject({ status: "failed", retry_state: "deferred", claimed_at: null, deferral_count: 1 });
    expect(h.logs).toContainEqual(expect.objectContaining({ eventId: "held-hangup", message: "held claim left for recovery",
      reason: throws ? "error" : "unverified_connection" }));
  });

  it("starts no waiter after the retaining request's window, even one that joined late", async () => {
    const { h, call } = await talkingCall();
    holdLease(h, call.sessionId, 30_000);
    const queued: Array<() => Promise<void>> = [];
    let slept = 0;
    let joined: Promise<unknown> | null = null;
    h.deps.sleep = async ms => {
      slept += ms;
      // The holder keeps the lease throughout.
      h.db.update("motorist_call_sessions", { lease_until: new Date(h.now().getTime() + 60_000).toISOString() }, row => row.id === call.sessionId);
      if (slept >= 20_000) joined ??= deliver(h, h.envelope("call.bridged", { call_control_id: call.callControlId, call_session_id: call.telnyxSessionId,
        client_state: encodeClientState(h.clientStateOf(call.callControlId)) }, "late-bridged"), queued);
      await joined;
      h.advance(ms);
    };
    await deliver(h, hangupEnvelope(h, call, "held-hangup"), queued);

    await queued[0]();

    // Joined at 20 s with a young claim, still given back at the 30 s window.
    expect(await joined).toMatchObject({ status: 200, outcome: "deferred", notes: ["claim held"] });
    expect(ledger(h, "late-bridged")).toMatchObject({ retry_state: "deferred", claimed_at: null });
    expect(slept).toBeGreaterThanOrEqual(30_000);
    expect(slept).toBeLessThan(31_000);
    expect(h.logs).toContainEqual(expect.objectContaining({ eventId: "late-bridged", message: "held claim left for recovery", reason: "window" }));
  });

  it("drains the session's ready inbox after a held run processed its event", async () => {
    const { h, call, operator } = await talkingCall();
    holdLease(h, call.sessionId, 300);
    const queued: Array<() => Promise<void>> = [];
    // A fact another host deferred in the ledger while the lease was busy.
    h.db.seed("motorist_telnyx_webhook_events", [{ event_id: "deferred-elsewhere", event_type: "call.hangup", organization_id: ORG,
      call_session_id: call.telnyxSessionId, call_control_id: call.callControlId, connection_id: CONNECTION_ID, contract_version: 2,
      status: "failed", retry_state: "deferred", attempts: 1, delivery_count: 1, deferral_count: 1, effect_failure_count: 0, claimed_at: null,
      next_attempt_at: h.now().toISOString(), received_at: h.now().toISOString(), occurred_at: h.now().toISOString(),
      payload: { client_state: encodeClientState(h.clientStateOf(call.callControlId)), hangup_cause: "normal_clearing" } }]);
    const answered = h.envelope("call.answered", { call_control_id: operator, call_session_id: call.telnyxSessionId,
      client_state: encodeClientState(h.clientStateOf(operator)) }, "held-answer");
    await deliver(h, answered, queued);

    await queued[0]();

    expect(ledger(h, "held-answer")).toMatchObject({ status: "processed" });
    expect(ledger(h, "deferred-elsewhere")).toMatchObject({ status: "processed" });
    expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.callControlId)!.ended_at).toBeTruthy();
  });

  it("lets another drain of the session take over a claim its dead host left, once the claim is stale", async () => {
    const { h, call, operator } = await talkingCall();
    const held = holdLease(h, call.sessionId, 300);
    // The retained work never runs: the instance died after answering 200.
    await deliver(h, hangupEnvelope(h, call, "orphaned-hangup"), []);
    expect(h.db.rpcHandlers.get("motorist_session_lease_release_v2")!({ p_session_id: call.sessionId, p_token: "holder", p_generation: held.generation }, h.db)).toBe(true);

    // A fresh claim is untouchable: the next event's inbox drain leaves it alone.
    h.advance(10_000);
    await h.legEvent(operator, "call.answered", {}, "next-1");
    expect(ledger(h, "orphaned-hangup").status).toBe("queued");

    // Stale after 30 s: the next event's drain finishes it, well before the cron.
    h.advance(21_000);
    await h.legEvent(operator, "call.answered", {}, "next-2");
    expect(ledger(h, "orphaned-hangup")).toMatchObject({ status: "processed", attempts: 2 });
    expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.callControlId)!.ended_at).toBeTruthy();
  });

  it("leaves a host that died with the claim to the cron's stalled-event replay", async () => {
    const { h, call } = await talkingCall();
    const held = holdLease(h, call.sessionId, 300);
    // The retained work never runs: the instance died after answering 200.
    await deliver(h, hangupEnvelope(h, call, "orphaned-hangup"), []);
    expect(h.db.rpcHandlers.get("motorist_session_lease_release_v2")!({ p_session_id: call.sessionId, p_token: "holder", p_generation: held.generation }, h.db)).toBe(true);

    // Before the claim is stale and the row old enough, the cron leaves it alone.
    h.advance(20_000);
    await replayStalledWebhookEvents(h.deps);
    expect(ledger(h, "orphaned-hangup").status).toBe("queued");

    h.advance(41_000);
    await replayStalledWebhookEvents(h.deps);

    expect(ledger(h, "orphaned-hangup")).toMatchObject({ status: "processed", attempts: 2 });
    expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.callControlId)!.ended_at).toBeTruthy();
  });
});
