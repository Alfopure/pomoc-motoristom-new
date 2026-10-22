import { timingSafeEqual } from "node:crypto";

import { runTelephonyCronJobs, isolatedCronJob, type TelephonyCronJobResult } from "@/server/telephony/cron-jobs";
import { completeCronSummary, cronRuntimeObservation } from "@/server/telephony/cron-observation";
import { DATABASE_REQUEST_MS } from "@/server/telephony/ownership";
import { createTelephonyDeps } from "@/server/telephony/runtime";
import { finishCronMonitor, startCronMonitor } from "@/server/diagnostics/cron-monitor";
import { deferServerError } from "@/server/diagnostics/server-errors";
import { recordCronHeartbeat } from "@/server/diagnostics/cron-heartbeat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * 120 s stays well under the 5-minute schedule, so at most one run is ever in
 * flight without a lock. The budget is split: ledger replay ≤ 60 s from the
 * cron start, ring sweep ≤ 20 s, the remaining telephony jobs ≤ 15 s,
 * reminders/pause warnings/recordings ≤ 15 s, 10 s reserve. Every job in the
 * response carries `startedAt`/`ms` so the split can be checked.
 */
export const maxDuration = 120;

/**
 * Vercel cron entrypoint (every 5 minutes, see vercel.json) — the only cron of
 * this project.
 *
 * Vercel sends `Authorization: Bearer <CRON_SECRET>`; anything else is rejected
 * before any work happens. It runs the ledger replay first (hangups first —
 * terminal facts before anything dials or closes a leg), then the overdue
 * ring-step sweep (safety net for lost webhooks), pending-effect recovery,
 * reconciliation against Telnyx, stuck-session detection, the alert mailer and
 * the webhook-ledger prune, and answers with a per-job summary. When telephony
 * is not configured the jobs that need a provider report `skipped` instead of
 * failing.
 *
 * It also materialises due task reminders, acts as a strict-window fallback
 * for pause-ending warnings and alerts the phone app about overdue callbacks. Those jobs are not telephony state transitions,
 * but this deployment runs no worker and `vercel.json` allows exactly one cron.
 * The open console owns the precise pause timer; cron never sends that warning
 * before its final minute or after the planned end.
 */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;

  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token) return false;

  const provided = Buffer.from(token);
  const expected = Buffer.from(secret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export async function GET(request: Request) {
  const cronStartedAt = Date.now();
  if (!authorized(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const monitor = await startCronMonitor(cronStartedAt);
  let heartbeatAdmin: Awaited<ReturnType<typeof createTelephonyDeps>>["admin"] | null = null;
  try {
    const deps = await createTelephonyDeps({ sweepAfterEvent: false });
    heartbeatAdmin = deps.admin;
    const onJobError = (error: unknown) => deferServerError(error, { source: "cron", route: "/api/telephony/cron" });
    const summary = await runTelephonyCronJobs({ ...deps, onJobError }, { cronStartedAt });
    const isolated = (job: string, run: () => Promise<TelephonyCronJobResult>) => isolatedCronJob(job, run, { onJobError });
    const reminders = await isolated("notifications.materialize", () => runReminderMaterialisation(deps.organizationId));
    const pauseWarnings = await isolated("notifications.pause-ending", () => runPauseEndingWarningMaterialisation(deps.organizationId));
    const recordings = await isolated("telephony.recordings.process", async () => {
      const { runRecordingProcessing } = await import("@/server/telephony/recording-processing");
      return runRecordingProcessing({ admin: deps.admin, organizationId: deps.organizationId, cronStartedAt });
    });
    const mobilePush = await isolated("notifications.mobile-push", () => runMobilePushMaterialisation(deps.organizationId, cronStartedAt));
    const diagnostics = await isolated("diagnostics.maintenance", async () => {
      const { runDiagnosticsMaintenance } = await import("@/server/diagnostics/service");
      return runDiagnosticsMaintenance(deps.organizationId);
    });

    const completed = completeCronSummary(summary, [reminders, pauseWarnings, recordings, mobilePush, diagnostics], cronStartedAt, Date.now());
    console.info(JSON.stringify(cronRuntimeObservation(completed)));
    await Promise.all([
      finishCronMonitor(monitor, completed.executionStatus),
      recordCronHeartbeat(deps.admin, cronStartedAt, completed.readinessStatus),
    ]);

    return Response.json(
      completed,
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    deferServerError(error, { source: "cron", route: "/api/telephony/cron", status: 500 });
    await Promise.all([
      finishCronMonitor(monitor, "failed"),
      heartbeatAdmin ? recordCronHeartbeat(heartbeatAdmin, cronStartedAt, "failed") : Promise.resolve(false),
    ]);
    console.error(JSON.stringify({ scope: "telephony-cron-runtime", status: "failed", executionStatus: "failed", telephonyHealth: "unknown",
      startedAt: new Date(cronStartedAt).toISOString(), checkedAt: new Date().toISOString(), ms: Math.max(0, Date.now() - cronStartedAt) }));
    console.error("Telephony cron failed:", error);
    return Response.json({ status: "failed", checkedAt: new Date().toISOString(), jobs: [] }, { status: 500 });
  }
}

/**
 * Turns due task reminders into notifications, gated by the same
 * `motorist_job_controls` row the worker used, so it can still be switched off
 * without a deploy. Loaded lazily: the reminder path pulls the notification
 * modules, and this route also carries the telephony jobs.
 */
async function runReminderMaterialisation(organizationId: string): Promise<TelephonyCronJobResult> {
  const job = "notifications.materialize";
  try {
    const { createSupabaseAdminClient } = await import("@/lib/supabase/admin");
    const admin = createSupabaseAdminClient();
    // Builder-level signal: bounds the read and cuts postgrest-js retry sleeps short.
    const control = await admin.from("motorist_job_controls").select("enabled").eq("job_name", job)
      .abortSignal(AbortSignal.timeout(DATABASE_REQUEST_MS)).maybeSingle();
    if (control.data && control.data.enabled === false) {
      return { job, status: "disabled", detail: { reason: "job_control_disabled" } };
    }

    const { materializeDueTaskReminders } = await import("@/server/task-notifications");
    const result = await materializeDueTaskReminders(admin, organizationId, new Date(), 50);
    return { job, status: "ok", detail: { ...result } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Reminder materialization failed:", error);
    return { job, status: "failed", detail: {}, error: message };
  }
}

/** Fallback for a suspended/closed console. The service itself keeps a strict
 * one-minute window, so this five-minute cron never sends too early or after
 * the configured pause duration. */
async function runPauseEndingWarningMaterialisation(organizationId: string): Promise<TelephonyCronJobResult> {
  const job = "notifications.pause-ending";
  try {
    const { createSupabaseAdminClient } = await import("@/lib/supabase/admin");
    const { materializeDuePauseEndingNotifications } = await import("@/server/telephony/pause-ending-notifications");
    const result = await materializeDuePauseEndingNotifications(createSupabaseAdminClient(), organizationId, new Date(), 50);
    return { job, status: "ok", detail: { ...result } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Pause ending notification materialization failed:", error);
    return { job, status: "failed", detail: {}, error: message };
  }
}

/** The overdue-callback push starts only this early in a run (120 s limit). */
const MOBILE_PUSH_LATEST_START_MS = 75_000;

/** Overdue callbacks to the dispatchers' phones (off unless MOBILE_PUSH_ENABLED; each
 * callback deadline is announced once, so a repeated tick sends nothing) and the
 * hourly upkeep, which deletes old delivery positions in any operating deployment. */
async function runMobilePushMaterialisation(organizationId: string, cronStartedAt: number): Promise<TelephonyCronJobResult> {
  const job = "notifications.mobile-push";
  const [{ canOperateTelephony }, { mobilePushEnabled }] = await Promise.all([import("@/lib/app-environment"), import("@/server/mobile/push")]);
  // Push needs an operating deployment too, so nothing at all runs on a Preview.
  if (!canOperateTelephony()) return { job, status: "disabled", detail: { reason: "push_disabled" } };
  // Late in a slow run the next tick announces the same callbacks; the run must end in time.
  if (Date.now() - cronStartedAt > MOBILE_PUSH_LATEST_START_MS) return { job, status: "skipped", detail: { reason: "cron_budget" } };
  const { createSupabaseAdminClient } = await import("@/lib/supabase/admin");
  const { runMobileCallbackPush, runMobilePushUpkeep } = await import("@/server/mobile/push-events");
  const admin = createSupabaseAdminClient();
  const result = mobilePushEnabled() ? await runMobileCallbackPush(admin, organizationId, new Date()) : { status: "disabled" as const, detail: { reason: "push_disabled" } };
  const upkeep = await runMobilePushUpkeep(admin, organizationId, new Date());
  return { job, status: result.status, detail: { ...result.detail, ...(upkeep ? { upkeep } : {}) } };
}
