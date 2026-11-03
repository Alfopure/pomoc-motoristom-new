import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
import { GET } from "@/app/api/mobile/v1/cases/overview/route";

const mocks = vi.hoisted(() => ({ claims: vi.fn(), admin: vi.fn(), organization: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getClaims: mocks.claims } }) }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("@/server/default-organization", () => ({ resolveDefaultOrganizationId: mocks.organization }));
const userId = "11111111-1111-4111-8111-111111111111";
const profileId = "22222222-2222-4222-8222-222222222222";
const organizationId = "33333333-3333-4333-8333-333333333333";
const issuer = "https://nzpnqdstvkfncflgqlny.supabase.co/auth/v1";
const claims = () => ({ sub: userId, iss: issuer, aud: "authenticated", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });
const token = Buffer.from(JSON.stringify({ alg: "ES256" })).toString("base64url") + "."
  + Buffer.from(JSON.stringify(claims())).toString("base64url") + ".c2lnbmF0dXJl";
let f: ReturnType<typeof createFakeSupabase>;
function request(query = "", headers: Record<string, string> = {}) {
  return new Request("https://test.dispecing.linkapomoci.sk/api/mobile/v1/cases/overview" + query, {
    headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": "test", ...headers },
  });
}
function expectPrivate(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("Vary")).toContain("Authorization");
  expect(response.headers.get("Vary")).toContain("X-PM-App-Environment");
  expect(response.headers.get("Set-Cookie")).toBeNull();
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("MOTORIST_APP_ENV", "test");
  vi.stubEnv("SUPABASE_URL", issuer.replace("/auth/v1", ""));
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_fixture");
  mocks.claims.mockResolvedValue({ data: { claims: claims() }, error: null });
  mocks.organization.mockResolvedValue(organizationId);
  f = createFakeSupabase();
  f.db.seed("motorist_profiles", [{ id: profileId, user_id: userId, organization_id: organizationId, display_name: "Actor", role: "dispatcher", kind: "human", active: true, access_status: "active" }]);
  f.db.seed("motorist_cases", [
    { id: "own", organization_id: organizationId, owner_id: profileId, status: "open", priority: "urgent", summary: "PRIVATE CUSTOMER" },
    { id: "foreign", organization_id: userId, owner_id: profileId, status: "open", priority: "urgent" },
  ]);
  mocks.admin.mockReturnValue(f.admin);
});
afterEach(() => vi.unstubAllEnvs());

describe("authenticated read-only mobile case overview route", () => {
  it.each(["dispatcher", "senior_dispatcher", "manager", "admin"])("returns only scoped counts for authorized %s", async role => {
    f.db.update("motorist_profiles", { role }, () => true);
    const response = await GET(request("", { "X-Organization-Id": userId, "X-Profile-Id": userId }));
    expect(response.status).toBe(200); expectPrivate(response);
    expect(await response.json()).toEqual({ ok: true, apiVersion: 1, environment: "test", profileId, checkedAt: expect.any(String), counts: { open: 1, mine: 1, unassigned: 0, urgent: 1 } });
    expect(f.db.log.every(entry => entry.operation === "select")).toBe(true);
    expect(f.db.log.filter(entry => entry.table === "motorist_cases")).toHaveLength(4);
    expect(mocks.claims).toHaveBeenCalledWith(token, { allowExpired: true });
  });
  it.each(["?status=open", "?ownerId=x", "?organizationId=x", "?q=", "?x=1&x=2"])("rejects every query parameter after authentication and before case reads: %s", async query => {
    const response = await GET(request(query));
    expect(response.status).toBe(400); expectPrivate(response);
    expect(mocks.claims).toHaveBeenCalledOnce();
    expect(f.db.log.map(entry => entry.table)).toEqual(["motorist_profiles"]);
  });
  it.each(["", "Bearer malformed"])("denies anonymous/cookie-only or malformed bearer before invalid query parsing: %s", async authorization => {
    const response = await GET(request("?bad=1", { authorization, Cookie: "sb-auth-token=fixture" }));
    expect(response.status).toBe(401); expectPrivate(response);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(mocks.claims).not.toHaveBeenCalled(); expect(f.db.log).toEqual([]);
  });
  it("verifies the signature before reading application data", async () => {
    mocks.claims.mockResolvedValue({ data: null, error: new Error("PRIVATE signature error") });
    const response = await GET(request());
    expect(response.status).toBe(401); expectPrivate(response); expect(f.db.log).toEqual([]);
  });
  it("rejects environment mismatch before counts or auth backend", async () => {
    const response = await GET(request("", { "X-PM-App-Environment": "production" }));
    expect(response.status).toBe(409); expectPrivate(response);
    expect(mocks.claims).not.toHaveBeenCalled(); expect(f.db.log).toEqual([]);
  });
  it.each([{ role: "driver" }, { active: false }, { kind: "ai" }, { access_status: "disabled" }, { organization_id: userId }])("rejects unauthorized profile %j", async change => {
    f.db.update("motorist_profiles", change, () => true);
    const response = await GET(request());
    expect(response.status).toBe(403); expectPrivate(response);
    expect(f.db.log.map(entry => entry.table)).toEqual(["motorist_profiles"]);
  });
  it("fences a changed organization without revealing counts", async () => {
    const response = await GET(request("", { "X-PM-Expected-Organization": userId }));
    expect(response.status).toBe(409); expectPrivate(response);
    expect(await response.json()).toMatchObject({ code: "expected_organization_mismatch" });
    expect(f.db.log.map(entry => entry.table)).toEqual(["motorist_profiles"]);
  });
  it("rejects malformed organization fence before application queries", async () => {
    const response = await GET(request("", { "X-PM-Expected-Organization": "invalid" }));
    expect(response.status).toBe(400); expectPrivate(response); expect(f.db.log).toEqual([]);
  });
  it.each(["motorist_profiles", "motorist_cases"])("sanitizes %s failure without fabricated zeros", async table => {
    f.db.failNext(table, "select", "PRIVATE DB ERROR");
    const response = await GET(request());
    expect(response.status).toBe(503); expectPrivate(response);
    expect(await response.json()).toEqual({ ok: false, error: "Prehľad prípadov sa nepodarilo načítať." });
  });
});
