import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handoffHash } from "./case-handoff";
import { handoffOrigin, openHandoffToken, sealHandoffToken, type HandoffSecretContext } from "./handoff-secret";

const token = "a".repeat(43);
const context: HandoffSecretContext = { organizationId: "org", caseId: "case", handoffId: "grant", generation: 1, tokenHash: handoffHash(token), origin: "https://test.dispecing.linkapomoci.sk" };
beforeEach(() => {
  vi.stubEnv("MOTORIST_HANDOFF_KEYS", JSON.stringify({ v1: Buffer.alloc(32, 1).toString("base64"), v2: Buffer.alloc(32, 2).toString("base64") }));
  vi.stubEnv("MOTORIST_HANDOFF_KEY_ID", "v1");
});
afterEach(() => vi.unstubAllEnvs());

describe("recoverable handoff secret", () => {
  it("stores no plaintext and uses a different authenticated nonce each time", () => {
    const first = sealHandoffToken(token, context), second = sealHandoffToken(token, context);
    expect(JSON.stringify(first)).not.toContain(token);
    expect(first.iv).not.toBe(second.iv);
    expect(openHandoffToken(first, context)).toBe(token);
  });
  it.each(["organizationId", "caseId", "handoffId", "generation", "tokenHash", "origin"] as const)("binds the secret to %s", field => {
    const envelope = sealHandoffToken(token, context);
    expect(() => openHandoffToken(envelope, { ...context, [field]: field === "generation" ? 2 : "other" })).toThrow("Obnoviteľný");
  });
  it("rejects tampering, missing and foreign keys without exposing details", () => {
    const envelope = sealHandoffToken(token, context);
    expect(() => openHandoffToken({ ...envelope, ciphertext: "b".repeat(58) }, context)).toThrow("Obnoviteľný");
    vi.stubEnv("MOTORIST_HANDOFF_KEYS", "{}");
    expect(() => openHandoffToken(envelope, context)).toThrow("Obnoviteľný");
    expect(() => sealHandoffToken(token, context)).toThrow("Obnoviteľný");
    vi.stubEnv("MOTORIST_HANDOFF_KEYS", JSON.stringify({ v1: Buffer.alloc(32, 9).toString("base64") }));
    expect(() => openHandoffToken(envelope, context)).toThrow("Obnoviteľný");
  });
  it("preserves old key versions when the issuing key rotates", () => {
    const envelope = sealHandoffToken(token, context);
    vi.stubEnv("MOTORIST_HANDOFF_KEY_ID", "v2");
    expect(sealHandoffToken(token, context).keyId).toBe("v2");
    expect(openHandoffToken(envelope, context)).toBe(token);
  });
  it("uses canonical TEST configuration rather than a supplied host", () => {
    vi.stubEnv("MOTORIST_APP_ENV", "test"); vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("APP_BASE_URL", context.origin);
    expect(handoffOrigin(new Request("https://attacker.example/"))).toBe(context.origin);
    vi.stubEnv("APP_BASE_URL", "https://dispecing.linkapomoci.sk");
    expect(() => handoffOrigin(new Request("https://attacker.example/"))).toThrow("Obnoviteľný");
  });
  it("rejects foreign Preview hosts and uses the trusted deployment origin", () => {
    vi.stubEnv("MOTORIST_APP_ENV", "test"); vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_URL", "trusted-preview.vercel.app");
    expect(handoffOrigin(new Request("https://attacker.example/"))).toBe("https://trusted-preview.vercel.app");
    vi.stubEnv("VERCEL_URL", "attacker.example");
    expect(() => handoffOrigin(new Request("https://attacker.example/"))).toThrow();
  });
});
