/**
 * updateSession with the real @supabase/ssr and auth-js: only `fetch` is
 * stubbed, with an ES256 signing key published as JWKS. The host is `.invalid`,
 * so nothing can reach a real Auth server.
 */
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_REFRESH_BUDGET_MS, updateSession } from "./proxy";

const URL_ = "https://proxy-test.invalid";
const COOKIE = "sb-proxy-test-auth-token";
const USER = { id: "11111111-1111-4111-8111-111111111111", aud: "authenticated", role: "authenticated", email: "dispecer@example.com" };
const b64 = (value: string | Uint8Array) => Buffer.from(value).toString("base64url");
let keys: CryptoKeyPair;
let jwk: JsonWebKey & { kid: string };

async function token(exp: number) {
  const signed = b64(JSON.stringify({ alg: "ES256", typ: "JWT", kid: jwk.kid })) + "." + b64(JSON.stringify({ ...USER, sub: USER.id, exp, iat: exp - 3600, session_id: "s" }));
  return signed + "." + b64(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, new TextEncoder().encode(signed))));
}
async function session(expiresAt: number, refresh = "rt-old") {
  return { access_token: await token(expiresAt), token_type: "bearer", expires_in: 3600, expires_at: expiresAt, refresh_token: refresh, user: USER };
}
const now = () => Math.floor(Date.now() / 1000);
const request = async (expiresAt: number) =>
  new NextRequest("https://test.dispecing.linkapomoci.sk/pobocka", { headers: { cookie: `${COOKIE}=base64-${b64(JSON.stringify(await session(expiresAt)))}` } });

let refresh: () => Promise<Response>;
let refreshCalls = 0;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const untouched = (response: Response) => {
  expect(response.status).toBe(200);
  expect(response.headers.get("x-middleware-next")).toBe("1");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("x-middleware-override-headers")).toBeNull();
};

beforeAll(async () => {
  keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  jwk = { ...await crypto.subtle.exportKey("jwk", keys.publicKey), kid: "proxy-test", alg: "ES256", use: "sig" };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${URL_}/auth/v1/.well-known/jwks.json`) return json(200, { keys: [jwk] });
    if (url === `${URL_}/auth/v1/token?grant_type=refresh_token`) { refreshCalls += 1; return refresh(); }
    throw new Error("unexpected request " + url);
  }));
});
afterAll(() => { vi.unstubAllGlobals(); });
beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", URL_);
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  refreshCalls = 0;
  refresh = async () => { throw new Error("no refresh expected"); };
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("updateSession with @supabase/ssr", () => {
  it("verifies a valid session locally without refreshing", async () => {
    untouched(await updateSession(await request(now() + 3600)));
    expect(refreshCalls).toBe(0);
  });

  it("writes a refreshed session to the page and the browser", async () => {
    refresh = async () => json(200, await session(now() + 3600, "rt-new"));
    const response = await updateSession(await request(now() - 60));
    expect(refreshCalls).toBe(1);
    const written = response.cookies.get(COOKIE)?.value ?? "";
    expect(JSON.parse(Buffer.from(written.replace(/^base64-/, ""), "base64url").toString()).refresh_token).toBe("rt-new");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-middleware-request-cookie")).toBe(`${COOKIE}=${written}`);
    expect(response.headers.get("location")).toBeNull();
  });

  it("clears the cookies when Auth definitively rejects the refresh token", async () => {
    refresh = async () => json(400, { error_code: "refresh_token_already_used", msg: "Invalid Refresh Token: Already Used" });
    const response = await updateSession(await request(now() - 60));
    expect(refreshCalls).toBe(1);
    expect(response.cookies.get(COOKIE)?.value).toBe("");
    expect(response.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
  });

  it.each([
    ["429", () => json(429, { error_code: "over_request_rate_limit", msg: "Too many requests" })],
    ["500", () => json(500, { msg: "Internal error" })],
    ["500 without JSON", () => new Response("<html>Bad gateway</html>", { status: 500, headers: { "content-type": "text/html" } })],
  ])("keeps the session on a transient %s answer", async (_label, answer) => {
    refresh = async () => answer();
    untouched(await updateSession(await request(now() - 60)));
    expect(refreshCalls).toBe(1);
  });

  it.each([
    ["503", async () => json(503, { msg: "Service unavailable" })],
    ["a network failure", async (): Promise<Response> => { throw new TypeError("fetch failed"); }],
  ])("passes through within the budget on %s while auth-js keeps retrying", async (_label, answer) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    refresh = answer;
    const result = updateSession(await request(now() - 60));
    await vi.advanceTimersByTimeAsync(SESSION_REFRESH_BUDGET_MS);
    untouched(await result);
    // Let the abandoned retries finish inside this test.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshCalls).toBeGreaterThan(1);
  });
});
