import { timingSafeEqual } from "node:crypto";

import { runTelephonyCronJobs } from "@/server/telephony/cron-jobs";
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
 * lost webhooks), stuck-session detection and the webhook-ledger prune, and
 * answers with a per-job summary. When telephony is not configured the jobs
 * that need a provider report `skipped` instead of failing.
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

    return Response.json(summary, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Telephony cron failed:", error);
    return Response.json({ status: "failed", checkedAt: new Date().toISOString(), jobs: [] }, { status: 500 });
  }
}
