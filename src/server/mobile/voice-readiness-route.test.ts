import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
import * as route from "@/app/api/mobile/v1/voice/readiness/route";
import { ROUTE_AUTH_REGISTRY } from "@/server/route-auth-registry";
import { clearLatencyFlagsCache } from "@/server/telephony/latency-flags";

const mocks = vi.hoisted(() => ({ claims: vi.fn(), admin: vi.fn(), organization: vi.fn(), telephony: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getClaims: mocks.claims } }) }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("@/server/default-organization", () => ({ resolveDefaultOrganizationId: mocks.organization }));
vi.mock("@/server/telephony/runtime", () => ({ createTelephonyDeps: mocks.telephony }));
const userId = "11111111-1111-4111-8111-111111111111";
const profileId = "22222222-2222-4222-8222-222222222222";
const organizationId = "33333333-3333-4333-8333-333333333333";
const issuer = "https://nzpnqdstvkfncflgqlny.supabase.co/auth/v1";
const claims = () => ({ sub: userId, iss: issuer, aud: "authenticated", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });
const token = Buffer.from(JSON.stringify({ alg: "ES256" })).toString("base64url") + "."
  + Buffer.from(JSON.stringify(claims())).toString("base64url") + ".c2lnbmF0dXJl";
let f: ReturnType<typeof createFakeSupabase>;
function request(headers: Record<string, string> = {}) {
  return new Request("https://test.dispecing.linkapomoci.sk/api/mobile/v1/voice/readiness?profileId=spoof&nativeCallingEnabled=true", {
    headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": "test", ...headers },
  });
}
function expectPrivate(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("Vary")).toBe("Authorization, X-PM-App-Environment");
  expect(response.headers.get("Set-Cookie")).toBeNull();
}
beforeEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries({ MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
    VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk", APP_BASE_URL: "https://test.dispecing.linkapomoci.sk",
    SUPABASE_URL: issuer.replace("/auth/v1", ""), SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture" })) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network IO"); }));
  mocks.claims.mockResolvedValue({ data: { claims: claims() }, error: null });
  mocks.organization.mockResolvedValue(organizationId);
  f = createFakeSupabase();
  f.db.seed("motorist_profiles", [{ id: profileId, user_id: userId, organization_id: organizationId,
    display_name: "Fixture", role: "dispatcher", active: true, access_status: "active", kind: "human" }]);
  mocks.admin.mockReturnValue(f.client);
});
afterEach(() => {
  expect(mocks.telephony).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  // The profile, and for a phone that may call the organisation's latency switches.
  expect(f.db.log.every(query => ["motorist_profiles", "motorist_telephony_settings"].includes(query.table) && query.operation === "select")).toBe(true);
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); clearLatencyFlagsCache();
});

describe("GET authenticated native configuration readiness", () => {
  it.each(["dispatcher", "senior_dispatcher", "manager", "admin"])("returns disabled readiness for authenticated %s, including Expo Go", async role => {
    f.db.update("motorist_profiles", { role }, () => true);
    const response = await route.GET(request({ "X-Profile-Id": "spoof", "X-Organization-Id": "spoof" }));
    expect(response.status).toBe(200); expectPrivate(response);
    expect(await response.json()).toEqual({ ok: true, apiVersion: 1, environment: "test", profileId, checkedAt: expect.any(String),
      nativeCallingEnabled: false, backgroundIncomingEnabled: false });
  });
  it("returns both explicit opt-ins without constructing provider dependencies", async () => {
    vi.stubEnv("MOTORIST_NATIVE_VOICE_TEST_ENABLED", "true"); vi.stubEnv("MOTORIST_NATIVE_VOIP_PUSH_TEST_ENABLED", "true");
    const response = await route.GET(request()); expect(response.status).toBe(200); expectPrivate(response);
    expect(await response.json()).toMatchObject({ nativeCallingEnabled: true, backgroundIncomingEnabled: true,
      voiceTuning: { mobileTokenCache: false, mobileRtcRegion: "auto", mobileTrickleIce: false, mobileRealtimeStatus: false,
        mobileEarlyAccept: false, mobileParallelOffers: false } });
  });
  it("passes the organisation's phone switches, env first and the database over it", async () => {
    vi.stubEnv("MOTORIST_NATIVE_VOICE_TEST_ENABLED", "true");
    vi.stubEnv("TELEPHONY_LATENCY_FLAGS", JSON.stringify({ client: { mobileTrickleIce: true, mobileRtcRegion: "eu" }, hold_fast_web: true }));
    f.db.seed("motorist_telephony_settings", [{ organization_id: organizationId, latency_flags: { client: { mobileRtcRegion: "auto", mobileEarlyAccept: true } } }]);
    const body = await (await route.GET(request())).json();
    // Only the phone's keys travel; server switches stay on the server.
    expect(body.voiceTuning).toEqual({ mobileTokenCache: false, mobileRtcRegion: "auto", mobileTrickleIce: true, mobileRealtimeStatus: false,
      mobileEarlyAccept: true, mobileParallelOffers: false });
  });
  it("reads no switches for a phone that may not call", async () => {
    const body = await (await route.GET(request())).json();
    expect(body).not.toHaveProperty("voiceTuning");
    expect(f.db.log.some(query => query.table === "motorist_telephony_settings")).toBe(false);
  });
  it("returns false on an authenticated working Preview even if native flags are true", async () => {
    vi.stubEnv("VERCEL_ENV", "preview"); vi.stubEnv("MOTORIST_NATIVE_VOICE_TEST_ENABLED", "true");
    const response = await route.GET(request()); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ nativeCallingEnabled: false, backgroundIncomingEnabled: false });
  });
  it.each(["", "Bearer invalid"])("authenticates before inspecting unsafe configuration (%s)", authorization => {
    vi.stubEnv("MOTORIST_APP_ENV", "invalid");
    return route.GET(request({ authorization, Cookie: "sb-auth-token=invalid" })).then(async response => {
      expect(response.status).toBe(401); expectPrivate(response); expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
      expect(await response.json()).toMatchObject({ ok: false }); expect(mocks.claims).not.toHaveBeenCalled(); expect(mocks.admin).not.toHaveBeenCalled();
    });
  });
  it("does not cache configuration or profile authorization between requests", async () => {
    expect(await (await route.GET(request())).json()).toMatchObject({ nativeCallingEnabled: false });
    vi.stubEnv("MOTORIST_NATIVE_VOICE_TEST_ENABLED", "true");
    expect(await (await route.GET(request())).json()).toMatchObject({ nativeCallingEnabled: true, backgroundIncomingEnabled: false });
    f.db.update("motorist_profiles", { active: false }, () => true);
    expect((await route.GET(request())).status).toBe(403);
  });
  it("rejects an unsafe database configuration without claims/profile or provider calls", async () => {
    vi.stubEnv("SUPABASE_URL", "https://ifpaeegaesdmljfkdvcn.supabase.co");
    const response = await route.GET(request()); expect(response.status).toBe(503); expectPrivate(response);
    expect(mocks.claims).not.toHaveBeenCalled(); expect(mocks.admin).not.toHaveBeenCalled();
    expect(await response.json()).not.toHaveProperty("nativeCallingEnabled");
  });
  it("keeps expected organization fencing authoritative", async () => {
    const response = await route.GET(request({ "X-PM-Expected-Organization": userId }));
    expect(response.status).toBe(409); expectPrivate(response);
    expect(await response.json()).toMatchObject({ ok: false, code: "expected_organization_mismatch" });
  });
  it("retains environment conflict before claims/profile lookup", async () => {
    const response = await route.GET(request({ "X-PM-App-Environment": "production" }));
    expect(response.status).toBe(409); expectPrivate(response); expect(mocks.claims).not.toHaveBeenCalled(); expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("rejects a failed signature without reading an operator profile", async () => {
    mocks.claims.mockResolvedValue({ data: null, error: new Error("bad signature") });
    const response = await route.GET(request()); expect(response.status).toBe(401); expectPrivate(response); expect(mocks.admin).not.toHaveBeenCalled();
  });
  it.each([{ active: false }, { access_status: "disabled" }, { kind: "ai" }, { role: "driver" }, { organization_id: userId }])("rejects an unavailable or foreign actor %j", async changes => {
    f.db.update("motorist_profiles", changes, () => true);
    const response = await route.GET(request()); expect(response.status).toBe(403); expectPrivate(response);
    expect(await response.json()).not.toHaveProperty("nativeCallingEnabled");
  });
  it("keeps authorization outages sanitized and never invents disabled success", async () => {
    f.db.failNext("motorist_profiles", "select", "PRIVATE_DATABASE_ERROR");
    const response = await route.GET(request()); expect(response.status).toBe(503); expectPrivate(response);
    expect(JSON.stringify(await response.json())).not.toContain("PRIVATE_DATABASE_ERROR");
  });
  it("exports only GET and node runtime and registers a verified user bearer route", () => {
    expect(Object.keys(route).sort()).toEqual(["GET", "runtime"]);
    expect(ROUTE_AUTH_REGISTRY["mobile/v1/voice/readiness"]).toMatchObject({ class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"] });
  });
});
