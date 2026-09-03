import { describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";

import { detectStuckSessions, LEDGER_PRUNE_JOB, pruneWebhookLedger, runRingSweep, runTelephonyCronJobs, RING_SWEEP_JOB, STUCK_SESSION_JOB } from "./cron-jobs";

const DAY = 24 * 60 * 60 * 1000;

function seedLedger(h: ReturnType<typeof createTelephonyHarness>) {
  const at = (ms: number) => new Date(h.now().getTime() - ms).toISOString();
  h.db.seed("motorist_telnyx_webhook_events", [
    { event_id: "old-processed", event_type: "call.hangup", status: "processed", attempts: 1, received_at: at(31 * DAY), payload: { a: 1 } },
    { event_id: "old-failed", event_type: "call.hangup", status: "failed", attempts: 3, received_at: at(31 * DAY), payload: { a: 1 } },
    { event_id: "recent-processed", event_type: "call.hangup", status: "processed", attempts: 1, received_at: at(2 * DAY), payload: { a: 1 } },
    { event_id: "playback-8d", event_type: "call.playback.ended", status: "processed", attempts: 1, received_at: at(8 * DAY), payload: { a: 1 } },
    { event_id: "playback-1d", event_type: "call.playback.ended", status: "processed", attempts: 1, received_at: at(1 * DAY), payload: { a: 1 } },
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
    expect(runSession).toHaveBeenCalledWith(sessionId, expect.objectContaining({ kind: "app", type: "sweep" }));
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

  it("returns one summary per job and stays `ok` when nothing fails", async () => {
    const h = createTelephonyHarness();
    seedLedger(h);
    h.db.seed("motorist_job_controls", [{ job_name: LEDGER_PRUNE_JOB, enabled: true }]);
    h.setPresence(PROFILES.o1, { status: "available" });

    const summary = await runTelephonyCronJobs({ ...h.deps, runSession: vi.fn(async () => ({})) });
    expect(summary.status).toBe("ok");
    expect(summary.configured).toBe(true);
    expect(summary.organizationId).toBe(ORG);
    expect(summary.jobs.map((job) => job.job)).toEqual([RING_SWEEP_JOB, STUCK_SESSION_JOB, LEDGER_PRUNE_JOB]);
  });
});
