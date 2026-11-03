import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/mobile/v1/drafts/scope/route";

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
let profile: Record<string, unknown>;
let profileError: unknown;
function request(headers: Record<string, string> = {}) {
  return new Request("https://test.dispecing.linkapomoci.sk/api/mobile/v1/drafts/scope?organizationId=forged&profileId=forged", {
    headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": "test", ...headers },
  });
}
function expectPrivate(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("Vary")).toContain("Authorization");
  expect(response.headers.get("Vary")).toContain("X-PM-App-Environment");
}
beforeEach(() => {
  vi.resetAllMocks(); vi.unstubAllEnvs();
  vi.stubEnv("MOTORIST_APP_ENV", "test"); vi.stubEnv("SUPABASE_URL", issuer.replace("/auth/v1", ""));
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_fixture");
  mocks.claims.mockResolvedValue({ data: { claims: claims() }, error: null });
  mocks.organization.mockResolvedValue(organizationId);
  profile = { id: profileId, user_id: userId, organization_id: organizationId, display_name: "Fixture", email: "private@example.invalid", role: "dispatcher", active: true, access_status: "active", kind: "human" };
  profileError = null;
  mocks.admin.mockImplementation(() => ({ from: (table: string) => {
    expect(table).toBe("motorist_profiles");
    const filters: ((row: Record<string, unknown>) => boolean)[] = [];
    const read = {
      select: () => read,
      eq: (key: string, value: unknown) => { filters.push(row => row[key] === value); return read; },
      neq: (key: string, value: unknown) => { filters.push(row => row[key] !== value); return read; },
      maybeSingle: async () => ({ data: filters.every(filter => filter(profile)) ? profile : null, error: profileError }),
    };
    return read;
  } }));
});

describe("authenticated private draft scope", () => {
  it.each(["dispatcher", "senior_dispatcher", "manager", "admin"])("returns only authoritative scope for an authorized %s", async role => {
    profile.role = role;
    const response = await GET(request({ "X-Organization-Id": profileId, "X-Profile-Id": organizationId }));
    expect(response.status).toBe(200); expectPrivate(response);
    expect(await response.json()).toEqual({ ok: true, apiVersion: 1, environment: "test", profileId,
      organizationId, checkedAt: expect.any(String) });
    expect(mocks.claims).toHaveBeenCalledWith(token, { allowExpired: true });
    expect(mocks.admin).toHaveBeenCalledOnce();
  });
  it("rejects cookie-only requests without application reads", async () => {
    const response = await GET(request({ authorization: "", Cookie: "sb-auth-token=fixture" }));
    expect(response.status).toBe(401); expectPrivate(response);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(mocks.organization).not.toHaveBeenCalled(); expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("preserves environment mismatch409 before application reads", async () => {
    const response = await GET(request({ "X-PM-App-Environment": "production" }));
    expect(response.status).toBe(409); expectPrivate(response);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it.each([{ role: "driver" }, { active: false }, { kind: "ai" }, { access_status: "disabled" }])("denies an unavailable profile %j", async changes => {
    Object.assign(profile, changes);
    const response = await GET(request());
    expect(response.status).toBe(403); expectPrivate(response);
    expect(await response.json()).not.toHaveProperty("organizationId");
  });
  it("does not expose changed organization and returns the stable conflict code", async () => {
    const response = await GET(request({ "X-PM-Expected-Organization": profileId }));
    expect(response.status).toBe(409); expectPrivate(response);
    expect(await response.json()).toMatchObject({ ok: false, code: "expected_organization_mismatch" });
  });
  it("rejects malformed expected organization before profile queries", async () => {
    const response = await GET(request({ "X-PM-Expected-Organization": "spoof" }));
    expect(response.status).toBe(400); expectPrivate(response);
    expect(mocks.organization).not.toHaveBeenCalled(); expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("sanitizes access database outages", async () => {
    profileError = new Error("PRIVATE_ACCESS_FAILURE");
    const response = await GET(request());
    expect(response.status).toBe(503); expectPrivate(response);
    expect(await response.json()).toEqual({ ok: false, error: "Rozsah rozpracovaných údajov sa nepodarilo overiť." });
  });
});
