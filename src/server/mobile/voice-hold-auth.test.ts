import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
import * as change from "@/app/api/mobile/v1/voice/calls/[id]/hold/route";
import * as resolve from "@/app/api/mobile/v1/voice/calls/[id]/hold/status/route";
const mocks = vi.hoisted(() => ({ claims: vi.fn(), admin: vi.fn(), organization: vi.fn(), telephony: vi.fn(), call: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getClaims: mocks.claims } }) }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("@/server/default-organization", () => ({ resolveDefaultOrganizationId: mocks.organization }));
vi.mock("@/server/telephony/runtime", () => ({ createTelephonyDeps: mocks.telephony }));
vi.mock("./voice-hold", () => ({ changeNativeHold: mocks.call, resolveNativeHold: mocks.call }));
const context = { params: Promise.resolve({ id: "77777777-7777-4777-8777-777777777777" }) };
const userId = "11111111-1111-4111-8111-111111111111", profileId = "22222222-2222-4222-8222-222222222222";
const organizationId = "33333333-3333-4333-8333-333333333333";
const deviceSessionId = "55555555-5555-4555-8555-555555555555", requestId = "66666666-6666-4666-8666-666666666666";
const issuer = "https://nzpnqdstvkfncflgqlny.supabase.co/auth/v1";
const claims = () => ({ sub: userId, iss: issuer, aud: "authenticated", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });
const token = Buffer.from(JSON.stringify({ alg: "ES256" })).toString("base64url") + "." + Buffer.from(JSON.stringify(claims())).toString("base64url") + ".c2lnbmF0dXJl";
let f: ReturnType<typeof createFakeSupabase>;
type HoldEndpoint = "hold" | "hold/status";
const holdBody = { deviceSessionId, requestId, callControlId: "operator-control", held: true, expectedVersion: 4 };
function request(endpoint: HoldEndpoint, headers: Record<string, string> = {}, input: unknown = holdBody, query = "") {
    return new Request(`https://test.dispecing.linkapomoci.sk/api/mobile/v1/voice/calls/77777777-7777-4777-8777-777777777777/${endpoint}${query}`, {
        method: "POST", headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": "test", "Content-Type": "application/json", ...headers },
        body: typeof input === "string" ? input : JSON.stringify(input),
    });
}
function privateResponse(response: Response) {
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Authorization, X-PM-App-Environment");
    expect(response.headers.get("Set-Cookie")).toBeNull();
}
beforeEach(() => {
    vi.resetAllMocks();
    for (const [key, value] of Object.entries({ MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
        VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk", APP_BASE_URL: "https://test.dispecing.linkapomoci.sk",
        SUPABASE_URL: issuer.replace("/auth/v1", ""), SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture", MOTORIST_NATIVE_VOICE_TEST_ENABLED: "true" }))
        vi.stubEnv(key, value);
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network IO"); }));
    mocks.claims.mockResolvedValue({ data: { claims: claims() }, error: null });
    mocks.organization.mockResolvedValue(organizationId);
    f = createFakeSupabase();
    f.db.seed("motorist_profiles", [{ id: profileId, user_id: userId, organization_id: organizationId,
        display_name: "Dispatcher", role: "dispatcher", active: true, access_status: "active", kind: "human" }]);
    f.db.seed("motorist_operator_mobile_devices", [{ organization_id: organizationId, profile_id: profileId, environment: "development",
            device_session_id: deviceSessionId, registration_state: "registered", sip_username: "private-sip" }]);
    mocks.admin.mockReturnValue(f.client);
    mocks.telephony.mockResolvedValue({ admin: f.client, organizationId, environment: "development", deviceKind: "mobile" });
    mocks.call.mockResolvedValue({ sessionId: "77777777-7777-4777-8777-777777777777", state: "held", connected: true, ended: false,
        terminationPending: false, media: { version: 5, state: "held", canHold: true, callControlId: holdBody.callControlId },
        operation: { requestId, held: true, outcome: "accepted" } });
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
for (const [endpoint, invoke] of [["hold", (r: Request) => change.POST(r, context)], ["hold/status", (r: Request) => resolve.POST(r, context)]] as const)
    describe(endpoint + " mobile hold authorization", () => {
        it.each(["", "Bearer invalid"])("authenticates before malformed input or cookies: %s", async (authorization) => {
            const response = await invoke(request(endpoint, { authorization, Cookie: "session=pretend" }, "invalid", "?bad=1"));
            expect(response.status).toBe(401);
            privateResponse(response);
            expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
            expect(mocks.admin).not.toHaveBeenCalled();
            expect(mocks.telephony).not.toHaveBeenCalled();
            expect(mocks.call).not.toHaveBeenCalled();
        });
        it.each<Record<string, string>>([{ "X-PM-App-Environment": "production" }, { "X-PM-Expected-Organization": userId }])("rejects wrong verified scope %j", async (headers) => {
            const response = await invoke(request(endpoint, headers));
            expect(response.status).toBe(409);
            privateResponse(response);
            expect(mocks.telephony).not.toHaveBeenCalled();
            expect(mocks.call).not.toHaveBeenCalled();
        });
        it.each([{ active: false }, { kind: "ai" }, { role: "driver" }, { organization_id: userId }])("rejects unavailable actor %j", async (patch) => {
            f.db.update("motorist_profiles", patch, row => row.id === profileId);
            const response = await invoke(request(endpoint));
            expect(response.status).toBe(403);
            privateResponse(response);
            expect(mocks.telephony).not.toHaveBeenCalled();
        });
        it("never trusts an unverified signature", async () => {
            mocks.claims.mockResolvedValue({ data: null, error: new Error("bad signature") });
            const response = await invoke(request(endpoint));
            expect(response.status).toBe(401);
            expect(mocks.admin).not.toHaveBeenCalled();
        });
    });
it("disabled native blocks creation but permits read-only receipt resolution", async () => {
    vi.stubEnv("MOTORIST_NATIVE_VOICE_TEST_ENABLED", "false");
    expect((await change.POST(request("hold"), context)).status).toBe(503);
    expect(mocks.telephony).not.toHaveBeenCalled();
    mocks.call.mockResolvedValue({ sessionId: "77777777-7777-4777-8777-777777777777", state: "talking", connected: true, ended: false,
        terminationPending: false, media: { version: 4, state: "unavailable", canHold: false, callControlId: null },
        operation: { requestId, held: true, outcome: "not_found" } });
    expect((await resolve.POST(request("hold/status"), context)).status).toBe(200);
    expect(mocks.telephony).toHaveBeenCalledWith({ organizationId, deviceKind: "mobile" });
});
