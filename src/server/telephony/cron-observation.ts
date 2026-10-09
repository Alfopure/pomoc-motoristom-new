import type { TelephonyCronJobResult, TelephonyCronSummary } from "./cron-jobs";

type ObservedHealth = "ok" | "warn" | "fail" | "skipped" | "unknown";

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
  const observedHealth = jobs.find(job => job.job === "telephony.alerts")?.detail.health;
  const telephonyHealth: ObservedHealth = observedHealth === "ok" || observedHealth === "warn" || observedHealth === "fail" || observedHealth === "skipped"
    ? observedHealth : "unknown";
  const diagnostics = jobs.find(job => job.job === "diagnostics.maintenance");
  const diagnosticsStatus = diagnostics?.status === "ok" && diagnostics.detail.blocked === true ? "blocked" : diagnostics?.status ?? "unknown";
  // A successfully executed alert job can report a failing exchange, including
  // when today's mail was already sent. Never paint that tick green.
  const status: TelephonyCronSummary["status"] = executionStatus === "degraded" || telephonyHealth === "warn" || telephonyHealth === "fail"
    || (summary.configured && telephonyHealth === "unknown") || diagnosticsStatus === "blocked" ? "degraded" : "ok";
  return {
    ...summary, status, executionStatus, telephonyHealth, diagnosticsStatus, failedJobs,
    startedAt: new Date(startedAt).toISOString(), checkedAt: new Date(completedAt).toISOString(),
    ms: Math.max(0, completedAt - startedAt), jobs,
  };
}

/** Runtime logs need bounded operational facts, never provider/error payloads. */
export function cronRuntimeObservation(summary: ReturnType<typeof completeCronSummary>) {
  const alerts = summary.jobs.find(job => job.job === "telephony.alerts");
  const count = (key: string) => {
    const value = alerts?.detail[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  return {
    scope: "telephony-cron-runtime", node: process.version, undici: process.versions.undici ?? null,
    startedAt: summary.startedAt, checkedAt: summary.checkedAt, ms: summary.ms,
    status: summary.status, executionStatus: summary.executionStatus,
    telephonyHealth: summary.telephonyHealth, diagnosticsStatus: summary.diagnosticsStatus,
    failedJobs: summary.failedJobs,
    alerts: { detected: count("alerts"), sent: count("sent"), suppressed: count("suppressed") },
    jobs: summary.jobs.map(job => ({ job: job.job, status: job.status, startedAt: job.startedAt ?? null, ms: job.ms ?? null })),
  };
}
