import "server-only";

import { getServerSentryClient } from "./server-errors";

const CHECK_IN_BUDGET_MS = 1_000;

export type CronMonitorRun = {
  readonly client: NonNullable<Awaited<ReturnType<typeof getServerSentryClient>>>;
  readonly monitorSlug: string;
  readonly checkInId: string;
  readonly startedAt: number;
  finished: boolean;
};

/** Bound initialization and flushing together; never hold up the business cron. */
async function beforeDeadline<T>(work: PromiseLike<T>, deadline: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(work).catch(() => null),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function unconfirmed(phase: "start" | "finish"): void {
  try { console.warn(JSON.stringify({ scope: "telephony-cron-checkin", phase, status: "unconfirmed" })); }
  catch { /* Observability cannot change cron execution. */ }
}

/**
 * The private client verifies the deployment and the environment's Sentry DSN.
 * A slug opts in to an already provisioned monitor; no monitor_config is sent.
 * Vercel Preview and local runs must never satisfy a stable monitor's schedule.
 */
export async function startCronMonitor(startedAt: number): Promise<CronMonitorRun | null> {
  const monitorSlug = process.env.DIAGNOSTICS_SENTRY_CRON_MONITOR_SLUG?.trim();
  if (process.env.VERCEL_ENV !== "production" || !monitorSlug || !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(monitorSlug)) return null;
  const deadline = Date.now() + CHECK_IN_BUDGET_MS;
  let run: CronMonitorRun | null = null;
  try {
    const client = await beforeDeadline(getServerSentryClient(), deadline);
    if (!client || Date.now() >= deadline) { unconfirmed("start"); return null; }
    const checkInId = client.captureCheckIn({ monitorSlug, status: "in_progress" });
    run = { client, monitorSlug, checkInId, startedAt, finished: false };
    if (!await beforeDeadline(client.flush(Math.max(1, deadline - Date.now())), deadline)) unconfirmed("start");
    return run;
  } catch { unconfirmed("start"); return run; }
}

/** An unhealthy exchange is distinct from a failed execution of the check. */
export async function finishCronMonitor(run: CronMonitorRun | null, executionStatus: "ok" | "degraded" | "failed"): Promise<void> {
  if (!run || run.finished) return;
  run.finished = true;
  const deadline = Date.now() + CHECK_IN_BUDGET_MS;
  try {
    run.client.captureCheckIn({
      monitorSlug: run.monitorSlug, checkInId: run.checkInId,
      status: executionStatus === "ok" ? "ok" : "error",
      duration: Math.max(0, Date.now() - run.startedAt) / 1_000,
    });
    if (!await beforeDeadline(run.client.flush(CHECK_IN_BUDGET_MS), deadline)) unconfirmed("finish");
  } catch { unconfirmed("finish"); }
}
