import { timingSafeEqual } from "node:crypto";

import { assertSameOriginRequest, requireDefaultMotoristOrgRole } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import { syncSwhouseFleet } from "@/server/integrations/swhouse/sync";

export const runtime = "nodejs";
// getCars (~3 MB) + reconcile (upserty + ~137 updateov + linky) môže trvať desiatky sekúnd.
export const maxDuration = 300;

/**
 * SWHouse roster sync (Fáza 2). SWHouse je zdroj pravdy náhradnej flotily.
 * Auth: Bearer SWHOUSE_SYNC_SECRET (cron), alebo same-origin + manager/admin (ručný trigger z appky).
 * Body: { dryRun?: boolean }.
 */
export async function POST(request: Request) {
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const dryRun = Boolean(body && typeof body === "object" && !Array.isArray(body) && (body as Record<string, unknown>).dryRun === true);

  const auth = await authorize(request);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const result = await syncSwhouseFleet({ dryRun });
    return Response.json(result, { status: result.status === "failed" ? 502 : 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "SWHouse sync zlyhal.";
    return Response.json({ error: message }, { status: 500 });
  }
}

async function authorize(request: Request): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const expected = process.env.SWHOUSE_SYNC_SECRET?.trim();
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

  if (token && expected && !expected.startsWith("replace-with-") && safeEquals(token, expected)) {
    return { ok: true };
  }

  // Ručný trigger z prihlásenej appky (same-origin + manager/admin).
  try {
    assertSameOriginRequest(request);
    await requireDefaultMotoristOrgRole(["manager", "admin"]);
    return { ok: true };
  } catch (error) {
    // Zachovaj MutationError status: CSRF mismatch → 403, neprihlásený → 401 (M1, US-103).
    if (error instanceof MutationError) {
      return { ok: false, status: error.status, error: error.message };
    }
    return { ok: false, status: 401, error: "Neautorizovaný SWHouse sync request." };
  }
}

function safeEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
