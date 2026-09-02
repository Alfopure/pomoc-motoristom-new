import "server-only";

import { timingSafeEqual } from "node:crypto";

export type SyncAuthResult = { ok: true } | { ok: false; status: number; error: string };

// Shared bearer guard for the recordings sync/probe machinery (mirrors the
// COMMANDER_SYNC_SECRET pattern in src/app/api/integrations/commander/sync/route.ts).
export function authorizeRecordingsSync(request: Request): SyncAuthResult {
  const expected = process.env.RECORDINGS_SYNC_SECRET?.trim();

  if (!expected || expected.startsWith("replace-with")) {
    return { ok: false, status: 500, error: "Recordings sync secret is not configured." };
  }

  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

  if (!token || !safeEquals(token, expected)) {
    return { ok: false, status: 401, error: "Unauthorized recordings sync request." };
  }

  return { ok: true };
}

function safeEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
