import { describe, expect, it } from "vitest";
import type { TelephonyCronSummary } from "./cron-jobs";
import { completeCronSummary, cronRuntimeObservation } from "./cron-observation";

const summary = (health?: string): TelephonyCronSummary => ({ status: "ok", checkedAt: "2026-10-06T08:00:01.000Z", organizationId: "org", configured: true, ms: 1,
  jobs: [...["telephony.ledger.replay", "telephony.ring.sweep", "telephony.effects.recovery", "telephony.telnyx.reconcile", "telephony.sessions.stuck", "telephony.ai-demo.cleanup"].map(job => ({ job, status: "ok" as const, detail: {} })), ...(health ? [{ job: "telephony.alerts", status: "ok" as const, detail: { health } }] : [])] });
const start = Date.parse("2026-10-06T08:00:00.000Z");

describe("completed cron observation", () => {
  it("uses completion time and includes the tail in total duration", () => {
    const result = completeCronSummary(summary("ok"), [{ job: "diagnostics.maintenance", status: "ok", detail: {} }], start, start + 1250);
    expect(result).toMatchObject({ status: "ok", executionStatus: "ok", telephonyHealth: "ok", diagnosticsStatus: "ok", startedAt: "2026-10-06T08:00:00.000Z", checkedAt: "2026-10-06T08:00:01.250Z", ms: 1250 });
  });

  it("does not treat an unobserved configured exchange as healthy", () => {
    expect(completeCronSummary(summary(), [], start, start)).toMatchObject({ status: "degraded", executionStatus: "ok", telephonyHealth: "unknown" });
    expect(completeCronSummary(summary("skipped"), [], start, start)).toMatchObject({ status: "ok", telephonyHealth: "skipped" });
  });

  it("shows blocked collection even when maintenance itself completed", () => {
    expect(completeCronSummary(summary("ok"), [{ job: "diagnostics.maintenance", status: "ok", detail: { blocked: true } }], start, start))
      .toMatchObject({ status: "degraded", executionStatus: "ok", diagnosticsStatus: "blocked", failedJobs: [] });
  });

  it("keeps disabled jobs neutral and preserves an earlier execution failure", () => {
    const result = completeCronSummary({ ...summary("ok"), status: "degraded" }, [{ job: "diagnostics.maintenance", status: "disabled", detail: {} }], start, start);
    expect(result).toMatchObject({ status: "degraded", executionStatus: "degraded", diagnosticsStatus: "disabled" });
  });


  it.each(["telephony.ledger.prune", "telephony.recordings.process", "diagnostics.maintenance", "notifications.materialize", "notifications.pause-ending"])("keeps failed auxiliary %s visible without declaring the critical scheduler unavailable", job => {
    expect(completeCronSummary(summary("ok"), [{ job, status: "failed", detail: {} }], start, start)).toMatchObject({
      status: "degraded", executionStatus: "degraded", readinessStatus: "auxiliary_degraded", failedJobs: [job], auxiliaryFailedJobs: [job], criticalFailedJobs: [], missingCriticalJobs: [],
    });
  });

  it.each(["telephony.effects.recovery", "new.unclassified.job"])("fails readiness for critical or unclassified %s", job => {
    const source = summary("ok");
    source.jobs = source.jobs.filter(item => item.job !== job);
    expect(completeCronSummary(source, [{ job, status: "failed", detail: {} }], start, start)).toMatchObject({ readinessStatus: "degraded", criticalFailedJobs: [job] });
  });

  it("does not let an auxiliary failure hide missing critical results or an unexplained degraded summary", () => {
    const source = summary("ok");
    source.jobs = source.jobs.filter(job => job.job !== "telephony.effects.recovery");
    expect(completeCronSummary(source, [{ job: "telephony.ledger.prune", status: "failed", detail: {} }], start, start))
      .toMatchObject({ readinessStatus: "degraded", missingCriticalJobs: ["telephony.effects.recovery"] });
    expect(completeCronSummary({ ...summary("ok"), status: "degraded" }, [], start, start)).toMatchObject({ readinessStatus: "degraded" });
    expect(completeCronSummary({ ...summary("ok"), status: "degraded" }, [{ job: "diagnostics.maintenance", status: "failed", detail: {} }], start, start)).toMatchObject({ readinessStatus: "degraded" });
  });


  it("retains bounded retention progress without including candidate IDs or errors", () => {
    const source = summary("ok");
    const logged = cronRuntimeObservation(completeCronSummary(source, [{ job: "telephony.ledger.prune", status: "ok", detail: {
      deleted: 250, payloadsCleared: 10, moreDeletes: true, morePayloads: false, eventId: "private-event", error: "private-database",
    } }], start, start));
    expect(logged.ledgerPrune).toEqual({ deleted: 250, payloadsCleared: 10, moreDeletes: true, morePayloads: false });
    expect(JSON.stringify(logged)).not.toContain("private");
  });

  it("logs only allowlisted observation data, not job errors, IDs or provider details", () => {
    const source = summary("fail");
    source.jobs.at(-1)!.detail = { ...source.jobs.at(-1)!.detail, alerts: 13, sent: "unsafe text", suppressed: -1, sessionId: "private-call", providerPayload: "private-provider" };
    source.jobs.at(-1)!.error = "private-error";
    const result = cronRuntimeObservation(completeCronSummary(source, [], start, start));
    expect(result.alerts).toEqual({ detected: 13, sent: null, suppressed: null });
    expect(JSON.stringify(result)).not.toMatch(/private|unsafe|organizationId/);
  });
});
