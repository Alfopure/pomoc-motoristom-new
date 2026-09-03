import { timingSafeEqual } from "node:crypto";

import { getTelephonyHealth } from "@/server/telephony/health";
import { createTelephonyDeps } from "@/server/telephony/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Operational health of the exchange for uptime checks and the runbook.
 *
 * Guarded by the same `CRON_SECRET` bearer as `/api/telephony/cron`: the report
 * names stuck sessions and failed webhook events, so it is not public, but an
 * external monitor has to reach it without a browser session. HTTP status
 * mirrors the report — 200 for `ok`/`warn`/`skipped`, 503 for `fail` — so a
 * plain uptime probe alerts without parsing the body.
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
    const report = await getTelephonyHealth(deps);

    return Response.json(report, { status: report.status === "fail" ? 503 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Telephony health check failed:", error);
    return Response.json({ status: "fail", checkedAt: new Date().toISOString(), checks: [] }, { status: 500 });
  }
}
