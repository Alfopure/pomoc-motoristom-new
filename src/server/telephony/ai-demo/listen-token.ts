import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The credential the bridge webhook uses to hand a call to the listener.
 *
 * Listening to a whole call needs a function that may run for minutes, and the
 * Telnyx webhook may not: its budget is sized for the human call path and
 * raising it would change the failure envelope of every ordinary call. So the
 * webhook fires a request at a route of our own and returns.
 *
 * That route is reachable from the internet, so it needs a credential. This is
 * not a session — no browser is involved — and not a shared bearer either: it
 * is a token bound to one attempt, so possessing it grants listening to that
 * call and nothing else. It is derived from a secret the deployment already
 * holds, so the demo needs no additional configuration to be secure.
 */

const WINDOW_MS = 10 * 60_000;

function digest(secret: string, attemptId: string, minute: number): Buffer {
  return createHmac("sha256", secret).update(`ai-demo-listen.${attemptId}.${minute}`, "utf8").digest();
}

/** A token for this attempt, valid for the current ten-minute window. */
export function mintListenToken(secret: string, attemptId: string, now = Date.now()): string {
  return `${Math.floor(now / WINDOW_MS)}.${digest(secret, attemptId, Math.floor(now / WINDOW_MS)).toString("base64url")}`;
}

/**
 * Accepts the current window and the one before it, so a call that starts on a
 * boundary is not refused by arithmetic.
 */
export function verifyListenToken(secret: string, attemptId: string, token: string, now = Date.now()): boolean {
  const [rawMinute, value] = token.split(".");
  const minute = Number.parseInt(rawMinute ?? "", 10);
  if (!Number.isFinite(minute) || !value) return false;

  const current = Math.floor(now / WINDOW_MS);
  if (minute !== current && minute !== current - 1) return false;

  let candidate: Buffer;
  try {
    candidate = Buffer.from(value, "base64url");
  } catch {
    return false;
  }
  const expected = digest(secret, attemptId, minute);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
