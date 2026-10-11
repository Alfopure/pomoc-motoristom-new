import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireMobileActor } from "./auth";

// Exercise the real Supabase SDK and real ES256 signatures. Only the JWKS
// transport and application database are synthetic; no live credentials.
const mocks = vi.hoisted(() => ({ profile: vi.fn(), organization: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.profile }));
vi.mock("@/server/default-organization", () => ({ resolveDefaultOrganizationId: mocks.organization }));
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const issuer = "https://nzpnqdstvkfncflgqlny.supabase.co/auth/v1";
const userId = "11111111-1111-4111-8111-111111111111";
const kid = "mobile-foundation-verification-key";
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const payload = () => ({ sub: userId, aud: "authenticated", role: "authenticated", iss: issuer, exp: Math.floor(Date.now() / 1000) + 300 });
function jwt(claims = payload()) {
  const input = encode({ alg: "ES256", typ: "JWT", kid }) + "." + encode(claims);
  return input + "." + sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
}
const request = (token: string) => new Request("https://app.test/api/mobile/v1/me", { headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": "test" } });
beforeEach(() => {
  vi.resetAllMocks(); vi.unstubAllEnvs();
  vi.stubEnv("MOTORIST_APP_ENV", "test"); vi.stubEnv("SUPABASE_URL", issuer.replace("/auth/v1", "")); vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_synthetic");
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url !== issuer + "/.well-known/jwks.json") throw new Error("Unexpected network request in JWT test");
    return Response.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig" }] });
  }));
  mocks.organization.mockResolvedValue("organization");
  const query = { select: () => query, eq: () => query, neq: () => query, maybeSingle: async () => ({ data: { id: "profile", display_name: "Fixture", role: "dispatcher", email: null }, error: null }) };
  mocks.profile.mockReturnValue({ from: () => query });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("cryptographic user token boundary", () => {
  it("rejects malformed JWT JSON without contacting Auth or application data", async () => {
    await expect(requireMobileActor(request("header.payload.signature"))).rejects.toMatchObject({ status: 401 });
    expect(fetch).not.toHaveBeenCalled(); expect(mocks.profile).not.toHaveBeenCalled();
  });
  it("accepts a correctly signed token for the configured project", async () => { expect((await requireMobileActor(request(jwt()))).userId).toBe(userId); });
  it("rejects a modified payload with the old signature", async () => {
    const parts = jwt().split("."); parts[1] = encode({ ...payload(), sub: "22222222-2222-4222-8222-222222222222" });
    await expect(requireMobileActor(request(parts.join(".")))).rejects.toMatchObject({ status: 401 });
    expect(mocks.organization).not.toHaveBeenCalled(); expect(mocks.profile).not.toHaveBeenCalled();
  });
  it("rejects expired and foreign-project tokens even with a valid signature", async () => {
    await expect(requireMobileActor(request(jwt({ ...payload(), exp: 1 })))).rejects.toMatchObject({ status: 401 });
    await expect(requireMobileActor(request(jwt({ ...payload(), iss: "https://ifpaeegaesdmljfkdvcn.supabase.co/auth/v1" })))).rejects.toMatchObject({ status: 401 });
    expect(mocks.profile).not.toHaveBeenCalled();
  });
});
