import { timingSafeEqual } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Vercel cron entrypoint (every 5 minutes, see vercel.json).
 *
 * Vercel sends `Authorization: Bearer <CRON_SECRET>`; anything else is rejected
 * before any work happens. The telephony reconciliation, stuck-session sweep
 * and webhook-ledger pruning jobs plug in here in the next phase; until then
 * the route reports that it is idle so the cron and its secret can be verified.
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

  return Response.json({
    status: "idle",
    checkedAt: new Date().toISOString(),
    jobs: [],
  });
}
