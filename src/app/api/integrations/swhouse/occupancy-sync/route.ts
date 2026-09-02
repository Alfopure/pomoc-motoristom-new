import { timingSafeEqual } from "node:crypto";

import { syncSwhouseOccupancy } from "@/server/integrations/swhouse/occupancy-sync";

export const runtime = "nodejs";
// getCarsOccupancy + DB roster + snapshot insert — sekundy, ale držíme rovnaký strop ako ostatné sync routy.
export const maxDuration = 300;

/**
 * SWHouse occupancy sync (T2). Samostatný ~5-min job VEDĽA hodinového rosteru.
 * Auth: Bearer SWHOUSE_SYNC_SECRET (cron/stroj). Vzor commander sync route.
 */
export async function POST(request: Request) {
  const auth = authorize(request);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const result = await syncSwhouseOccupancy();
    return Response.json(result, { status: result.status === "failed" ? 502 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "SWHouse occupancy sync zlyhal.";
    return Response.json({ error: message }, { status: 500 });
  }
}

function authorize(request: Request): { ok: true } | { ok: false; status: number; error: string } {
  const expected = process.env.SWHOUSE_SYNC_SECRET?.trim();

  if (!expected || expected.startsWith("replace-with-")) {
    return { ok: false, status: 500, error: "SWHouse sync secret is not configured." };
  }

  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

  if (!token || !safeEquals(token, expected)) {
    return { ok: false, status: 401, error: "Neautorizovaný SWHouse occupancy sync request." };
  }

  return { ok: true };
}

function safeEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
