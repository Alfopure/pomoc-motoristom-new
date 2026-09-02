import { timingSafeEqual } from "node:crypto";

import { isCommanderConfigError, syncCommander, type CommanderSyncMode } from "@/server/integrations/commander/sync";

export const runtime = "nodejs";
// Musí skončiť skôr než 115 s timeout scheduler requestu, aby opakovaný pokus
// nebežal súbežne s opusteným serverovým behom.
export const maxDuration = 110;

const syncModes: CommanderSyncMode[] = ["vehicles", "positions", "rides", "full"];

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

  const parsed = parseBody(body);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const result = await syncCommander(parsed.value);
    return Response.json(result, { status: result.status === "failed" ? 502 : result.status === "partial" ? 207 : 200 });
  } catch (error) {
    if (isCommanderConfigError(error)) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : "Commander sync failed.";
    return Response.json({ error: message }, { status: 500 });
  }
}

function parseBody(body: unknown):
  | { ok: true; value: { mode: CommanderSyncMode; dryRun?: boolean; datetimeStart?: number; datetimeEnd?: number } }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: true, value: { mode: "full" } };
  }

  const record = body as Record<string, unknown>;
  const mode = typeof record.mode === "string" ? record.mode : "full";

  if (!isSyncMode(mode)) {
    return { ok: false, error: "Invalid Commander sync mode." };
  }

  return {
    ok: true,
    value: {
      mode,
      dryRun: record.dryRun === true,
      ...(finiteNumber(record.datetimeStart) ? { datetimeStart: Number(record.datetimeStart) } : {}),
      ...(finiteNumber(record.datetimeEnd) ? { datetimeEnd: Number(record.datetimeEnd) } : {}),
    },
  };
}

function authorize(request: Request): { ok: true } | { ok: false; status: number; error: string } {
  const expected = process.env.COMMANDER_SYNC_SECRET?.trim();

  if (!expected || expected.startsWith("replace-with-")) {
    return { ok: false, status: 500, error: "Commander sync secret is not configured." };
  }

  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

  if (!token || !safeEquals(token, expected)) {
    return { ok: false, status: 401, error: "Unauthorized Commander sync request." };
  }

  return { ok: true };
}

function isSyncMode(value: string): value is CommanderSyncMode {
  return syncModes.includes(value as CommanderSyncMode);
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value);
}

function safeEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
