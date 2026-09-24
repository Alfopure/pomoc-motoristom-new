import { describe, expect, it, vi } from "vitest";

import { CONNECTION_ID, createTelephonyHarness, NUMBERS, ORG, PROFILES } from "@/test/telephony-harness";

import { encodeClientState } from "./telnyx/client-state";
import { processTelnyxEvent } from "./telnyx/event-processor";
import { AI_DEMO_CLEANUP_JOB, ALERT_JOB, detectStuckSessions, EFFECTS_RECOVERY_JOB, LEDGER_PRUNE_JOB,
  LEDGER_REPLAY_JOB, pruneWebhookLedger, RECONCILE_JOB, reconcileWithTelnyx, replayStalledWebhookEvents, REPLAY_BATCH_SIZE, RING_SWEEP_LIMIT, runRingSweep, runTelephonyCronJobs, RING_SWEEP_JOB, STUCK_SESSION_JOB } from "./cron-jobs";

// A pass-through spy: every replay still runs the real processor, the cron's
// call shape is just observable.
vi.mock("./telnyx/event-processor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./telnyx/event-processor")>();
  return { ...actual, processTelnyxEvent: vi.fn(actual.processTelnyxEvent) };
});

const DAY = 24 * 60 * 60 * 1000;

function seedLedger(h: ReturnType<typeof createTelephonyHarness>) {
  const at = (ms: number) => new Date(h.now().getTime() - ms).toISOString();
  h.db.seed("motorist_telnyx_webhook_events", [
    { organization_id: ORG, event_id: "old-processed", event_type: "call.hangup", status: "processed", attempts: 1, received_at: at(31 * DAY), payload: { a: 1 } },
    { organization_id: ORG, event_id: "old-failed", event_type: "call.hangup", status: "failed", attempts: 3, received_at: at(31 * DAY), payload: { a: 1 } },
    { organization_id: ORG, event_id: "recent-processed", event_type: "call.hangup", status: "processed", attempts: 1, received_at: at(2 * DAY), payload: { a: 1 } },
    { organization_id: ORG, event_id: "playback-8d", event_type: "call.playback.ended", status: "processed", attempts: 1, received_at: at(8 * DAY), payload: { a: 1 } },
    { organization_id: ORG, event_id: "playback-1d", event_type: "call.playback.ended", status: "processed", attempts: 1, received_at: at(1 * DAY), payload: { a: 1 } },
  ]);
}

describe("telephony cron jobs", () => {
  it("skips the ring sweep when telephony is not configured", async () => {
    const h = createTelephonyHarness();
    const result = await runRingSweep({ ...h.deps, telnyx: null });
    expect(result).toMatchObject({ job: RING_SWEEP_JOB, status: "skipped", detail: { reason: "not_configured" } });
  });

  it("runs the overdue ring-step sweep through the session pipeline", async () => {
    const h = createTelephonyHarness({ ivrOnNeutralLine: false });
    const { sessionId } = await h.inbound({ to: "+421232408718" });
    h.advance(60_000);
    const runSession = vi.fn(async () => ({ outcome: "applied" }));

    const result = await runRingSweep({ ...h.deps, runSession });
    expect(result.status).toBe("ok");
    expect(result.detail).toMatchObject({ swept: 1 });
    expect(runSession).toHaveBeenCalledWith(sessionId, expect.objectContaining({ kind: "app", type: "sweep" }), { known: expect.objectContaining({ id: sessionId }) });
  });

  it("reports an active session untouched for longer than the stuck threshold", async () => {
    const h = createTelephonyHarness({ ivrOnNeutralLine: false });
    const { sessionId } = await h.inbound({ to: "+421232408718" });
    h.db.update("motorist_call_sessions", { state: "talking", updated_at: new Date(h.now().getTime() - 20 * 60_000).toISOString() }, (row) => row.id === sessionId);
    const runSession = vi.fn(async () => ({ outcome: "ignored" }));

    const result = await detectStuckSessions({ ...h.deps, runSession });
    expect(result).toMatchObject({ job: STUCK_SESSION_JOB, status: "ok" });
    expect(result.detail).toMatchObject({ stuck: 1, swept: 1 });
    expect(runSession).toHaveBeenCalledTimes(1);
    expect(h.logs.some((entry) => entry.job === STUCK_SESSION_JOB)).toBe(true);
  });

  it("does not sweep a session that was touched recently", async () => {
    const h = createTelephonyHarness({ ivrOnNeutralLine: false });
    await h.inbound({ to: "+421232408718" });
    const runSession = vi.fn(async () => ({ outcome: "ignored" }));

    const result = await detectStuckSessions({ ...h.deps, runSession });
    expect(result.detail).toMatchObject({ stuck: 0, swept: 0 });
    expect(runSession).not.toHaveBeenCalled();
  });

  it("respects the job control switch of the ledger prune", async () => {
    const h = createTelephonyHarness();
    seedLedger(h);
    h.db.seed("motorist_job_controls", [{ job_name: LEDGER_PRUNE_JOB, enabled: false }]);

    const result = await pruneWebhookLedger(h.deps);
    expect(result).toMatchObject({ job: LEDGER_PRUNE_JOB, status: "disabled" });
    expect(h.rows("motorist_telnyx_webhook_events")).toHaveLength(5);
  });

  it("prunes processed ledger rows after 30 days and clears noisy payloads after 7", async () => {
    const h = createTelephonyHarness();
    seedLedger(h);
    h.db.seed("motorist_job_controls", [{ job_name: LEDGER_PRUNE_JOB, enabled: true }]);

    const result = await pruneWebhookLedger(h.deps);
    expect(result.status).toBe("ok");
    expect(result.detail).toMatchObject({ deleted: 1, payloadsCleared: 1 });

    const remaining = h.rows("motorist_telnyx_webhook_events").map((row) => row.event_id).sort();
    expect(remaining).toEqual(["old-failed", "playback-1d", "playback-8d", "recent-processed"]);
    expect(h.db.find("motorist_telnyx_webhook_events", (row) => row.event_id === "playback-8d")?.payload).toBeNull();
    expect(h.db.find("motorist_telnyx_webhook_events", (row) => row.event_id === "playback-1d")?.payload).toEqual({ a: 1 });
  });

  it("replays abandoned and historically exhausted deliveries while preserving fresh claims", async () => {
    const h = createTelephonyHarness();
    const at = (ms: number) => new Date(h.now().getTime() - ms).toISOString();
    h.db.seed("motorist_telnyx_webhook_events", [
      // Abandoned mid-processing: Telnyx will not send it again, so only the cron can.
      { organization_id: ORG, event_id: "stalled", event_type: "call.hangup", status: "queued", attempts: 1, received_at: at(5 * 60_000), occurred_at: at(5 * 60_000), payload: { call_control_id: "cc-1" } },
      // Still within the grace window — the webhook may yet finish it.
      { organization_id: ORG, event_id: "fresh", event_type: "call.hangup", status: "queued", attempts: 1, received_at: at(5_000), payload: { call_control_id: "cc-2" } },
      // Poison row: retried to the cap already.
      { organization_id: ORG, event_id: "exhausted", event_type: "call.hangup", status: "failed", attempts: 5, received_at: at(10 * 60_000), payload: { call_control_id: "cc-3" } },
      { organization_id: ORG, event_id: "done", event_type: "call.hangup", status: "processed", attempts: 1, received_at: at(10 * 60_000), payload: { call_control_id: "cc-4" } },
    ]);
    const replayEvent = vi.fn(async () => ({ outcome: "processed" }));

    const result = await replayStalledWebhookEvents({ ...h.deps, replayEvent });
    expect(result).toMatchObject({ job: LEDGER_REPLAY_JOB, status: "ok", detail: { stalled: 2, replayed: 2 } });
    expect(replayEvent).toHaveBeenCalledTimes(2);
    // The ledger stores the inner payload; the processor is handed a full envelope.
    expect(replayEvent).toHaveBeenCalledWith({ data: { id: "stalled", event_type: "call.hangup", occurred_at: expect.any(String), payload: { call_control_id: "cc-1" } } });
  });

  it("counts a failed processor result as failure and separates ignored replay from recovery", async () => {
    const h = createTelephonyHarness();
    const at = new Date(h.now().getTime() - 120_000).toISOString();
    h.db.seed("motorist_telnyx_webhook_events", ["failed-again", "ended-noop"].map((id) => ({ organization_id: ORG, event_id: id,
      event_type: "call.answered", status: "failed", attempts: 1, received_at: at, occurred_at: at, payload: {} })));
    const replayEvent = vi.fn().mockResolvedValueOnce({ outcome: "failed", status: 200, error: "connection still pending" }).mockResolvedValueOnce({ outcome: "ignored", status: 200 });
    const result = await replayStalledWebhookEvents({ ...h.deps, replayEvent });
    expect(result).toMatchObject({ status: "failed", detail: { attempted: 2, replayed: 1, ignored: 1, failed: 1,
      errors: [{ eventId: "failed-again", error: "connection still pending" }] } });
  });

  it("does not count deferred or rejected processor outcomes as replayed", async () => {
    const h = createTelephonyHarness();
    const at = new Date(h.now().getTime() - 120_000).toISOString();
    const outcomes = ["busy", "duplicate", "unknown_session", "malformed", "unverified_connection"];
    h.db.seed("motorist_telnyx_webhook_events", outcomes.map((id) => ({ organization_id: ORG, event_id: id,
      event_type: "call.answered", status: "failed", attempts: 1, received_at: at, occurred_at: at, payload: {} })));
    const replayEvent = vi.fn(async (envelope: unknown) => ({ outcome: (envelope as { data: { id: string } }).data.id }));
    const result = await replayStalledWebhookEvents({ ...h.deps, replayEvent });
    expect(result).toMatchObject({ status: "failed", detail: { attempted: 5, replayed: 0, deferred: 1, duplicate: 1, unknownSession: 1, failed: 2 } });
  });

  it("skips the replay when telephony is not configured", async () => {
    const h = createTelephonyHarness();
    const result = await replayStalledWebhookEvents({ ...h.deps, telnyx: null });
    expect(result).toMatchObject({ job: LEDGER_REPLAY_JOB, status: "skipped" });
  });

  it("returns one summary per job and stays `ok` when nothing fails", async () => {
    const h = createTelephonyHarness();
    seedLedger(h);
    h.db.seed("motorist_job_controls", [{ job_name: LEDGER_PRUNE_JOB, enabled: true }]);
    h.setPresence(PROFILES.o1, { status: "available" });

    const summary = await runTelephonyCronJobs({ ...h.deps, runSession: vi.fn(async () => ({})) });
    expect(summary.status).toBe("ok");
    expect(summary.configured).toBe(true);
    expect(summary.organizationId).toBe(ORG);
    // Replay first: terminal facts already in the ledger are applied before
    // the sweep dials anybody or closes a leg synthetically.
    expect(summary.jobs.map((job) => job.job)).toEqual([LEDGER_REPLAY_JOB, RING_SWEEP_JOB, EFFECTS_RECOVERY_JOB, RECONCILE_JOB, STUCK_SESSION_JOB, AI_DEMO_CLEANUP_JOB, ALERT_JOB, LEDGER_PRUNE_JOB]);
  });

  it("reports per-job timings", async () => {
    const h = createTelephonyHarness();
    seedLedger(h);
    h.db.seed("motorist_job_controls", [{ job_name: LEDGER_PRUNE_JOB, enabled: true }]);
    h.setPresence(PROFILES.o1, { status: "available" });
    let clock = 0;

    const summary = await runTelephonyCronJobs({ ...h.deps, runSession: vi.fn(async () => ({})), clock: () => (clock += 5) });
    expect(summary.jobs).toHaveLength(8);
    expect(summary.jobs[0].job).toBe(LEDGER_REPLAY_JOB);
    for (const job of summary.jobs) {
      expect(typeof job.ms).toBe("number");
      expect(job.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });

  it("runs replay before the ring sweep", async () => {
    const h = createTelephonyHarness({ ivrOnNeutralLine: false });
    await h.inbound({ to: "+421232408718" });
    h.advance(60_000);
    const at = new Date(h.now().getTime() - 5 * 60_000).toISOString();
    h.db.seed("motorist_telnyx_webhook_events", [{ organization_id: ORG, event_id: "stalled-hangup", event_type: "call.hangup", status: "queued", attempts: 1, received_at: at, occurred_at: at, payload: { call_control_id: "cc-1" } }]);
    const order: string[] = [];
    const runSession = vi.fn(async () => { order.push("sweep"); return { outcome: "applied" }; });
    const replayEvent = vi.fn(async () => { order.push("replay"); return { outcome: "processed" }; });

    await runTelephonyCronJobs({ ...h.deps, runSession, replayEvent });
    expect(order[0]).toBe("replay");
    expect(order).toContain("sweep");
  });

  it("bounds the cron ring sweep by RING_SWEEP_LIMIT and reports the rest as deferred", async () => {
    const h = createTelephonyHarness();
    const overdue = new Date(h.now().getTime() - 1_000).toISOString();
    h.db.seed("motorist_call_sessions", Array.from({ length: RING_SWEEP_LIMIT + 2 }, () => ({ organization_id: ORG, direction: "inbound" as const, state: "ringing", metadata: { ring: { step_deadline_at: overdue } } })));
    const runSession = vi.fn(async () => ({ outcome: "applied" }));

    const result = await runRingSweep({ ...h.deps, runSession });
    expect(runSession).toHaveBeenCalledTimes(RING_SWEEP_LIMIT);
    expect(result.detail).toMatchObject({ checked: RING_SWEEP_LIMIT + 2, swept: RING_SWEEP_LIMIT, deferred: 2 });
  });

  it("stops at the deadline and reports the rest as deferred", async () => {
    const h = createTelephonyHarness();
    const at = new Date(h.now().getTime() - 5 * 60_000).toISOString();
    h.db.seed("motorist_telnyx_webhook_events", ["a", "b", "c"].map((id) => ({ organization_id: ORG, event_id: id,
      event_type: "call.hangup", status: "queued", attempts: 1, received_at: at, occurred_at: at, payload: {} })));
    let clock = 0;
    const replayEvent = vi.fn(async () => { clock += 30_000; return { outcome: "processed" }; });

    const result = await replayStalledWebhookEvents({ ...h.deps, replayEvent, clock: () => clock }, { deadline: 60_000 });
    // Checked at the loop head only: the second row started at 30 s and finished; the third never started.
    expect(replayEvent).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("ok");
    expect(result.detail).toMatchObject({ stalled: 3, attempted: 2, replayed: 2, remaining: 1, deadlineReached: true });
    expect(h.db.find("motorist_telnyx_webhook_events", (row) => row.event_id === "c")).toMatchObject({ status: "queued" });
  });

  it("orders hangup before initiated and replays only one batch of the doubled selection", async () => {
    const h = createTelephonyHarness();
    const at = (ms: number) => new Date(h.now().getTime() - ms).toISOString();
    const row = (id: string, type: string, ageMs: number) => ({ organization_id: ORG, event_id: id, event_type: type, status: "queued", attempts: 1, received_at: at(ageMs), occurred_at: at(ageMs), payload: {} });
    h.db.seed("motorist_telnyx_webhook_events", [
      ...Array.from({ length: 25 }, (_, index) => row(`init-${index}`, "call.initiated", 10 * 60_000 - index * 1_000)),
      row("playback", "call.playback.ended", 5 * 60_000),
      row("answered", "call.answered", 4 * 60_000),
      row("hangup-1", "call.hangup", 3 * 60_000),
      row("hangup-2", "call.hangup", 2 * 60_000),
    ]);
    const types: string[] = [];
    const replayEvent = vi.fn(async (envelope: unknown) => { types.push((envelope as { data: { event_type: string } }).data.event_type); return { outcome: "processed" }; });

    const result = await replayStalledWebhookEvents({ ...h.deps, replayEvent });
    expect(replayEvent).toHaveBeenCalledTimes(REPLAY_BATCH_SIZE);
    expect(types.slice(0, 4)).toEqual(["call.hangup", "call.hangup", "call.answered", "call.initiated"]);
    expect(types).not.toContain("call.playback.ended");
    expect(result.detail).toMatchObject({ stalled: 29, attempted: REPLAY_BATCH_SIZE, replayed: REPLAY_BATCH_SIZE });
  });

  it("replays a deferred row younger than 60 s but never a fresh claim", async () => {
    const h = createTelephonyHarness();
    const at = (ms: number) => new Date(h.now().getTime() - ms).toISOString();
    h.db.seed("motorist_telnyx_webhook_events", [
      // A handler already decided to defer it and its retry is due: age is irrelevant.
      { organization_id: ORG, event_id: "young-deferred", event_type: "call.answered", status: "failed", attempts: 1, retry_state: "deferred", next_attempt_at: at(1_000), received_at: at(10_000), occurred_at: at(10_000), payload: {} },
      { organization_id: ORG, event_id: "young-not-due", event_type: "call.answered", status: "failed", attempts: 1, retry_state: "deferred", next_attempt_at: at(-30_000), received_at: at(10_000), occurred_at: at(10_000), payload: {} },
      // Default retry state within the grace window: the webhook host may still finish it.
      { organization_id: ORG, event_id: "fresh", event_type: "call.answered", status: "queued", attempts: 1, next_attempt_at: null, received_at: at(5_000), occurred_at: at(5_000), payload: {} },
    ]);
    const replayEvent = vi.fn(async () => ({ outcome: "processed" }));

    const result = await replayStalledWebhookEvents({ ...h.deps, replayEvent });
    expect(replayEvent).toHaveBeenCalledTimes(1);
    expect(replayEvent).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ id: "young-deferred" }) }));
    expect(result.detail).toMatchObject({ stalled: 1, attempted: 1, replayed: 1 });
  });

  it("drains the customer's pending hangup before sweeping the queue", async () => {
    const h = createTelephonyHarness({ fallbackKind: "waiting_room" });
    for (const id of Object.values(PROFILES)) h.setPresence(id, { status: "offline" });
    const call = await h.inbound({ to: NUMBERS.allianz });
    const backup = h.legByNumber(call.sessionId, NUMBERS.external)!;
    await h.legEvent(String(backup.telnyx_call_control_id), "call.hangup", { hangup_cause: "no_answer" });
    expect(h.session(call.sessionId).state).toBe("waiting");
    // The customer's exact hangup lost a lease race earlier and waits in the ledger.
    const now = h.now().toISOString();
    h.db.seed("motorist_telnyx_webhook_events", [{
      organization_id: ORG, event_id: "deferred-customer-hangup", event_type: "call.hangup", call_session_id: call.telnyxSessionId, call_control_id: call.callControlId, connection_id: CONNECTION_ID,
      status: "failed", retry_state: "deferred", attempts: 1, delivery_count: 1, deferral_count: 1, effect_failure_count: 0, contract_version: 2,
      claimed_at: null, next_attempt_at: now, received_at: now, occurred_at: now,
      payload: { hangup_cause: "normal_clearing", hangup_source: "caller", client_state: encodeClientState(h.clientStateOf(call.callControlId)) },
    }]);
    h.setPresence(PROFILES.o1, { status: "available" });
    h.touchDevice(PROFILES.o1);
    h.advance(6_000);
    const dials = h.telnyx.of("dial").length;

    const result = await runRingSweep(h.deps);
    expect(result.status).toBe("ok");
    expect(result.detail).toMatchObject({ checked: 1, swept: 0, deferred: 1, yielded: 1, drained: 1 });
    expect(h.telnyx.of("dial")).toHaveLength(dials);
    expect(h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === "deferred-customer-hangup")).toMatchObject({ status: "processed" });
    expect(h.session(call.sessionId).state).toBe("ended");
    expect(h.legs(call.sessionId).find(leg => leg.telnyx_call_control_id === call.callControlId)).toMatchObject({ ended_at: now, hangup_cause: "normal_clearing" });
    expect(h.rows("motorist_callback_requests")).toHaveLength(1);
    expect(h.logs).toContainEqual(expect.objectContaining({ scope: "cron", job: RING_SWEEP_JOB, sweepYielded: 1 }));
  });

  it("replays a row through the processor without nested drain, inline sweep or after() scheduling", async () => {
    // The incident mechanism (E1b): each cron row nested an 8 s correlated
    // drain and a sweep. The cron is a backstop, so the processor runs the row
    // alone and the row's own host keeps the maintenance.
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const now = h.now().toISOString();
    h.db.seed("motorist_telnyx_webhook_events", [{
      organization_id: ORG, event_id: "deferred-audio", event_type: "call.playback.ended", call_session_id: call.telnyxSessionId, call_control_id: call.callControlId, connection_id: CONNECTION_ID,
      status: "failed", retry_state: "deferred", attempts: 1, delivery_count: 1, deferral_count: 1, effect_failure_count: 0, contract_version: 2,
      claimed_at: null, next_attempt_at: now, received_at: now, occurred_at: now,
      payload: { status: "completed", client_state: encodeClientState(h.clientStateOf(call.callControlId)) },
    }]);
    // A host scheduler on the shared deps must not reach the cron's replays.
    const deferMaintenance = vi.fn();
    h.deps.deferMaintenance = deferMaintenance;
    const spy = vi.mocked(processTelnyxEvent);
    spy.mockClear();

    const result = await replayStalledWebhookEvents(h.deps);
    expect(result).toMatchObject({ status: "ok", detail: { attempted: 1, replayed: 1 } });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ ledgerReplay: "cron", replayCorrelated: false, sweepAfterEvent: false });
    expect(spy.mock.calls[0][0]).toHaveProperty("deferMaintenance", undefined);
    expect(spy.mock.calls[0][1]).toMatchObject({ data: expect.objectContaining({ id: "deferred-audio" }) });
    expect(deferMaintenance).not.toHaveBeenCalled();
    expect(h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === "deferred-audio")).toMatchObject({ status: "processed" });
  });

  it("counts a lease-deferred cron replay as deferred, not failed", async () => {
    const h = createTelephonyHarness();
    const at = new Date(h.now().getTime() - 120_000).toISOString();
    h.db.seed("motorist_telnyx_webhook_events", [{ organization_id: ORG, event_id: "contended", event_type: "call.answered", status: "failed", attempts: 1, received_at: at, occurred_at: at, payload: {} }]);
    const incidentsBefore = h.rows("motorist_job_incidents").length;
    const replayEvent = vi.fn(async () => ({ outcome: "failed", status: 500, error: "SessionLeaseBusyError: Prebieha iná zmena hovoru." }));

    const result = await replayStalledWebhookEvents({ ...h.deps, replayEvent });
    expect(result.status).toBe("ok");
    expect(result.detail).toMatchObject({ deferred: 1, failed: 0 });
    expect(h.rows("motorist_job_incidents")).toHaveLength(incidentsBefore);
  });

  it("skips reconciliation when telephony is not configured", async () => {
    const h = createTelephonyHarness();
    const result = await reconcileWithTelnyx({ ...h.deps, telnyx: null });
    expect(result).toMatchObject({ job: RECONCILE_JOB, status: "skipped", detail: { reason: "not_configured" } });
  });

  it("leaves a quiet session alone while Telnyx still reports its legs as alive", async () => {
    const h = createTelephonyHarness({ ivrOnNeutralLine: false });
    const { sessionId } = await h.inbound({ to: "+421232408718" });
    h.db.update("motorist_call_sessions", { updated_at: new Date(h.now().getTime() - 5 * 60_000).toISOString() }, (row) => row.id === sessionId);
    const runSession = vi.fn(async () => ({ outcome: "applied" }));

    const result = await reconcileWithTelnyx({ ...h.deps, runSession });
    expect(result.status).toBe("ok");
    expect(result.detail).toMatchObject({ sessions: 1, deadLegs: 0 });
    expect(h.telnyx.of("retrieveCall").length).toBeGreaterThan(0);
    expect(runSession).not.toHaveBeenCalled();
  });

  it("closes a leg Telnyx has already ended by replaying the missing hangup", async () => {
    const h = createTelephonyHarness({ ivrOnNeutralLine: false });
    const call = await h.inbound({ to: "+421232408718" });
    h.db.update("motorist_call_sessions", { state: "talking", updated_at: new Date(h.now().getTime() - 5 * 60_000).toISOString() }, (row) => row.id === call.sessionId);
    h.telnyx.setCallStatus(call.callControlId, { alive: false });

    const result = await reconcileWithTelnyx(h.deps);
    expect(result.status).toBe("ok");
    expect(result.detail).toMatchObject({ deadLegs: 1, closedSessions: 1 });
    // The ordinary reducer path ran: the leg is closed, not just flagged.
    expect(h.legs(call.sessionId).find((leg) => leg.telnyx_call_control_id === call.callControlId)?.ended_at).toBeTruthy();
  });

  it("treats a leg Telnyx has never heard of as dead", async () => {
    const h = createTelephonyHarness({ ivrOnNeutralLine: false });
    const call = await h.inbound({ to: "+421232408718" });
    h.db.update("motorist_call_sessions", { state: "talking", updated_at: new Date(h.now().getTime() - 5 * 60_000).toISOString() }, (row) => row.id === call.sessionId);
    h.telnyx.setCallStatus(call.callControlId, { alive: false, known: false });

    const result = await reconcileWithTelnyx(h.deps);
    expect(result.detail).toMatchObject({ deadLegs: 1 });
  });

  it("does not touch a session that is still moving", async () => {
    const h = createTelephonyHarness({ ivrOnNeutralLine: false });
    await h.inbound({ to: "+421232408718" });

    const result = await reconcileWithTelnyx(h.deps);
    expect(result.detail).toMatchObject({ sessions: 0, checkedLegs: 0 });
    expect(h.telnyx.of("retrieveCall")).toHaveLength(0);
  });

  it("reports a provider failure without stopping the tick", async () => {
    const h = createTelephonyHarness({ ivrOnNeutralLine: false });
    const call = await h.inbound({ to: "+421232408718" });
    h.db.update("motorist_call_sessions", { updated_at: new Date(h.now().getTime() - 5 * 60_000).toISOString() }, (row) => row.id === call.sessionId);
    h.telnyx.failAlways("retrieveCall", "telnyx is down");

    const result = await reconcileWithTelnyx(h.deps);
    expect(result.status).toBe("failed");
    expect(h.rows("motorist_job_incidents").length).toBeGreaterThan(0);
  });
  it("replays high deferral counts but excludes explicit dead letters and future admission times", async () => {
    const h = createTelephonyHarness();
    const old = new Date(h.now().getTime() - 120_000).toISOString();
    const future = new Date(h.now().getTime() + 60_000).toISOString();
    h.db.seed("motorist_telnyx_webhook_events", [
      { event_id: "many-deferrals", retry_state: "deferred", next_attempt_at: old, attempts: 20 },
      { event_id: "dead-letter", retry_state: "dead_letter", next_attempt_at: null, attempts: 5 },
      { event_id: "not-due", retry_state: "deferred", next_attempt_at: future, attempts: 2 },
    ].map(row => ({ ...row, organization_id: ORG, status: "failed", event_type: "call.answered", payload: {}, occurred_at: old, received_at: old })));
    const replayEvent = vi.fn(async () => ({ outcome: "processed" }));
    expect(await replayStalledWebhookEvents({ ...h.deps, replayEvent })).toMatchObject({ status: "ok", detail: { attempted: 1, replayed: 1 } });
    expect(replayEvent.mock.calls[0]).toEqual([expect.objectContaining({ data: expect.objectContaining({ id: "many-deferrals" }) })]);
  });

});
