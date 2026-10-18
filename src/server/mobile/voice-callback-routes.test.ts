import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MotoristActor } from "@/server/api-auth";
import { createFakeSupabase } from "@/test/fake-supabase";
import * as callback from "@/app/api/mobile/v1/voice/calls/callback/route";
import * as calls from "@/app/api/mobile/v1/voice/calls/route";
import * as cancel from "@/app/api/mobile/v1/voice/calls/attempt/end/route";
import { initialOperationIdentity } from "@/server/telephony/initial-call-operation";
import { CallActionError } from "@/server/telephony/service-errors";
import { nativeOutboundInput } from "./voice-input";

const mocks = vi.hoisted(() => ({ claims: vi.fn(), admin: vi.fn(), organization: vi.fn(), telephony: vi.fn(), callback: vi.fn(), dial: vi.fn(), hangup: vi.fn(), continuation: vi.fn(), after: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getClaims: mocks.claims } }) }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("@/server/default-organization", () => ({ resolveDefaultOrganizationId: mocks.organization }));
vi.mock("@/server/telephony/runtime", () => ({ createTelephonyDeps: mocks.telephony, readJsonBody: async (request: Request) => {
  const parsed = await request.json().catch(() => null); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}, toCallActor: (actor: MotoristActor) => ({ profileId: actor.profileId, displayName: actor.displayName, role: actor.role }) }));
vi.mock("@/server/telephony/call-actions", () => ({ startOutboundCall: mocks.dial, callColleague: vi.fn(), hangupCall: mocks.hangup, continueAcceptedHangup: mocks.continuation }));
vi.mock("@/server/telephony/callbacks", () => ({ callBackRequest: mocks.callback }));
vi.mock("next/server", () => ({ after: mocks.after }));

const userId = "11111111-1111-4111-8111-111111111111", profileId = "22222222-2222-4222-8222-222222222222";
const organizationId = "33333333-3333-4333-8333-333333333333", callbackRequestId = "44444444-4444-4444-8444-444444444444";
const deviceSessionId = "55555555-5555-4555-8555-555555555555", requestId = "66666666-6666-4666-8666-666666666666";
const verificationId = "77777777-7777-4777-8777-777777777777", sessionId = "88888888-8888-4888-8888-888888888888";
const issuer = "https://nzpnqdstvkfncflgqlny.supabase.co/auth/v1";
const claims = () => ({ sub: userId, iss: issuer, aud: "authenticated", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });
const token = Buffer.from(JSON.stringify({ alg: "ES256" })).toString("base64url") + "." + Buffer.from(JSON.stringify(claims())).toString("base64url") + ".c2lnbmF0dXJl";
const actor = { profileId, displayName: "Mobilná dispečerka", role: "dispatcher" as const };
let f: ReturnType<typeof createFakeSupabase>;
function request(path: string, input: unknown, headers: Record<string, string> = {}) {
  return new Request("https://test.dispecing.linkapomoci.sk/api/mobile/v1/voice/" + path, {
    method: "POST", headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": "test", "Content-Type": "application/json", ...headers },
    body: typeof input === "string" ? input : JSON.stringify(input),
  });
}
function privateResponse(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("private, no-store"); expect(response.headers.get("Set-Cookie")).toBeNull();
}
beforeEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries({ MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
    VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk", APP_BASE_URL: "https://test.dispecing.linkapomoci.sk",
    SUPABASE_URL: issuer.replace("/auth/v1", ""), SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture", MOTORIST_NATIVE_VOICE_TEST_ENABLED: "true" })) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network IO"); }));
  mocks.claims.mockResolvedValue({ data: { claims: claims() }, error: null }); mocks.organization.mockResolvedValue(organizationId);
  f = createFakeSupabase();
  f.db.seed("motorist_profiles", [{ id: profileId, user_id: userId, organization_id: organizationId, display_name: actor.displayName, role: "dispatcher", active: true, access_status: "active", kind: "human" }]);
  f.db.seed("motorist_operator_mobile_devices", [{ organization_id: organizationId, profile_id: profileId, environment: "development",
    device_session_id: deviceSessionId, registration_state: "registered", sip_username: "private-sip" }]);
  mocks.admin.mockReturnValue(f.client); mocks.telephony.mockResolvedValue({ admin: f.client, organizationId, environment: "development", deviceKind: "mobile" });
  mocks.callback.mockResolvedValue({ request: { id: callbackRequestId }, linked: true,
    call: { sessionId, operatorLegCallControlId: "operator-control", telnyxSessionId: "PRIVATE_TELNYX", to: "+421905111222", from: "+421232000000" } });
  mocks.dial.mockResolvedValue({ sessionId, operatorLegCallControlId: "operator-control", to: "+421905444555" });
  mocks.hangup.mockResolvedValue({ sessionId, terminationPending: false });
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const input = { deviceSessionId, requestId, callbackRequestId: callbackRequestId.toUpperCase(), verificationId };
describe("native callback call", () => {
  it("rings back through the existing callback service under the current mobile lease", async () => {
    const response = await callback.POST(request("calls/callback", input)); expect(response.status).toBe(200); privateResponse(response);
    const body = await response.json();
    expect(body).toEqual({ ok: true, apiVersion: 1, environment: "test", profileId, checkedAt: expect.any(String), sessionId,
      operatorLegCallControlId: "operator-control", to: "+421905111222", callbackRequestId, linked: true });
    expect(JSON.stringify(body)).not.toContain("PRIVATE");
    expect(mocks.telephony).toHaveBeenCalledWith({ organizationId, deviceKind: "mobile" });
    expect(mocks.callback).toHaveBeenCalledWith(expect.objectContaining({ deviceKind: "mobile" }), actor, callbackRequestId, verificationId, requestId);
  });
  it("omits an unconfirmed alternative target", async () => {
    expect((await callback.POST(request("calls/callback", { deviceSessionId, requestId, callbackRequestId }))).status).toBe(200);
    expect(mocks.callback).toHaveBeenCalledWith(expect.anything(), actor, callbackRequestId, undefined, requestId);
  });
  it("blocks disabled native calling before parsing or dependencies", async () => {
    vi.stubEnv("MOTORIST_NATIVE_VOICE_TEST_ENABLED", "false");
    const response = await callback.POST(request("calls/callback", "malformed")); expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "native_voice_disabled" }); expect(mocks.telephony).not.toHaveBeenCalled();
  });
  it("requires the current device lease", async () => {
    const response = await callback.POST(request("calls/callback", { ...input, deviceSessionId: callbackRequestId }));
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "native_lease_stale" }); expect(mocks.callback).not.toHaveBeenCalled();
  });
  it.each(["malformed", "[]", JSON.stringify({ deviceSessionId, requestId }), JSON.stringify({ ...input, to: "+421900000000" }),
    JSON.stringify({ ...input, verificationId: "not-a-uuid" }), JSON.stringify({ ...input, requestId: "x" }), " ".repeat(64_001)])("rejects invalid commands: %s", async body => {
    expect((await callback.POST(request("calls/callback", body))).status).toBe(400); expect(mocks.callback).not.toHaveBeenCalled();
  });
  it("passes known refusals and hides unexpected failures", async () => {
    mocks.callback.mockRejectedValueOnce(new CallActionError("Potvrďte platný overený cieľ spätného volania.", 409, "callback_target_confirmation_required"));
    const refused = await callback.POST(request("calls/callback", input)); expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ ok: false, error: "Potvrďte platný overený cieľ spätného volania.", code: "callback_target_confirmation_required" });
    mocks.callback.mockRejectedValueOnce(new Error("PRIVATE_PROVIDER"));
    const failed = await callback.POST(request("calls/callback", input)); expect(failed.status).toBe(503);
    expect(JSON.stringify(await failed.json())).not.toContain("PRIVATE");
  });
});

describe("native callback target confirmation and retry", () => {
  function seedRequest() {
    f.db.seed("motorist_callback_requests", [{ id: callbackRequestId, organization_id: organizationId, caller_number: "+421232408700", status: "open", source: "missed" }]);
  }
  it("accepts the confirmation that still names the current replacement", async () => {
    seedRequest();
    f.db.registerRpc("motorist_resolve_callback_target", args => { expect(args).toEqual({ p_organization_id: organizationId, p_number: "+421232408700" });
      return { originalNumber: "+421232408700", dialNumber: "+421905444555", status: "verified_alternative", verificationId }; });
    expect((await callback.POST(request("calls/callback", input))).status).toBe(200);
    expect(mocks.callback).toHaveBeenCalledWith(expect.anything(), actor, callbackRequestId, verificationId, requestId);
  });
  it.each([
    { originalNumber: "+421232408700", dialNumber: "+421232408700", status: "original", verificationId: null },
    { originalNumber: "+421232408700", dialNumber: "+421905000000", status: "verified_alternative", verificationId: sessionId },
    { originalNumber: "+421232408700", dialNumber: null, status: "blocked", verificationId: null },
  ])("asks for a new confirmation when the directory changed %#", async resolution => {
    seedRequest(); f.db.registerRpc("motorist_resolve_callback_target", () => resolution);
    const response = await callback.POST(request("calls/callback", input)); expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "callback_target_changed" }); expect(mocks.callback).not.toHaveBeenCalled();
  });
  it("replays a retry with the recorded target decision instead of the client's confirmation", async () => {
    seedAttempt({ id: requestId, actorId: profileId, fingerprint: "recorded", callbackRequestId, request: { requestId, to: "+421232408700", callbackRequestId } });
    expect((await callback.POST(request("calls/callback", input))).status).toBe(200);
    expect(mocks.callback).toHaveBeenCalledWith(expect.anything(), actor, callbackRequestId, undefined, requestId);
  });
  it("refuses to reuse an attempt identity for another callback request", async () => {
    seedAttempt({ id: requestId, actorId: profileId, fingerprint: "recorded", callbackRequestId: sessionId, request: { requestId, to: "+421232408700", callbackRequestId: sessionId } });
    expect((await callback.POST(request("calls/callback", input))).status).toBe(409); expect(mocks.callback).not.toHaveBeenCalled();
  });
});

describe("native dial with a confirmed alternative target", () => {
  it("passes the confirmation to the existing outbound guard", async () => {
    const response = await calls.POST(request("calls", { deviceSessionId, requestId, to: "+421232408700", verificationId })); expect(response.status).toBe(200);
    expect(mocks.dial).toHaveBeenCalledWith(expect.anything(), actor, { requestId, to: "+421232408700", callbackTargetVerificationId: verificationId });
    expect(await response.json()).toMatchObject({ sessionId, to: "+421905444555" });
  });
  it("keeps the original dial shape without confirmation and rejects malformed confirmations", async () => {
    await calls.POST(request("calls", { deviceSessionId, requestId, to: "+421905111222" }));
    expect(mocks.dial).toHaveBeenLastCalledWith(expect.anything(), actor, { requestId, to: "+421905111222" });
    for (const bad of [4, "", "not-a-uuid"]) expect((await calls.POST(request("calls", { deviceSessionId, requestId, to: "+421905111222", verificationId: bad }))).status).toBe(400);
    expect(mocks.dial).toHaveBeenCalledTimes(1);
  });
});

function seedAttempt(initial: Record<string, unknown>) {
  f.db.seed("motorist_call_sessions", [{ id: sessionId, organization_id: organizationId, direction: "outbound", state: "dialing",
    answered_by_profile_id: profileId, ended_at: null, metadata: { environment: "development", initial_operation: initial } }]);
  f.db.seed("motorist_call_legs", [{ id: deviceSessionId, session_id: sessionId, organization_id: organizationId, profile_id: profileId,
    role: "operator", to_number: "sip:private-sip@sip.telnyx.com", telnyx_call_control_id: "operator-control", ended_at: null }]);
}
describe("native callback attempt cleanup", () => {
  const cancelCallback = { deviceSessionId, requestId, kind: "callback", callbackRequestId };
  it("keeps a missing attempt unresolved", async () => {
    const response = await cancel.POST(request("calls/attempt/end", cancelCallback)); expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ resolved: false, sessionId: null }); expect(mocks.hangup).not.toHaveBeenCalled();
  });
  it("ends only the attempt recorded for the same callback request", async () => {
    seedAttempt({ ...initialOperationIdentity(actor, "outbound", nativeOutboundInput(requestId, "+421905111222")), callbackRequestId });
    const response = await cancel.POST(request("calls/attempt/end", { ...cancelCallback, callbackRequestId: callbackRequestId.toUpperCase() }));
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ resolved: true, sessionId, terminationPending: false });
    expect(mocks.hangup).toHaveBeenCalledWith(expect.objectContaining({ deviceKind: "mobile" }), actor, sessionId);
  });
  it("refuses an attempt that belongs to another callback request", async () => {
    seedAttempt({ ...initialOperationIdentity(actor, "outbound", nativeOutboundInput(requestId, "+421905111222")), callbackRequestId: verificationId });
    expect((await cancel.POST(request("calls/attempt/end", cancelCallback))).status).toBe(409); expect(mocks.hangup).not.toHaveBeenCalled();
  });
  it("matches an external attempt only with the same confirmed target", async () => {
    seedAttempt(initialOperationIdentity(actor, "outbound", nativeOutboundInput(requestId, "+421232408700", verificationId))!);
    const external = { deviceSessionId, requestId, kind: "external", to: "+421232408700" };
    expect((await cancel.POST(request("calls/attempt/end", external))).status).toBe(409);
    const response = await cancel.POST(request("calls/attempt/end", { ...external, verificationId })); expect(response.status).toBe(200);
    expect(mocks.hangup).toHaveBeenCalledTimes(1);
  });
  it.each([{ ...cancelCallback, callbackRequestId: "x" }, { ...cancelCallback, to: "+421905111222" }, { ...cancelCallback, verificationId: 1 },
    { deviceSessionId, requestId, kind: "internal", targetProfileId: profileId, verificationId }])("rejects invalid cleanup input %j", async body => {
    expect((await cancel.POST(request("calls/attempt/end", body))).status).toBe(400); expect(mocks.hangup).not.toHaveBeenCalled();
  });
});

it("exports only POST for the native callback route", () => {
  expect(Object.keys(callback).sort()).toEqual(["POST", "maxDuration", "runtime"]);
});
