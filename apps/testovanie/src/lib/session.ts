import { createHmac, timingSafeEqual } from "node:crypto";
import type { Actor } from "./model";
import { InputError } from "./validation";

export const cookieName = "motorist_testovanie_name";
export const sessionSeconds = 30 * 24 * 60 * 60;
function secret() {
  const key = process.env.TRACKER_SESSION_SECRET;
  if (!key || key.length < 32)
    throw new InputError("Vstup do evidencie ešte nie je pripravený.", 503);
  return key;
}
export function encodeActor(actor: Actor) {
  const payload = Buffer.from(JSON.stringify(actor)).toString("base64url");
  return (
    payload +
    "." +
    createHmac("sha256", secret()).update(payload).digest("base64url")
  );
}
export function decodeActor(cookie?: string): Actor | null {
  if (!cookie || cookie.length > 2000) return null;
  const [payload, signature, extra] = cookie.split(".");
  if (!payload || !signature || extra) return null;
  const expected = createHmac("sha256", secret()).update(payload).digest();
  const supplied = Buffer.from(signature, "base64url");
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return null;
  try {
    const actor = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (
      typeof actor.id !== "string" ||
      typeof actor.name !== "string" ||
      actor.name.length < 2 ||
      actor.name.length > 80 ||
      typeof actor.createdAt !== "string"
    )
      return null;
    const age = Date.now() - Date.parse(actor.createdAt);
    if (!Number.isFinite(age) || age < -60_000 || age > sessionSeconds * 1000)
      return null;
    return actor;
  } catch {
    return null;
  }
}
