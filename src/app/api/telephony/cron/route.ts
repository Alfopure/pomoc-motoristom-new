import { timingSafeEqual } from "node:crypto";

import { runTelephonyCronJobs, type TelephonyCronJobResult } from "@/server/telephony/cron-jobs";
import { createTelephonyDeps } from "@/server/telephony/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Vercel cron entrypoint (every 5 minutes, see vercel.json) — the only cron of
 * this project.
 *
 * Vercel sends `Authorization: Bearer <CRON_SECRET>`; anything else is rejected
 * before any work happens. It runs the overdue ring-step sweep (safety net for
 * lost webhooks), the ledger replay, reconciliation against Telnyx, stuck-session
 * detection, the alert mailer and the webhook-ledger prune, and answers with a
 * per-job summary. When telephony is not configured the jobs that need a
 * provider report `skipped` instead of failing.
 *
 * It also materialises due task reminders and acts as a strict-window fallback
 * for pause-ending warnings. Those jobs are not telephony state transitions,
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

  try {
    const deps = await createTelephonyDeps({ sweepAfterEvent: false });
    const summary = await runTelephonyCronJobs(deps);
    const reminders = await runReminderMaterialisation(deps.organizationId);
    const pauseWarnings = await runPauseEndingWarningMaterialisation(deps.organizationId);
    const { runRecordingProcessing } = await import("@/server/telephony/recording-processing");
    const recordings = await runRecordingProcessing({ admin: deps.admin, organizationId: deps.organizationId, cronStartedAt });

    return Response.json(
      { ...summary, status: reminders.status === "failed" || pauseWarnings.status === "failed" || recordings.status === "failed" ? "degraded" : summary.status, jobs: [...summary.jobs, reminders, pauseWarnings, recordings] },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
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
    const control = await admin.from("motorist_job_controls").select("enabled").eq("job_name", job).maybeSingle();
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
