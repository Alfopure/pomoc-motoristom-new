import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireMobileActor } from "./auth";

const mocks = vi.hoisted(() => ({ claims: vi.fn(), admin: vi.fn(), organization: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getClaims: mocks.claims } }) }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("@/server/default-organization", () => ({ resolveDefaultOrganizationId: mocks.organization }));

const userId = "11111111-1111-4111-8111-111111111111";
const profileId = "22222222-2222-4222-8222-222222222222";
const organizationId = "33333333-3333-4333-8333-333333333333";
const issuer = "https://nzpnqdstvkfncflgqlny.supabase.co/auth/v1";
const token = Buffer.from(JSON.stringify({ alg: "ES256", kid: "fixture" })).toString("base64url") + "."
  + Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url") + ".c2lnbmF0dXJl";
const claims = () => ({ sub: userId, iss: issuer, aud: "authenticated", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, email: "user@example.test" });
let profile: Record<string, unknown> | null;
let profileError: unknown;
function request(extra: Record<string, string> = {}) {
  return new Request("https://test.dispecing.linkapomoci.sk/api/mobile/v1/me?organizationId=forged", {
    headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": "test", ...extra },
  });
}
beforeEach(() => {
  vi.resetAllMocks(); vi.unstubAllEnvs();
  vi.stubEnv("MOTORIST_APP_ENV", "test"); vi.stubEnv("SUPABASE_URL", issuer.replace("/auth/v1", "")); vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_fixture");
  profile = { id: profileId, user_id: userId, organization_id: organizationId, display_name: "Testovací operátor", email: "operator@example.test", role: "dispatcher", active: true, access_status: "active", kind: "human" };
  profileError = null;
  mocks.claims.mockResolvedValue({ data: { claims: claims() }, error: null });
  mocks.organization.mockResolvedValue(organizationId);
  mocks.admin.mockImplementation(() => {
    const filters: ((row: Record<string, unknown>) => boolean)[] = [];
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters.push(row => row[key] === value); return query; },
      neq: (key: string, value: unknown) => { filters.push(row => row[key] !== value); return query; },
      maybeSingle: async () => ({ data: profile && filters.every(filter => filter(profile!)) ? profile : null, error: profileError }),
    };
    return { from: () => query };
  });
});
describe("native user authentication", () => {
  it("verifies the exact bearer token and derives identity from the active profile", async () => {
    expect(await requireMobileActor(request({ "X-Profile-Id": "forged", "X-Organization-Id": "forged" }))).toEqual({ userId, profileId, organizationId, displayName: "Testovací operátor", role: "dispatcher", email: "operator@example.test" });
    expect(mocks.claims).toHaveBeenCalledWith(token, { allowExpired: true });
  });
  it.each(["", "Basic dXNlcjpwYXNz", "Bearer cron-secret", "Bearer sb_secret_fixture", "Bearer a.b.c extra", "Bearer header.payload.signature"])("rejects non-user authorization %s", async authorization => {
    await expect(requireMobileActor(request({ authorization }))).rejects.toMatchObject({ status: 401 });
    expect(mocks.claims).not.toHaveBeenCalled(); expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("does not accept web cookies or a development bypass", async () => {
    vi.stubEnv("MOTORIST_DEV_AUTH_BYPASS", "true");
    await expect(requireMobileActor(request({ authorization: "", Cookie: "sb-auth-token=fixture" }))).rejects.toMatchObject({ status: 401 });
  });
  it("rejects a failed signature verification before reading application data", async () => {
    mocks.claims.mockResolvedValue({ data: null, error: new Error("Invalid signature") });
    await expect(requireMobileActor(request())).rejects.toMatchObject({ status: 401 });
    expect(mocks.organization).not.toHaveBeenCalled(); expect(mocks.admin).not.toHaveBeenCalled();
  });
  it.each([
    { iss: "https://ifpaeegaesdmljfkdvcn.supabase.co/auth/v1" },
    { aud: "anon" }, { role: "service_role" }, { sub: "not-a-user" }, { exp: 1 },
  ])("rejects invalid verified user claims %j", async changes => {
    mocks.claims.mockResolvedValue({ data: { claims: { ...claims(), ...changes } }, error: null });
    await expect(requireMobileActor(request())).rejects.toMatchObject({ status: 401 });
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("refuses mismatched client and server environments", async () => {
    await expect(requireMobileActor(request({ "X-PM-App-Environment": "production" }))).rejects.toMatchObject({ status: 409 });
    expect(mocks.claims).not.toHaveBeenCalled();
  });
  it.each([{ active: false }, { access_status: "disabled" }, { kind: "ai" }, { user_id: profileId }, { organization_id: profileId }, { role: "unknown" }])("denies unavailable or foreign profile %j", async changes => {
    Object.assign(profile!, changes);
    await expect(requireMobileActor(request())).rejects.toMatchObject({ status: 403 });
  });
  it("rechecks revocation on the next request without caching profile access", async () => {
    await requireMobileActor(request()); profile!.active = false;
    await expect(requireMobileActor(request())).rejects.toMatchObject({ status: 403 });
  });
  it("reports an access-query outage without granting access", async () => {
    profileError = new Error("database unavailable");
    await expect(requireMobileActor(request())).rejects.toMatchObject({ status: 503 });
  });
  it("reports an Auth outage as unavailable rather than an expired login", async () => {
    mocks.claims.mockResolvedValue({ data: null, error: { status: 503, name: "AuthRetryableFetchError" } });
    await expect(requireMobileActor(request())).rejects.toMatchObject({ status: 503 });
    expect(mocks.admin).not.toHaveBeenCalled();
  });
});

describe("expected organization fence for private drafts", () => {
  it("rejects a same-user/profile organization change while a legacy request still resolves its current actor", async () => {
    const headers = { "X-PM-Expected-Organization": organizationId };
    expect(await requireMobileActor(request(headers))).toMatchObject({ userId, profileId, organizationId });
    const nextOrganization = "44444444-4444-4444-8444-444444444444";
    profile!.organization_id = nextOrganization;
    mocks.organization.mockResolvedValue(nextOrganization);
    await expect(requireMobileActor(request(headers))).rejects.toMatchObject({ status: 409, code: "expected_organization_mismatch" });
    expect(await requireMobileActor(request())).toMatchObject({ userId, profileId, organizationId: nextOrganization });
  });
  it.each(["", "not-a-uuid", organizationId + "," + organizationId, "33333333-3333-4333-8333-33333333333z"])("rejects malformed supplied UUID %s before application reads", async header => {
    await expect(requireMobileActor(request({ "X-PM-Expected-Organization": header }))).rejects.toMatchObject({ status: 400 });
    expect(mocks.organization).not.toHaveBeenCalled(); expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("accepts a case-insensitive canonical UUID without selecting organization from the header", async () => {
    const resolved = "abcdefab-cdef-4abc-8abc-abcdefabcdef";
    mocks.organization.mockResolvedValue(resolved); profile!.organization_id = resolved;
    expect(await requireMobileActor(request({ "X-PM-Expected-Organization": resolved.toUpperCase(), "X-Organization-Id": profileId })))
      .toMatchObject({ organizationId: resolved, profileId, userId });
    expect(mocks.organization).toHaveBeenCalledWith();
  });
  it("does not let the expected header bypass JWT verification or grant profile access", async () => {
    mocks.claims.mockResolvedValueOnce({ data: null, error: new Error("Bad signature") });
    await expect(requireMobileActor(request({ "X-PM-Expected-Organization": organizationId }))).rejects.toMatchObject({ status: 401 });
    expect(mocks.admin).not.toHaveBeenCalled();
    profile!.active = false;
    await expect(requireMobileActor(request({ "X-PM-Expected-Organization": profileId }))).rejects.toMatchObject({ status: 403 });
  });
  it("keeps cookie-only requests unauthorized even with a matching expected organization", async () => {
    await expect(requireMobileActor(request({ authorization: "", Cookie: "sb-auth-token=fixture", "X-PM-Expected-Organization": organizationId })))
      .rejects.toMatchObject({ status: 401 });
    expect(mocks.organization).not.toHaveBeenCalled();
  });
});
