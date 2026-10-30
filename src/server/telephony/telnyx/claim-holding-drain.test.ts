import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, NUMBERS, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
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
  it("finishes a held fact within one poll of the release, never deferring it in the ledger", async () => {
    const { h, call } = await talkingCall();
    holdLease(h, call.sessionId, 300);
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
    // Released at 300 ms; the fine ladder looks at 100, 250 and 500 ms.
    expect(latency).toBeGreaterThanOrEqual(300);
    expect(latency).toBeLessThanOrEqual(500);
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
