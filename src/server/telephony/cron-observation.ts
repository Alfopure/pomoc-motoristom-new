import type { TelephonyCronJobResult, TelephonyCronSummary } from "./cron-jobs";

type ObservedHealth = "ok" | "warn" | "fail" | "skipped" | "unknown";
const AUXILIARY_JOBS = new Set(["telephony.ledger.prune", "notifications.materialize", "notifications.pause-ending", "telephony.recordings.process", "diagnostics.maintenance"]);
const CRITICAL_JOBS = ["telephony.ledger.replay", "telephony.ring.sweep", "telephony.effects.recovery", "telephony.telnyx.reconcile", "telephony.sessions.stuck", "telephony.ai-demo.cleanup", "telephony.alerts"];

/** Completion of the scheduler is separate from the health it observed. */
export function completeCronSummary(
  summary: TelephonyCronSummary,
  tail: TelephonyCronJobResult[],
  startedAt: number,
  completedAt: number,
) {
  const jobs = [...summary.jobs, ...tail];
  const failedJobs = jobs.filter(job => job.status === "failed").map(job => job.job);
  const executionStatus: TelephonyCronSummary["status"] = summary.status === "degraded" || failedJobs.length ? "degraded" : "ok";
  const auxiliaryFailedJobs = failedJobs.filter(job => AUXILIARY_JOBS.has(job));
  const criticalFailedJobs = failedJobs.filter(job => !AUXILIARY_JOBS.has(job));
  const missingCriticalJobs = CRITICAL_JOBS.filter(name => !jobs.some(job => job.job === name));
  // Only positively identified auxiliary failures may keep readiness green.
  // Unknown, missing or legacy aggregate failures remain critical/fail closed.
  const readinessStatus = criticalFailedJobs.length || missingCriticalJobs.length || (summary.status === "degraded" && !summary.jobs.some(job => job.status === "failed"))
    ? "degraded" as const : auxiliaryFailedJobs.length ? "auxiliary_degraded" as const : "ok" as const;
  const observedHealth = jobs.find(job => job.job === "telephony.alerts")?.detail.health;
  const telephonyHealth: ObservedHealth = observedHealth === "ok" || observedHealth === "warn" || observedHealth === "fail" || observedHealth === "skipped"
    ? observedHealth : "unknown";
  const diagnostics = jobs.find(job => job.job === "diagnostics.maintenance");
  const diagnosticsStatus = diagnostics?.status === "ok" && diagnostics.detail.blocked === true ? "blocked" : diagnostics?.status ?? "unknown";
  // A successfully executed alert job can report a failing exchange, including
  // when today's mail was already sent. Never paint that tick green.
  const status: TelephonyCronSummary["status"] = executionStatus === "degraded" || readinessStatus === "degraded" || telephonyHealth === "warn" || telephonyHealth === "fail"
    || (summary.configured && telephonyHealth === "unknown") || diagnosticsStatus === "blocked" ? "degraded" : "ok";
  return {
    ...summary, status, executionStatus, readinessStatus, telephonyHealth, diagnosticsStatus, failedJobs, auxiliaryFailedJobs, criticalFailedJobs, missingCriticalJobs,
    startedAt: new Date(startedAt).toISOString(), checkedAt: new Date(completedAt).toISOString(),
    ms: Math.max(0, completedAt - startedAt), jobs,
  };
}

/** Runtime logs need bounded operational facts, never provider/error payloads. */
export function cronRuntimeObservation(summary: ReturnType<typeof completeCronSummary>) {
  const alerts = summary.jobs.find(job => job.job === "telephony.alerts");
  const prune = summary.jobs.find(job => job.job === "telephony.ledger.prune");
  const count = (job: TelephonyCronJobResult | undefined, key: string) => {
    const value = job?.detail[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  return {
    scope: "telephony-cron-runtime", node: process.version, undici: process.versions.undici ?? null,
    startedAt: summary.startedAt, checkedAt: summary.checkedAt, ms: summary.ms,
    status: summary.status, executionStatus: summary.executionStatus, readinessStatus: summary.readinessStatus,
    telephonyHealth: summary.telephonyHealth, diagnosticsStatus: summary.diagnosticsStatus,
    failedJobs: summary.failedJobs, auxiliaryFailedJobs: summary.auxiliaryFailedJobs, criticalFailedJobs: summary.criticalFailedJobs, missingCriticalJobs: summary.missingCriticalJobs,
    alerts: { detected: count(alerts, "alerts"), sent: count(alerts, "sent"), suppressed: count(alerts, "suppressed") },
    ledgerPrune: { deleted: count(prune, "deleted"), payloadsCleared: count(prune, "payloadsCleared"),
      moreDeletes: typeof prune?.detail.moreDeletes === "boolean" ? prune.detail.moreDeletes : null,
      morePayloads: typeof prune?.detail.morePayloads === "boolean" ? prune.detail.morePayloads : null },
    jobs: summary.jobs.map(job => ({ job: job.job, status: job.status, startedAt: job.startedAt ?? null, ms: job.ms ?? null })),
  };
}
