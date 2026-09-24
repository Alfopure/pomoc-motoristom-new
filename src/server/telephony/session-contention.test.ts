import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeQueryBuilder } from "@/test/fake-supabase";
import { registerCriticalWriteRpcs, registerProviderJournalRpcs } from "@/test/fake-stability";
import { createTelephonyHarness, NUMBERS, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";
import { MIN_REMAINING_FOR_RETRY_MS } from "@/lib/telephony/call-control-retry";
import { TELEPHONY_TIMEOUT_MS } from "@/lib/telephony/client-request";
import { HANGUP_LEASE_WAIT_MS, hangupCall, holdCall, PICKUP_LEASE_WAIT_MS, unholdCall } from "./call-actions";
import { LEASE_WAIT_MS, ownedSessionWork, WEBHOOK_LEASE_POLL_MS, WEBHOOK_LEASE_WAIT_MS } from "./session-runner";
import { DEFERRED_DRAIN_DEADLINE_MS, drainCustomerTerminal, INLINE_DRAIN_BUDGET_MS, replayDeferredSessionEvents } from "./telnyx/event-processor";
import { CUSTOMER_DRAIN_MIN_BUDGET_MS, sweepOverdueRingSteps } from "./routing/ring-plan";
import { runSessionEvent } from "./session-runner";
import { readMeta, toJson, type SessionRow } from "./state/types";
import { sessionOwnership } from "./ownership";
import { encodeClientState } from "./telnyx/client-state";

const actor = { profileId: PROFILES.o1, role: "dispatcher" as const };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function contractTwo(h: TelephonyHarness, sessionId: string) {
  let token: unknown = null;
  let generation = 0;
  h.db.storage("motorist_call_sessions").find(row => row.id === sessionId)!.writer_contract = 2;
  const row = () => h.db.storage("motorist_call_sessions").find(entry => entry.id === sessionId)!;
  const stamp = () => {
    row().lease_token = token === null ? null : String(token);
    row().lease_generation = generation;
    row().lease_until = new Date(h.db.now().getTime() + 30_000).toISOString();
  };
  h.db.registerRpc("motorist_session_lease_acquire_v2", args => {
    if (token !== null) return null;
    token = args.p_token;
    generation += 1;
    stamp();
    return { generation, contract: 2 };
  });
  h.db.registerRpc("motorist_session_lease_renew_v2", args => args.p_token === token && args.p_generation === generation);
  h.db.registerRpc("motorist_session_lease_release_v2", args => {
    if (args.p_token !== token || args.p_generation !== generation) return false;
    token = null;
    stamp();
    return true;
  });
  // The leases above are hand-built so this test can stall and steal them; the
  // journal is not, and the provider double goes through it.
  registerProviderJournalRpcs(h.db);
  registerCriticalWriteRpcs(h.db);
  h.db.registerRpc("motorist_provider_observe_dial_v2", () => false);
  h.db.registerRpc("motorist_session_terminate_v2", () => {
    const row = h.db.storage("motorist_call_sessions").find(row => row.id === sessionId)!;
    row.termination_requested_at ??= h.db.nowIso();
    return true;
  });
  h.deps.random = () => 0;
  h.deps.sleep = sleep;
  return { owner: () => token, acquisitions: () => h.db.log.filter(entry => entry.table === "motorist_session_lease_acquire_v2") };
}

async function talking() {
  vi.stubEnv("TELNYX_CALL_ACTION_ANNOUNCEMENTS_ENABLED", "false");
  vi.stubEnv("TELNYX_RECORDING_ENABLED", "false");
  const h = createTelephonyHarness({ sweepAfterEvent: false });
  const call = await h.inbound({ to: NUMBERS.allianz });
  const operator = String(h.legFor(call.sessionId, actor.profileId)!.telnyx_call_control_id);
  await h.legEvent(operator, "call.answered");
  for (const leg of h.legs(call.sessionId)) if (leg.role !== "customer" && leg.profile_id !== actor.profileId) {
    await h.legEvent(String(leg.telnyx_call_control_id), "call.hangup");
  }
  expect(h.session(call.sessionId).state).toBe("talking");
  const clockOffset = h.now().getTime() - Date.now();
  h.db.setNow(() => new Date(Date.now() + clockOffset));
  h.deps.now = () => h.db.now();
  const lease = contractTwo(h, call.sessionId);
  // All selects, updates and RPCs have real asynchronous network latency.
  const originalThen = FakeQueryBuilder.prototype.then;
  vi.spyOn(FakeQueryBuilder.prototype, "then").mockImplementation(function (this: FakeQueryBuilder, resolve, reject) {
    return sleep(5).then(() => originalThen.call(this, resolve, reject));
  });
  h.db.log.length = 0;
  return { h, call, operator, lease };
}

describe("contract-2 session contention", () => {
  it("takes a provider fact that arrives during a short-lived control instead of refusing it", async () => {
    const { h, call, lease } = await talking();
    const holding = gate(), holdAtProvider = gate();
    const conferenceAction = h.telnyx.client.conferenceAction;
    vi.spyOn(h.telnyx.client, "conferenceAction").mockImplementation(async (...args) => {
      if (args[1] === "hold") { holdAtProvider.release(); await holding.promise; }
      return conferenceAction(...args);
    });
    const hold = holdCall(h.deps, actor, call.sessionId);
    await holdAtProvider.promise;
    const before = lease.acquisitions().length;

    // The callback lands while the operator's hold still owns the session, and
    // the hold finishes well inside the callback's waiting window.
    const arriving = h.legEvent(call.callControlId, "call.playback.ended", {}, "brief-contention");
    await sleep(30);
    holding.release();

    // Accepted, so Telnyx has no reason to send it again. Whether the reducer
    // needs this particular fact is beside the point; refusing it was what cost
    // us the redelivery.
    const taken = await arriving;
    expect(taken.status).toBe(200);
    expect(taken.outcome).not.toBe("failed");
    expect(await hold).toMatchObject({ state: "held" });
    // It had to ask more than once, which is the whole point: giving up on the
    // first refusal is what made Telnyx redeliver it.
    expect(lease.acquisitions().length - before).toBeGreaterThan(1);
    expect(h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === "brief-contention")?.status)
      .not.toBe("failed");
  });

  it("lets hold/unhold/hangup finish through simultaneous provider facts, then drains terminal facts without redelivery or cron", async () => {
    const { h, call, operator, lease } = await talking();
    const holding = gate(), holdAtProvider = gate();
    const conferenceAction = h.telnyx.client.conferenceAction;
    vi.spyOn(h.telnyx.client, "conferenceAction").mockImplementation(async (...args) => {
      if (args[1] === "hold") { holdAtProvider.release(); await holding.promise; }
      return conferenceAction(...args);
    });
    const hold = holdCall(h.deps, actor, call.sessionId);
    await holdAtProvider.promise;
    const beforeStorm = lease.acquisitions().length;
    const facts = ["call.playback.ended", "call.speak.ended", "conference.participant.joined", "conference.participant.left", "call.bridged"];
    const storm = await Promise.all(facts.map((type, index) => h.legEvent(call.callControlId, type, {}, `storm-${index}`)));
    expect(storm.every(result => result.status === 500 && result.outcome === "failed")).toBe(true);
    // Each callback now polls the flat ladder inside `WEBHOOK_LEASE_WAIT_MS`
    // (at most `WEBHOOK_LEASE_POLL_MS.length + 1` acquire RPCs) instead of
    // yielding on its first refusal. Giving up at once meant Telnyx redelivered
    // every one of them: 23 of 55 events failed outright on the heaviest test
    // call of 17 Sep, and their provider facts reached the session minutes late
    // through the cron, which is what left the console showing a stale call.
    // The window stays well inside the operator's own budget, so the control
    // below still finishes first; the answer is still a truthful 500 when the
    // lease never comes free.
    const attempts = lease.acquisitions().length - beforeStorm;
    expect(attempts).toBeGreaterThan(facts.length);
    expect(attempts).toBeLessThanOrEqual(facts.length * (WEBHOOK_LEASE_POLL_MS.length + 1));
    expect(h.rows("motorist_telnyx_webhook_events").filter(row => String(row.event_id).startsWith("storm-")))
      .toEqual(facts.map((_, index) => expect.objectContaining({ event_id: `storm-${index}`, retry_state: "deferred", effect_failure_count: 0 })));

    // The user control retries while background callbacks have already yielded.
    const unhold = unholdCall(h.deps, actor, call.sessionId);
    await sleep(25);
    holding.release();
    expect(await hold).toMatchObject({ state: "held" });
    expect(await unhold).toMatchObject({ state: "talking" });
    expect(h.telnyx.of("conference:hold")).toHaveLength(1);
    expect(h.telnyx.of("conference:unhold")).toHaveLength(1);

    const stopping = gate(), stopAtProvider = gate();
    const providerHangup = h.telnyx.client.hangup;
    let paused = false;
    vi.spyOn(h.telnyx.client, "hangup").mockImplementation(async (...args) => {
      const result = await providerHangup(...args);
      if (!paused) { paused = true; stopAtProvider.release(); await stopping.promise; }
      return result;
    });
    const hangup = hangupCall(h.deps, actor, call.sessionId);
    await stopAtProvider.promise;
    const terminals = await Promise.all([
      h.legEvent(call.callControlId, "call.hangup", {}, "customer-terminal"),
      h.legEvent(operator, "call.hangup", {}, "operator-terminal"),
    ]);
    expect(terminals.every(result => result.status === 500)).toBe(true);
    stopping.release();
    expect(await hangup).toMatchObject({ state: "wrap_up" });
    expect(lease.owner()).toBeNull();
    const deferred = h.rows("motorist_telnyx_webhook_events").filter(row => String(row.event_id).endsWith("-terminal"));
    // The owner's response really precedes the SQL retry due time. No timestamp
    // mutation, fake time advance, provider redelivery or cron drives recovery.
    expect(deferred.every(row => Date.parse(String(row.next_attempt_at)) > h.db.now().getTime())).toBe(true);
    const deferredWait = vi.fn(async (ms: number) => {
      expect(sessionOwnership.getStore()).toBeUndefined();
      expect(lease.owner()).toBeNull();
      await sleep(ms);
    });
    const nestedMaintenance = vi.fn();
    await replayDeferredSessionEvents({ ...h.deps, sleep: deferredWait, deferMaintenance: nestedMaintenance }, call.sessionId);
    expect(deferredWait).toHaveBeenCalled();
    expect(nestedMaintenance).not.toHaveBeenCalled();
    for (const eventId of ["customer-terminal", "operator-terminal"]) {
      const row = h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === eventId)!;
      expect(row).toMatchObject({ status: "processed", attempts: 2, delivery_count: 1, deferral_count: 1, effect_failure_count: 0 });
      const leg = h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === row.call_control_id)!;
      expect(leg.ended_at).toBe(row.occurred_at);
    }
    expect(h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === "storm-4")?.status).toBe("failed");
    expect(h.telnyx.physical.legs.get(call.callControlId)?.ended).toBe(true);
    expect(h.telnyx.physical.legs.get(operator)?.ended).toBe(true);
    expect(h.presence(actor.profileId).current_session_id).toBeNull();
    expect(lease.owner()).toBeNull();
  });

  it("does not replay a different leg sharing the provider session or an envelope naming another application session", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ answer: false });
    contractTwo(h, call.sessionId);
    const unrelated = [
      { event_id: "other-control", call_control_id: "other-call-control", payload: {} },
      { event_id: "other-app-session", call_control_id: call.callControlId,
        payload: { client_state: encodeClientState({ sid: "00000000-0000-4000-8000-000000009999", role: "customer" }) } },
    ];
    h.db.seed("motorist_telnyx_webhook_events", unrelated.map(row => ({
      ...row, organization_id: h.deps.organizationId, call_session_id: call.telnyxSessionId,
      connection_id: "app-test", event_type: "call.hangup", status: "failed", retry_state: "deferred",
      next_attempt_at: h.now().toISOString(), occurred_at: h.now().toISOString(), received_at: h.now().toISOString(),
      claimed_at: null, attempts: 1, contract_version: 2, effect_failure_count: 0,
    })));
    const before = h.rows("motorist_telnyx_webhook_events");
    await replayDeferredSessionEvents(h.deps, call.sessionId);
    expect(h.rows("motorist_telnyx_webhook_events")).toEqual(before);
    expect(h.db.log.filter(entry => entry.table === "motorist_session_lease_acquire_v2")).toHaveLength(0);
    expect(h.legs(call.sessionId)[0].ended_at).toBeNull();
  });

  it("bounds an interactive acquisition to adaptive retries and preserves a distinct busy error", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ answer: false });
    contractTwo(h, call.sessionId);
    h.db.registerRpc("motorist_session_lease_acquire_v2", () => null);
    vi.useFakeTimers();
    try {
      const work = vi.fn(async () => "must not execute");
      const pending = expect(ownedSessionWork(h.deps, call.sessionId, work))
        .rejects.toMatchObject({ name: "SessionLeaseBusyError", status: 503, code: "session_busy", retryAfterMs: 1000 });
      await vi.runAllTimersAsync();
      await pending;
      expect(work).not.toHaveBeenCalled();
      expect(h.db.log.filter(entry => entry.table === "motorist_session_lease_acquire_v2")).toHaveLength(7);
    } finally { vi.useRealTimers(); }
  });

  it("gives up a callback wait after the flat ladder, well inside the wall cap", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ answer: false });
    contractTwo(h, call.sessionId);
    h.db.registerRpc("motorist_session_lease_acquire_v2", () => null);
    vi.useFakeTimers();
    try {
      const work = vi.fn(async () => "must not execute");
      const started = Date.now();
      const pending = expect(ownedSessionWork({ ...h.deps, leaseWaitMs: WEBHOOK_LEASE_WAIT_MS }, call.sessionId, work))
        .rejects.toMatchObject({ name: "SessionLeaseBusyError", status: 503, code: "session_busy", retryAfterMs: 1000 });
      await vi.runAllTimersAsync();
      await pending;
      expect(work).not.toHaveBeenCalled();
      expect(h.db.log.filter(entry => entry.table === "motorist_session_lease_acquire_v2")).toHaveLength(WEBHOOK_LEASE_POLL_MS.length + 1);
      expect(Date.now() - started).toBeLessThan(WEBHOOK_LEASE_WAIT_MS);
    } finally { vi.useRealTimers(); }
  });

  it("never retries an ownership database outage as normal contention", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ answer: false });
    contractTwo(h, call.sessionId);
    h.db.failNext("motorist_session_lease_acquire_v2", "rpc", "database unavailable");
    await expect(ownedSessionWork(h.deps, call.sessionId, async () => undefined))
      .rejects.toMatchObject({ name: "SessionEventDeferredError", code: "session_event_deferred" });
    expect(h.db.log.filter(entry => entry.table === "motorist_session_lease_acquire_v2")).toHaveLength(1);
  });
});

describe("sweep yield and drain over a pending customer hangup (E4)", () => {
  afterEach(() => vi.unstubAllEnvs());
  const acquires = (h: TelephonyHarness) => h.db.log.filter(entry => entry.table === "motorist_session_lease_acquire_v2").length;
  const ledgerRow = (h: TelephonyHarness, eventId: string) => h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === eventId)!;

  it("never dials over the caller's pending hangup (0d048f36)", async () => {
    vi.stubEnv("TELNYX_CALL_ACTION_ANNOUNCEMENTS_ENABLED", "false");
    vi.stubEnv("TELNYX_RECORDING_ENABLED", "false");
    const h = createTelephonyHarness({ writerContract: 2, fallbackKind: "waiting_room", sweepAfterEvent: false });
    // The contract-2 fake registers no callback RPC; the missed callback of the final hangup needs one.
    h.db.registerRpc("motorist_create_callback_obligation_v1", async args => {
      const plan = args.p_plan as { callerNumber: string; source: "missed" };
      const inserted = await h.admin.from("motorist_callback_requests").insert({ organization_id: String(args.p_organization_id), session_id: String(args.p_session_id),
        caller_number: plan.callerNumber, source: plan.source, status: "open", created_at: String(args.p_now), metadata: toJson({ callback_obligation_version: 1 }) }).select("*").single();
      if (inserted.error) throw new Error(inserted.error.message);
      return inserted.data;
    });
    for (const id of Object.values(PROFILES)) h.setPresence(id, { status: "offline" });
    const call = await h.inbound({ to: NUMBERS.allianz });
    const backup = h.legByNumber(call.sessionId, NUMBERS.external)!;
    await h.legEvent(String(backup.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });
    expect(h.session(call.sessionId).state).toBe("waiting");
    const customerLeg = () => h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.callControlId)!;
    // The poll loop measures `Date.now()`, so a clock-only sleep would spin.
    let draining = false;
    h.deps.sleep = async ms => {
      if (draining) expect(sessionOwnership.getStore()).toBeUndefined();
      h.advance(ms);
      await new Promise(resolve => setTimeout(resolve, ms));
    };
    h.deps.random = () => 0;

    // (1) The provider says the caller is gone while the queue audio was playing.
    const marked = await h.legEvent(call.callControlId, "call.playback.ended", { status: "call_hangup" });
    expect(marked).toMatchObject({ status: 200, outcome: "processed" });
    expect(readMeta(h.session(call.sessionId) as SessionRow).customer_gone_at).toBe(h.now().toISOString());
    expect(customerLeg().ended_at).toBeNull();

    // (2) The exact hangup loses the lease race and is deferred.
    const lease = (name: string, args: Record<string, unknown>) => h.db.rpcHandlers.get(name)!(args, h.db);
    const held = lease("motorist_session_lease_acquire_v2", { p_session_id: call.sessionId, p_token: "holder", p_ttl_ms: 30_000 }) as { generation: number } | null;
    const generation = Number(held?.generation);
    expect(generation).toBeGreaterThan(0);
    const hangup = await h.legEvent(call.callControlId, "call.hangup", { hangup_cause: "normal_clearing", hangup_source: "caller" }, "cust-hangup");
    expect(hangup).toMatchObject({ status: 500, outcome: "failed" });
    expect(ledgerRow(h, "cust-hangup")).toMatchObject({ retry_state: "deferred", deferral_count: 1 });
    const hangupOccurredAt = String(ledgerRow(h, "cust-hangup").occurred_at);
    expect(lease("motorist_session_lease_release_v2", { p_session_id: call.sessionId, p_token: "holder", p_generation: generation })).toBe(true);

    // (3) An operator becomes available and the queue offer is due; the sweep yields and dials nobody.
    h.setPresence(PROFILES.o1, { status: "available" });
    h.touchDevice(PROFILES.o1);
    h.advance(6_000);
    const dials = h.telnyx.of("dial").length;
    const before = acquires(h);
    const yielded = await sweepOverdueRingSteps({ admin: h.admin, organizationId: h.deps.organizationId, now: h.now, runSessionEvent: (id, event) => runSessionEvent(h.deps, id, event) });
    expect(yielded).toMatchObject({ checked: 1, swept: [], deferred: [call.sessionId], yielded: [call.sessionId], drained: [], errors: [] });
    expect(h.telnyx.of("dial")).toHaveLength(dials);
    expect(acquires(h)).toBe(before);
    expect(h.session(call.sessionId).state).toBe("waiting");

    // (4) A caller with the budget drains the hangup instead of sweeping: still no dial.
    draining = true;
    const drained = await sweepOverdueRingSteps({ admin: h.admin, organizationId: h.deps.organizationId, now: h.now, budgetMs: 20_000,
      runSessionEvent: (id, event) => runSessionEvent(h.deps, id, event), drainCustomerTerminal: session => drainCustomerTerminal(h.deps, session) });
    draining = false;
    expect(drained).toMatchObject({ checked: 1, swept: [], deferred: [call.sessionId], yielded: [call.sessionId], drained: [call.sessionId], errors: [] });
    expect(h.telnyx.of("dial")).toHaveLength(dials);
    expect(ledgerRow(h, "cust-hangup")).toMatchObject({ status: "processed", attempts: 2, delivery_count: 1 });
    expect(customerLeg()).toMatchObject({ ended_at: hangupOccurredAt, hangup_cause: "normal_clearing" });
    expect(h.session(call.sessionId)).toMatchObject({ state: "ended", lease_token: null });
    expect(h.rows("motorist_callback_requests")).toHaveLength(1);

    // (5) The ended session is no longer a candidate.
    const next = await sweepOverdueRingSteps({ admin: h.admin, organizationId: h.deps.organizationId, now: h.now, runSessionEvent: (id, event) => runSessionEvent(h.deps, id, event) });
    expect(next).toMatchObject({ checked: 0, yielded: [], drained: [] });
    expect(h.telnyx.of("dial")).toHaveLength(dials);
  });
});

describe("lease budgets", () => {
  it("keeps one customer-hangup drain inside the budgets that may pay for it", () => {
    // A drain is one webhook-budget lease wait plus the 8 s inbox deadline; checked before the acquire (M17).
    expect(CUSTOMER_DRAIN_MIN_BUDGET_MS).toBeGreaterThanOrEqual(WEBHOOK_LEASE_WAIT_MS + DEFERRED_DRAIN_DEADLINE_MS);
    expect(INLINE_DRAIN_BUDGET_MS).toBeGreaterThanOrEqual(CUSTOMER_DRAIN_MIN_BUDGET_MS);
  });

  it("keeps the webhook wait well under every operator budget", () => {
    expect(LEASE_WAIT_MS).toBe(3_000);
    // A hold/unhold click on the global budget keeps >= 1 s over a competing callback.
    expect(WEBHOOK_LEASE_WAIT_MS).toBeLessThanOrEqual((LEASE_WAIT_MS * 2) / 3);
    expect(PICKUP_LEASE_WAIT_MS).toBeGreaterThan(LEASE_WAIT_MS);
    expect(HANGUP_LEASE_WAIT_MS).toBeGreaterThan(LEASE_WAIT_MS);
    // Wait + preflight + handler must fit one control request with a replay still admissible.
    expect(Math.max(PICKUP_LEASE_WAIT_MS, HANGUP_LEASE_WAIT_MS)).toBeLessThan(TELEPHONY_TIMEOUT_MS.control - MIN_REMAINING_FOR_RETRY_MS);
  });

  it("keeps the callback wait well under the operator budget", () => {
    expect(WEBHOOK_LEASE_WAIT_MS).toBeLessThanOrEqual((2 / 3) * LEASE_WAIT_MS);
    // The flat ladder fits its own wall cap, so the RPC count — not the clock — ends the wait.
    expect(WEBHOOK_LEASE_POLL_MS.reduce((total, step) => total + step, 0)).toBeLessThanOrEqual(WEBHOOK_LEASE_WAIT_MS);
  });
});
