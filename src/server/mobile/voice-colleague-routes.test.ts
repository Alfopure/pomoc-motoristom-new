import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MotoristActor } from "@/server/api-auth";
import { createFakeSupabase } from "@/test/fake-supabase";
import * as directory from "@/app/api/mobile/v1/voice/colleagues/route";
import * as cancel from "@/app/api/mobile/v1/voice/calls/attempt/end/route";
import { initialOperationIdentity } from "@/server/telephony/initial-call-operation";
import * as internal from "@/app/api/mobile/v1/voice/calls/internal/route";
import { ROUTE_AUTH_REGISTRY } from "@/server/route-auth-registry";
const mocks = vi.hoisted(() => ({ claims: vi.fn(), admin: vi.fn(), organization: vi.fn(), telephony: vi.fn(), call: vi.fn(), hangup: vi.fn(), continuation: vi.fn(), after: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getClaims: mocks.claims } }) }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("@/server/default-organization", () => ({ resolveDefaultOrganizationId: mocks.organization }));
vi.mock("@/server/telephony/runtime", () => ({ createTelephonyDeps: mocks.telephony, toCallActor: (actor: MotoristActor) => ({ profileId: actor.profileId, displayName: actor.displayName, role: actor.role }) }));
vi.mock("@/server/telephony/call-actions", () => ({ callColleague: mocks.call, hangupCall: mocks.hangup, continueAcceptedHangup: mocks.continuation }));
vi.mock("next/server", () => ({ after: mocks.after }));
const userId = "11111111-1111-4111-8111-111111111111", profileId = "22222222-2222-4222-8222-222222222222";
const organizationId = "33333333-3333-4333-8333-333333333333", targetProfileId = "44444444-4444-4444-8444-444444444444";
const deviceSessionId = "55555555-5555-4555-8555-555555555555", requestId = "66666666-6666-4666-8666-666666666666";
const issuer = "https://nzpnqdstvkfncflgqlny.supabase.co/auth/v1";
const claims = () => ({ sub: userId, iss: issuer, aud: "authenticated", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });
const token = Buffer.from(JSON.stringify({ alg: "ES256" })).toString("base64url") + "." + Buffer.from(JSON.stringify(claims())).toString("base64url") + ".c2lnbmF0dXJl";
let f: ReturnType<typeof createFakeSupabase>;
function request(method: "GET" | "POST", headers: Record<string, string> = {}, input: unknown = { deviceSessionId, requestId, targetProfileId }, query = "") {
  return new Request("https://test.dispecing.linkapomoci.sk/api/mobile/v1/voice/" + (method === "GET" ? "colleagues" : "calls/internal") + query, {
    method, headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": "test", "Content-Type": "application/json", ...headers },
    ...(method === "POST" ? { body: typeof input === "string" ? input : JSON.stringify(input) } : {}),
  });
}
function privateResponse(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("Vary")).toBe("Authorization, X-PM-App-Environment"); expect(response.headers.get("Set-Cookie")).toBeNull();
}
beforeEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries({ MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
    VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk", APP_BASE_URL: "https://test.dispecing.linkapomoci.sk",
    SUPABASE_URL: issuer.replace("/auth/v1", ""), SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture", MOTORIST_NATIVE_VOICE_TEST_ENABLED: "true" })) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network IO"); }));
  mocks.claims.mockResolvedValue({ data: { claims: claims() }, error: null }); mocks.organization.mockResolvedValue(organizationId);
  f = createFakeSupabase();
  f.db.seed("motorist_profiles", [profileId, targetProfileId].map((id, i) => ({ id, user_id: i ? targetProfileId : userId, organization_id: organizationId,
    display_name: i ? "Colleague" : "Caller", role: "dispatcher", active: true, access_status: "active", kind: "human" })));
  f.db.seed("motorist_operator_mobile_devices", [{ organization_id: organizationId, profile_id: profileId, environment: "development",
    device_session_id: deviceSessionId, registration_state: "registered", sip_username: "private-sip" }]);
  mocks.admin.mockReturnValue(f.client); mocks.telephony.mockResolvedValue({ admin: f.client, organizationId, environment: "development", deviceKind: "mobile" });
  mocks.hangup.mockResolvedValue({ sessionId: requestId });
  mocks.call.mockResolvedValue({ sessionId: requestId, operatorLegCallControlId: "control", to: "sip:private@sip.telnyx.com" });
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
for (const [method, invoke] of [["GET", directory.GET], ["POST", internal.POST], ["POST", cancel.POST]] as const) describe(method + " mobile colleague authorization", () => {
  it.each(["", "Bearer invalid"])("authenticates before malformed input or cookies: %s", async authorization => {
    const response = await invoke(request(method, { authorization, Cookie: "session=pretend" }, "invalid", "?bad=1"));
    expect(response.status).toBe(401); privateResponse(response); expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(mocks.admin).not.toHaveBeenCalled(); expect(mocks.telephony).not.toHaveBeenCalled(); expect(mocks.call).not.toHaveBeenCalled();
  });
  it.each<Record<string, string>>([{ "X-PM-App-Environment": "production" }, { "X-PM-Expected-Organization": userId }])("rejects wrong verified scope %j", async headers => {
    const response = await invoke(request(method, headers)); expect(response.status).toBe(409); privateResponse(response);
    expect(mocks.telephony).not.toHaveBeenCalled(); expect(mocks.call).not.toHaveBeenCalled();
  });
  it.each([{ active: false }, { kind: "ai" }, { role: "driver" }, { organization_id: userId }])("rejects unavailable actor %j", async patch => {
    f.db.update("motorist_profiles", patch, row => row.id === profileId);
    const response = await invoke(request(method)); expect(response.status).toBe(403); privateResponse(response); expect(mocks.telephony).not.toHaveBeenCalled();
  });
  it("never trusts an unverified signature", async () => {
    mocks.claims.mockResolvedValue({ data: null, error: new Error("bad signature") });
    const response = await invoke(request(method)); expect(response.status).toBe(401); expect(mocks.admin).not.toHaveBeenCalled();
  });
});
describe("mobile colleague route contracts", () => {
  it("lists scoped names without a provider or endpoint disclosure even with native disabled", async () => {
    vi.stubEnv("MOTORIST_NATIVE_VOICE_TEST_ENABLED", "false");
    const response = await directory.GET(request("GET")); expect(response.status).toBe(200); privateResponse(response);
    expect(await response.json()).toEqual({ ok: true, apiVersion: 1, environment: "test", profileId, checkedAt: expect.any(String), hasMore: false,
      colleagues: [{ profileId: targetProfileId, displayName: "Colleague", status: "offline", canCall: false, reason: "offline" }] });
    expect(mocks.telephony).not.toHaveBeenCalled(); expect(mocks.call).not.toHaveBeenCalled();
  });
  it("rejects query overrides and duplicates after authentication", async () => {
    for (const query of ["?q=a&q=b", "?q=*", "?profileId=spoof", "?q="+"a".repeat(81)]) expect((await directory.GET(request("GET", {}, undefined, query))).status).toBe(400);
    expect(mocks.telephony).not.toHaveBeenCalled();
  });
  it("calls with server actor, exact command and native dependencies, returning a name instead of SIP", async () => {
    const response = await internal.POST(request("POST", { "X-Profile-Id": targetProfileId })); expect(response.status).toBe(200); privateResponse(response);
    expect(await response.json()).toEqual({ ok: true, apiVersion: 1, environment: "test", profileId, checkedAt: expect.any(String), sessionId: requestId,
      operatorLegCallControlId: "control", targetProfileId, to: "Colleague" });
    expect(mocks.telephony).toHaveBeenCalledWith({ organizationId, deviceKind: "mobile" });
    expect(mocks.call).toHaveBeenCalledWith(expect.objectContaining({ organizationId }), expect.objectContaining({ profileId, organizationId, userId }), { requestId, targetProfileId });
  });
  it("blocks disabled native creation before parsing body or constructing dependencies", async () => {
    vi.stubEnv("MOTORIST_NATIVE_VOICE_TEST_ENABLED", "false");
    const response = await internal.POST(request("POST", {}, "malformed")); expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "native_voice_disabled" }); expect(mocks.telephony).not.toHaveBeenCalled();
  });
  it.each(["malformed", "[]", JSON.stringify({ deviceSessionId, requestId, targetProfileId, profileId }), " ".repeat(64_001)])("rejects invalid or oversized commands before calling: %s", async body => {
    expect((await internal.POST(request("POST", {}, body))).status).toBe(400); expect(mocks.call).not.toHaveBeenCalled();
  });
  it("sanitizes directory and call failures", async () => {
    f.db.failNext("motorist_operator_presence", "select", "PRIVATE");
    const first = await directory.GET(request("GET")); expect(first.status).toBe(503); privateResponse(first); expect(JSON.stringify(await first.json())).not.toContain("PRIVATE");
    mocks.call.mockRejectedValue(new Error("PRIVATE"));
    const second = await internal.POST(request("POST")); expect(second.status).toBe(503); privateResponse(second); expect(JSON.stringify(await second.json())).not.toContain("PRIVATE");
  });
  it("exports only the supported methods and registers bearer auth", () => {
    expect(Object.keys(directory).sort()).toEqual(["GET", "runtime"]); expect(Object.keys(internal).sort()).toEqual(["POST", "maxDuration", "runtime"]);
    for (const path of ["mobile/v1/voice/colleagues", "mobile/v1/voice/calls/internal", "mobile/v1/voice/calls/attempt/end"]) expect(ROUTE_AUTH_REGISTRY[path]).toMatchObject({ class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"] });
  });
});


function seedOriginalAttempt(ended = false) {
  const actor = { profileId, displayName: "Caller", role: "dispatcher" as const };
  f.db.seed("motorist_call_sessions", [{ id: requestId, organization_id: organizationId, direction: "internal", state: ended ? "completed" : "received",
    answered_by_profile_id: profileId, ended_at: ended ? "2026-10-15T13:00:00Z" : null,
    metadata: { environment: "development", internal: { by: profileId, target_profile_id: targetProfileId },
      initial_operation: initialOperationIdentity(actor, "internal", { requestId, ...{ targetProfileId } }) } }]);
  f.db.seed("motorist_call_legs", [{ id: deviceSessionId, session_id: requestId, organization_id: organizationId, profile_id: profileId,
    role: "operator", to_number: "sip:private-sip@sip.telnyx.com", telnyx_call_control_id: "original", ended_at: ended ? "2026-10-15T13:00:00Z" : null }]);
}
const cancelInput = { deviceSessionId, requestId, kind: "internal", targetProfileId };
describe("explicit original native attempt cancellation HTTP contract", () => {
  it("returns202 unresolved for a missing session without treating absence as a successful cancellation", async () => {
    const response = await cancel.POST(request("POST", {}, cancelInput)); expect(response.status).toBe(202); privateResponse(response);
    expect(await response.json()).toMatchObject({ resolved: false, sessionId: null, terminationPending: false });
    expect(mocks.hangup).not.toHaveBeenCalled(); expect(mocks.after).not.toHaveBeenCalled(); expect(mocks.call).not.toHaveBeenCalled();
  });
  it("cleans up the exact original with native creation disabled and target deactivated", async () => {
    seedOriginalAttempt(); vi.stubEnv("MOTORIST_NATIVE_VOICE_TEST_ENABLED", "false");
    f.db.update("motorist_profiles", { active: false }, row => row.id === targetProfileId);
    const response = await cancel.POST(request("POST", {}, cancelInput)); expect(response.status).toBe(200); privateResponse(response);
    expect(await response.json()).toMatchObject({ resolved: true, sessionId: requestId, terminationPending: false });
    expect(mocks.hangup).toHaveBeenCalledWith(expect.objectContaining({ deviceKind: "mobile" }), { profileId, displayName: "Caller", role: "dispatcher" }, requestId);
    expect(mocks.call).not.toHaveBeenCalled();
  });
  it("returns202 only for durable pending termination and schedules the existing bounded continuation", async () => {
    seedOriginalAttempt(); mocks.hangup.mockResolvedValue({ sessionId: requestId, terminationPending: true });
    const response = await cancel.POST(request("POST", {}, cancelInput)); expect(response.status).toBe(202); privateResponse(response);
    expect(await response.json()).toMatchObject({ resolved: true, sessionId: requestId, terminationPending: true });
    expect(mocks.after).toHaveBeenCalledOnce();
    mocks.continuation.mockRejectedValue(new Error("recovery remains durable"));
    await mocks.after.mock.calls[0][0]();
    expect(mocks.continuation).toHaveBeenCalledWith(expect.anything(), requestId, expect.any(Number));
  });
  it("acknowledges an already-ended original only after ownership proof", async () => {
    seedOriginalAttempt(true);
    expect(await (await cancel.POST(request("POST", {}, cancelInput))).json()).toMatchObject({ resolved: true, sessionId: requestId, terminationPending: false });
    expect(mocks.hangup).not.toHaveBeenCalled();
    f.db.update("motorist_call_legs", { to_number: "sip:other@sip.telnyx.com" }, () => true);
    expect((await cancel.POST(request("POST", {}, cancelInput))).status).toBe(403);
  });
  it("does not convert a provider failure into a resolved receipt", async () => {
    seedOriginalAttempt(); mocks.hangup.mockRejectedValue(new Error("PRIVATE_PROVIDER_ERROR"));
    const response = await cancel.POST(request("POST", {}, cancelInput)); expect(response.status).toBe(503); privateResponse(response);
    const body = await response.json(); expect(body).not.toHaveProperty("resolved"); expect(JSON.stringify(body)).not.toContain("PRIVATE");
    expect(mocks.after).not.toHaveBeenCalled();
  });
  it("keeps session lookup failure uncertain", async () => {
    f.db.failNext("motorist_call_sessions", "select", "PRIVATE_DB_ERROR");
    const response = await cancel.POST(request("POST", {}, cancelInput)); expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty("resolved"); expect(mocks.hangup).not.toHaveBeenCalled();
  });
  it.each(["malformed", "[]", JSON.stringify({ ...cancelInput, to: "+421905123456" }), " ".repeat(64_001)])("rejects invalid cancellation input", async body => {
    expect((await cancel.POST(request("POST", {}, body))).status).toBe(400); expect(mocks.hangup).not.toHaveBeenCalled();
  });
  it("does not bypass the exact native deployment gate for cleanup", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    expect((await cancel.POST(request("POST", {}, cancelInput))).status).toBe(503); expect(mocks.telephony).not.toHaveBeenCalled(); expect(mocks.hangup).not.toHaveBeenCalled();
  });
});
