import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { assertAppEnvironment, resolveAppEnvironment, TEST_APP_ORIGIN } from "@/lib/app-environment";
import { MutationError } from "./mutation-error";

export type HandoffSecretContext = { organizationId: string; caseId: string; handoffId: string; generation: number; tokenHash: string; origin: string };
export type HandoffEnvelope = { version: 1; keyId: string; iv: string; tag: string; ciphertext: string };
export const enhancedHandoffEnabled = () => process.env.MOTORIST_HANDOFF_V3_ENABLED === "true";
const unavailable = () => new MutationError("Obnoviteľný odkaz nie je dostupný. Skontrolujte serverovú konfiguráciu alebo vytvorte nový odkaz.", 503);

function key(keyId: string): Buffer {
  try {
    const keys = JSON.parse(process.env.MOTORIST_HANDOFF_KEYS ?? "{}");
    const encoded = keys[keyId];
    if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) throw unavailable();
    const value = Buffer.from(encoded, "base64");
    if (value.length !== 32) throw unavailable();
    return value;
  } catch { throw unavailable(); }
}
function associatedData(context: HandoffSecretContext, keyId: string): Buffer {
  return Buffer.from(JSON.stringify([1, keyId, context.organizationId, context.caseId, context.handoffId, context.generation, context.tokenHash, context.origin]));
}
export function sealHandoffToken(token: string, context: HandoffSecretContext): HandoffEnvelope {
  const keyId = process.env.MOTORIST_HANDOFF_KEY_ID || "v1";
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key(keyId), iv);
  cipher.setAAD(associatedData(context, keyId));
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return { version: 1, keyId, iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") };
}
export function openHandoffToken(value: unknown, context: HandoffSecretContext): string {
  try {
    if (!value || typeof value !== "object") throw unavailable();
    const envelope = value as HandoffEnvelope;
    if (envelope.version !== 1 || typeof envelope.keyId !== "string" || !/^[\w-]{1,40}$/.test(envelope.keyId) ||
      !/^[\w-]{16}$/.test(envelope.iv) || !/^[\w-]{22}$/.test(envelope.tag) || !/^[\w-]{58}$/.test(envelope.ciphertext)) throw unavailable();
    const decipher = createDecipheriv("aes-256-gcm", key(envelope.keyId), Buffer.from(envelope.iv, "base64url"));
    decipher.setAAD(associatedData(context, envelope.keyId));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const token = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]).toString("utf8");
    if (!/^[\w-]{43}$/.test(token) || createHash("sha256").update(token).digest("hex") !== context.tokenHash) throw unavailable();
    return token;
  } catch { throw unavailable(); }
}
export function handoffOrigin(request: Request): string {
  try {
    assertAppEnvironment();
    if (process.env.VERCEL_ENV === "production") {
      const expected = resolveAppEnvironment() === "test" ? TEST_APP_ORIGIN : "https://dispecing.linkapomoci.sk";
      if (process.env.APP_BASE_URL !== expected) throw unavailable();
      return expected;
    }
    if (process.env.VERCEL_ENV === "preview") {
      const host = process.env.VERCEL_URL;
      if (!host || !/^[a-z0-9-]+\.vercel\.app$/.test(host)) throw unavailable();
      return `https://${host}`;
    }
    const url = new URL(request.url);
    if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw unavailable();
    return url.origin;
  } catch { throw unavailable(); }
}
