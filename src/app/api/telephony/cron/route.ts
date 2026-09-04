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
 * It also materialises due task reminders. That job belongs to the case module,
 * not to telephony, but this deployment runs no worker and `vercel.json` allows
 * exactly one cron — so without this a dispatcher's "call the customer at
 * 14:00" reminder would sit in `motorist_task_reminders` for ever and no
 * notification would ever appear. Five-minute granularity is fine for that.
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
  if (!authorized(request)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const deps = await createTelephonyDeps({ sweepAfterEvent: false });
    const summary = await runTelephonyCronJobs(deps);
    const reminders = await runReminderMaterialisation(deps.organizationId);

    return Response.json(
      { ...summary, status: reminders.status === "failed" ? "degraded" : summary.status, jobs: [...summary.jobs, reminders] },
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
