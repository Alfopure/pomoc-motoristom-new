import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness } from "@/test/telephony-harness";
import { recordTelephonyIncident, TELEPHONY_INCIDENT_JOBS } from "./incidents";
import { RING_SWEEP_JOB, runRingSweep } from "./cron-jobs";

const maintenance = vi.hoisted(() => ({ sweep: vi.fn(), orphans: vi.fn(), attempts: vi.fn() }));
vi.mock("./routing/ring-plan", async importOriginal => ({
  ...await importOriginal<typeof import("./routing/ring-plan")>(),
  sweepOverdueRingSteps: maintenance.sweep,
  closeOrphanLegs: maintenance.orphans,
  closeStaleRingAttempts: maintenance.attempts,
}));

const timeout = "overdue session scan failed: AbortError: un-owned read exceeded 10000 ms";
const orphanTimeout = "orphan leg scan failed: AbortError: un-owned read exceeded 10000 ms";
const clean = () => ({ checked: 0, swept: [], deferred: [], errors: [], yielded: [], drained: [] });
async function openReadIncident(h: ReturnType<typeof createTelephonyHarness>, context: Record<string, unknown> = { job: RING_SWEEP_JOB }, error = timeout) {
  return recordTelephonyIncident(h.deps.admin, { job: TELEPHONY_INCIDENT_JOBS.commands, error: new Error(error), context, now: h.now() });
}

beforeEach(() => {
  maintenance.sweep.mockReset().mockImplementation(async () => clean());
  maintenance.orphans.mockReset().mockResolvedValue({ closed: [], awaitingHangup: [] });
  maintenance.attempts.mockReset().mockResolvedValue([]);
});

describe("ring sweep read incident recovery", () => {
  it.each([
    { scan: "overdue sessions", target: "sweep" as const, message: timeout },
    { scan: "orphan legs", target: "orphans" as const, message: orphanTimeout },
  ])("recovers its isolated $scan timeout after a later complete clean sweep, without call activity", async ({ target, message }) => {
    const h = createTelephonyHarness();
    maintenance[target].mockRejectedValueOnce(new Error(message));
    expect(await runRingSweep(h.deps)).toMatchObject({ status: "failed" });
    expect(h.rows("motorist_job_incidents")[0]).toMatchObject({ status: "open", consecutive_failures: 1,
      last_error_safe: `${new Error(message)} {"job":"telephony.ring.sweep"}` });
    h.advance(5 * 60_000);
    expect(await runRingSweep(h.deps)).toMatchObject({ status: "ok", detail: { readIncidentRecovered: true } });
    expect(h.rows("motorist_job_incidents")[0]).toMatchObject({ status: "recovered", recovered_at: h.now().toISOString() });
    expect(h.telnyx.calls).toHaveLength(0);
  });

  it.each([
    { name: "session-specific scan failure", context: { job: RING_SWEEP_JOB, sessionId: "call-1" }, error: timeout },
    { name: "session-specific orphan scan failure", context: { job: RING_SWEEP_JOB, sessionId: "call-1" }, error: orphanTimeout },
    { name: "orphan close failure", context: { job: RING_SWEEP_JOB }, error: "orphan leg close failed: AbortError: un-owned read exceeded 10000 ms" },
    { name: "provider reconciliation", context: { job: "telephony.telnyx.reconcile" }, error: timeout },
    { name: "command failure", context: { job: RING_SWEEP_JOB }, error: "Telnyx rejected hangup" },
    { name: "owned database timeout", context: { job: RING_SWEEP_JOB }, error: "owned database request exceeded 4000 ms" },
    { name: "unknown read failure", context: { job: RING_SWEEP_JOB }, error: "overdue session scan failed: permission denied" },
  ])("leaves $name untouched", async ({ context, error }) => {
    const h = createTelephonyHarness();
    await openReadIncident(h, context, error);
    expect(await runRingSweep(h.deps)).toMatchObject({ status: "ok", detail: { readIncidentRecovered: false } });
    expect(h.rows("motorist_job_incidents")[0].status).toBe("open");
  });

  it("does not infer recovery for an aggregate with more than one failure", async () => {
    const h = createTelephonyHarness();
    await openReadIncident(h);
    await openReadIncident(h);
    expect(await runRingSweep(h.deps)).toMatchObject({ status: "ok", detail: { readIncidentRecovered: false } });
    expect(h.rows("motorist_job_incidents")[0]).toMatchObject({ status: "open", consecutive_failures: 2 });
  });

  it.each(["errors", "deferred", "yielded", "awaiting hangup", "maintenance failure"])("leaves the incident open when the subsequent run has %s", async reason => {
    const h = createTelephonyHarness();
    await openReadIncident(h);
    if (reason === "awaiting hangup") maintenance.orphans.mockResolvedValue({ closed: [], awaitingHangup: ["leg-1"] });
    else if (reason === "maintenance failure") maintenance.attempts.mockRejectedValue(new Error("cleanup failed"));
    else maintenance.sweep.mockResolvedValue({ ...clean(), [reason]: reason === "errors" ? [{ sessionId: "call-1", error: "command failed" }] : ["call-1"] });
    const result = await runRingSweep(h.deps);
    expect(result.detail.readIncidentRecovered).not.toBe(true);
    expect(h.rows("motorist_job_incidents")[0].status).toBe("open");
  });

  it.each([timeout, orphanTimeout])("does not clear a concurrent command failure at the same timestamp after %s", async error => {
    const h = createTelephonyHarness();
    await openReadIncident(h, { job: RING_SWEEP_JOB }, error);
    const before = h.rows("motorist_job_incidents")[0].updated_at;
    maintenance.sweep.mockImplementation(async () => {
      await recordTelephonyIncident(h.deps.admin, { job: TELEPHONY_INCIDENT_JOBS.commands,
        error: new Error("provider outcome unknown"), context: { sessionId: "another-call", command: "hangup" }, now: h.now() });
      return clean();
    });
    expect(await runRingSweep(h.deps)).toMatchObject({ status: "ok", detail: { readIncidentRecovered: false } });
    expect(h.rows("motorist_job_incidents")[0]).toMatchObject({ status: "open", consecutive_failures: 2, updated_at: before });
  });

  it("does not clear changed error evidence even if timestamp and count stayed the same", async () => {
    const h = createTelephonyHarness();
    await openReadIncident(h);
    maintenance.sweep.mockImplementation(async () => {
      h.db.update("motorist_job_incidents", { last_error_safe: "another command failed" }, () => true);
      return clean();
    });
    expect(await runRingSweep(h.deps)).toMatchObject({ status: "ok", detail: { readIncidentRecovered: false } });
    expect(h.rows("motorist_job_incidents")[0].status).toBe("open");
  });

  it("keeps a failed snapshot read from breaking a clean sweep or recovering without evidence", async () => {
    const h = createTelephonyHarness();
    await openReadIncident(h);
    h.db.failNext("motorist_job_incidents", "select", "read unavailable");
    expect(await runRingSweep(h.deps)).toMatchObject({ status: "ok", detail: { readIncidentRecovered: false } });
    expect(h.rows("motorist_job_incidents")[0].status).toBe("open");
    expect(maintenance.sweep).toHaveBeenCalledTimes(1);
  });
});
