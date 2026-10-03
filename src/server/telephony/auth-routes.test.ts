import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep the real route and auth guards; isolate all database/provider effects.
const mocks = vi.hoisted(() => ({
  server: vi.fn(), admin: vi.fn(), claims: vi.fn(), issueToken: vi.fn(), touchDevice: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: mocks.server }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("@/server/default-organization", () => ({ resolveDefaultOrganizationId: async () => "org-fixture" }));
vi.mock("@/server/telephony/operator-devices", () => ({ issueWebphoneToken: mocks.issueToken, touchDevice: mocks.touchDevice }));
vi.mock("@/server/telephony/runtime", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/telephony/runtime")>(),
  createTelephonyDeps: async () => ({ admin: {}, telnyx: {}, environment: "development", organizationId: "org-fixture" }),
}));

import { clearProfileCache } from "@/server/api-auth";
import { POST as token } from "@/app/api/telephony/webphone/token/route";
import { POST as heartbeat } from "@/app/api/telephony/devices/heartbeat/route";

const deployments = [
  { name: "production", app: "production", origin: "https://dispecing.linkapomoci.sk", branch: "main",
    project: "prj_DN3smSO1EbGowAmw3nHLQUYoSVJG", ref: "ifpaeegaesdmljfkdvcn" },
  { name: "dedicated TEST", app: "test", origin: "https://test.dispecing.linkapomoci.sk", branch: "dev",
    project: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk", ref: "nzpnqdstvkfncflgqlny" },
];

describe.each(deployments)("telephony auth in $name", (deployment) => {
  function request(path: string, origin = deployment.origin) {
    return new Request(deployment.origin + path, { method: "POST", headers: {
      host: new URL(deployment.origin).host, origin, "content-type": "application/json",
    }, body: JSON.stringify({ deviceSessionId: "device-current", registrationState: "registered" }) });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clearProfileCache();
    for (const [key, value] of Object.entries({
      NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_ID: deployment.project,
      VERCEL_GIT_COMMIT_REF: deployment.branch, MOTORIST_APP_ENV: deployment.app,
      MOTORIST_DEV_AUTH_BYPASS: "true", APP_BASE_URL: deployment.origin,
      SUPABASE_URL: `https://${deployment.ref}.supabase.co`, TELNYX_API_KEY: "KEYfixture",
    })) vi.stubEnv(key, value);
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network in isolated auth test"); }));
    mocks.claims.mockResolvedValue({ data: { claims: { sub: "user-fixture", email: "operator@example.test" } }, error: null });
    const query = {
      select: vi.fn(() => query), eq: vi.fn(() => query),
      maybeSingle: vi.fn(async () => ({ data: {
        id: "profile-fixture", role: "dispatcher", display_name: "Fixture", email: "operator@example.test",
      }, error: null })),
    };
    mocks.server.mockResolvedValue({ auth: { getClaims: mocks.claims }, from: () => query });
    mocks.issueToken.mockResolvedValue({ token: "fixture-jwt", deviceSessionId: "device-current" });
    mocks.touchDevice.mockResolvedValue({ ok: true, device: { device_seen_at: "2026-10-03T12:00:00Z", registration_state: "registered" } });
  });

  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("keeps a signed-in dispatcher's token renewal and heartbeat on the same device", async () => {
    for (let renewal = 0; renewal < 2; renewal++) {
      const response = await token(request("/api/telephony/webphone/token"));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      await expect(response.json()).resolves.toMatchObject({ deviceSessionId: "device-current" });
      expect((await heartbeat(request("/api/telephony/devices/heartbeat"))).status).toBe(200);
    }
    expect(mocks.issueToken).toHaveBeenCalledTimes(2);
    for (const [, actor] of mocks.issueToken.mock.calls) {
      expect(actor).toMatchObject({ organizationId: "org-fixture", profileId: "profile-fixture",
        deviceSessionId: "device-current", takeover: false });
    }
    expect(mocks.touchDevice).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      profileId: "profile-fixture", deviceSessionId: "device-current",
    }));
    expect(mocks.claims).toHaveBeenCalledTimes(4);
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a lost session after an earlier valid request, even with bypass set", async () => {
    expect((await token(request("/api/telephony/webphone/token"))).status).toBe(200);
    mocks.claims.mockResolvedValue({ data: null, error: { message: "invalid token" } });
    expect((await token(request("/api/telephony/webphone/token"))).status).toBe(401);
    expect((await heartbeat(request("/api/telephony/devices/heartbeat"))).status).toBe(401);
    expect(mocks.issueToken).toHaveBeenCalledTimes(1);
    expect(mocks.touchDevice).not.toHaveBeenCalled();
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("rejects cross-origin token and heartbeat requests before provider effects", async () => {
    expect((await token(request("/api/telephony/webphone/token", "https://outside.invalid"))).status).toBe(403);
    expect((await heartbeat(request("/api/telephony/devices/heartbeat", "https://outside.invalid"))).status).toBe(403);
    expect(mocks.claims).not.toHaveBeenCalled();
    expect(mocks.issueToken).not.toHaveBeenCalled();
    expect(mocks.touchDevice).not.toHaveBeenCalled();
  });
});
