import { timingSafeEqual } from "node:crypto";

import { importAllCommanderVehicles, MutationError } from "@/server/motorist-mutations";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  const auth = authorize(request);
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const input = {
    ...(typeof record.branchId === "string" ? { branchId: record.branchId } : {}),
    ...(typeof record.limit === "number" && Number.isFinite(record.limit) ? { limit: record.limit } : {}),
    dryRun: record.dryRun === true,
  };

  try {
    const result = await importAllCommanderVehicles(input);
    return Response.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : "Commander import failed.";
    console.error("Commander import-all failed:", error);
    return Response.json({ error: message }, { status: 500 });
  }
}

function authorize(request: Request): { ok: true } | { ok: false; status: number; error: string } {
  const expected = process.env.COMMANDER_SYNC_SECRET?.trim();

  if (!expected || expected.startsWith("replace-with-")) {
    return { ok: false, status: 500, error: "Commander sync secret is not configured." };
  }

  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

  if (!token || !safeEquals(token, expected)) {
    return { ok: false, status: 401, error: "Unauthorized Commander import request." };
  }

  return { ok: true };
}

function safeEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
