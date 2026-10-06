import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MutationError } from "@/server/mutation-error";
const mocks = vi.hoisted(() => ({ actor: vi.fn(), capture: vi.fn(), config: vi.fn(), origin: vi.fn() }));
vi.mock("@/server/api-auth", () => ({ requireDefaultMotoristActor: mocks.actor, assertSameOriginRequest: mocks.origin }));
vi.mock("@/server/diagnostics/server-errors", () => ({ captureServerError: mocks.capture, serverSentryConfiguration: mocks.config }));
const token = "a".repeat(64);
const origin = "https://test.dispecing.linkapomoci.sk";
function request(headers: Record<string, string> = {}) { return new Request(`${origin}/api/diagnostics/canary`, { method: "POST", headers, body: '{"error":"IGNORED_PRIVATE_INPUT"}' }); }
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  const env = { MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk", VERCEL_GIT_COMMIT_REF: "dev",
    APP_BASE_URL: origin, SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co", DIAGNOSTICS_TEST_CANARY_ENABLED: "true", DIAGNOSTICS_SERVER_ERRORS_ENABLED: "true",
    DIAGNOSTICS_TEST_CANARY_TOKEN: token, DIAGNOSTICS_TEST_CANARY_EXPIRES_AT: new Date(Date.now() + 7200_000).toISOString() };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  mocks.config.mockReturnValue({ release: "test_release" }); mocks.actor.mockResolvedValue({ role: "admin" }); mocks.origin.mockImplementation(() => {});
  mocks.capture.mockResolvedValue({ eventId: "a".repeat(32), accepted: true });
});
afterEach(() => vi.unstubAllEnvs());
describe("fixed TEST-only diagnostic canary", () => {
  it.each(["production", "preview", "foreign_project", "disabled", "no_dsn", "expired", "missing_expiry", "invalid_expiry", "distant_expiry"])("denies %s before authentication or capture", async mode => {
    if (mode === "production") vi.stubEnv("MOTORIST_APP_ENV", "production");
    if (mode === "preview") vi.stubEnv("VERCEL_ENV", "preview");
    if (mode === "foreign_project") vi.stubEnv("VERCEL_PROJECT_ID", "other");
    if (mode === "disabled") vi.stubEnv("DIAGNOSTICS_TEST_CANARY_ENABLED", "false");
    if (mode === "no_dsn") mocks.config.mockReturnValue(null);
    if (mode === "expired") vi.stubEnv("DIAGNOSTICS_TEST_CANARY_EXPIRES_AT", new Date(Date.now() - 1).toISOString());
    if (mode === "missing_expiry") vi.stubEnv("DIAGNOSTICS_TEST_CANARY_EXPIRES_AT", "");
    if (mode === "invalid_expiry") vi.stubEnv("DIAGNOSTICS_TEST_CANARY_EXPIRES_AT", "tomorrow");
    if (mode === "distant_expiry") vi.stubEnv("DIAGNOSTICS_TEST_CANARY_EXPIRES_AT", new Date(Date.now() + 2 * 86_400_000).toISOString());
    const { POST } = await import("./route");
    expect((await POST(request({ authorization: `Bearer ${token}` }))).status).toBe(404);
    expect(mocks.actor).not.toHaveBeenCalled(); expect(mocks.capture).not.toHaveBeenCalled();
  });
  it("allows only the fixed synthetic event with valid machine bearer and no Origin", async () => {
    const { POST } = await import("./route");
    const result = await POST(request({ authorization: `Bearer ${token}` }));
    expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("set-cookie")).toMatch(/^pm-diagnostic-canary=\d{13}\.[a-f0-9]{64}; Path=\/diagnostics\/canary; Max-Age=60; HttpOnly; Secure; SameSite=Strict$/);
    expect(JSON.stringify(await result.json())).not.toContain(token);
    expect(mocks.actor).not.toHaveBeenCalled();
    const [error, context] = mocks.capture.mock.calls[0];
    expect(error.code).toBe("DIAGNOSTIC_TEST_CANARY"); expect(error.message).toBe("Diagnostic canary");
    expect(context).toEqual({ source: "canary", route: "/api/diagnostics/canary", status: 500 });
  });
  it("rejects a bad bearer or cross-origin request even with valid bearer", async () => {
    const { POST } = await import("./route");
    expect((await POST(request({ authorization: "Bearer wrong" }))).status).toBe(401);
    expect((await POST(request({ authorization: `Bearer ${token}`, origin: "https://attacker.test" }))).status).toBe(403);
    expect(mocks.actor).not.toHaveBeenCalled(); expect(mocks.capture).not.toHaveBeenCalled();
  });
  it("retains admin authorization and same-origin requirements for cookie callers", async () => {
    const { POST } = await import("./route");
    expect((await POST(request({ origin }))).status).toBe(200);
    expect(mocks.origin).toHaveBeenCalledOnce(); expect(mocks.actor).toHaveBeenCalledWith(["admin"]);
    mocks.actor.mockRejectedValueOnce(new MutationError("denied", 403));
    expect((await POST(request({ origin }))).status).toBe(403);
  });
  it("does not claim a delivered event when Sentry refuses it and rate limits warm instances", async () => {
    const { POST } = await import("./route");
    mocks.capture.mockResolvedValue({ eventId: "id", accepted: false });
    const headers = { authorization: `Bearer ${token}` };
    expect((await POST(request(headers))).status).toBe(503);
    await POST(request(headers)); await POST(request(headers));
    expect((await POST(request(headers))).status).toBe(429);
    expect(mocks.capture).toHaveBeenCalledTimes(3);
  });
});

it("signed browser permit expires, binds release, and cannot grant production access", async () => {
  const { createBrowserCanaryPermit, validCanaryPermit } = await import("@/server/diagnostics/canary-access");
  const permit = createBrowserCanaryPermit()!;
  expect(validCanaryPermit(permit)).toBe(true);
  expect(validCanaryPermit(permit.slice(0, -1) + (permit.endsWith("a") ? "b" : "a"))).toBe(false);
  mocks.config.mockReturnValue({ release: "different_build" });
  expect(validCanaryPermit(permit)).toBe(false);
  mocks.config.mockReturnValue({ release: "test_release" });
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + 60_001);
  expect(validCanaryPermit(permit)).toBe(false);
  vi.useRealTimers(); vi.stubEnv("MOTORIST_APP_ENV", "production");
  expect(validCanaryPermit(permit)).toBe(false);
});
