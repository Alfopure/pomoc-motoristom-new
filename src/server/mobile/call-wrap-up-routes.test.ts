import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
import * as wrapUp from "@/app/api/mobile/v1/calls/[id]/wrap-up/route";
import * as outcome from "@/app/api/mobile/v1/calls/[id]/outcome/route";
import * as linkCase from "@/app/api/mobile/v1/calls/[id]/case/route";
import { ROUTE_AUTH_REGISTRY } from "@/server/route-auth-registry";

const mocks = vi.hoisted(() => ({ claims: vi.fn(), admin: vi.fn(), organization: vi.fn(), dispatch: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getClaims: mocks.claims } }) }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("@/server/default-organization", () => ({ resolveDefaultOrganizationId: mocks.organization }));
vi.mock("@/data/dispatch-repository", () => ({ loadDispatchData: mocks.dispatch }));

const userId = "11111111-1111-4111-8111-111111111111", profileId = "22222222-2222-4222-8222-222222222222";
const organizationId = "33333333-3333-4333-8333-333333333333", colleagueId = "44444444-4444-4444-8444-444444444444";
const callId = "55555555-5555-4555-8555-555555555555", otherCall = "56565656-5656-4656-8656-565656565656";
const caseA = "66666666-6666-4666-8666-666666666666", caseB = "77777777-7777-4777-8777-777777777777", caseClosed = "78787878-7878-4878-8878-787878787878";
const contactId = "88888888-8888-4888-8888-888888888888", mutationId = "99999999-9999-4999-8999-999999999999";
const foreignOrg = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", foreignCall = "abababab-abab-4bab-8bab-abababababab";
const issuer = "https://nzpnqdstvkfncflgqlny.supabase.co/auth/v1";
const claimsBody = () => ({ sub: userId, iss: issuer, aud: "authenticated", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });
const token = Buffer.from(JSON.stringify({ alg: "ES256" })).toString("base64url") + "." + Buffer.from(JSON.stringify(claimsBody())).toString("base64url") + ".c2lnbmF0dXJl";
let f: ReturnType<typeof createFakeSupabase>;
function request(path: string, method: "GET" | "POST" = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return new Request("https://test.dispecing.linkapomoci.sk/api/mobile/v1/calls/" + path, {
    method, headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": "test", "X-PM-Expected-Organization": organizationId,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const read = (id = callId, headers: Record<string, string> = {}) => wrapUp.GET(request(id + "/wrap-up", "GET", undefined, headers), params(id));
const save = (body: unknown, id = callId) => outcome.POST(request(id + "/outcome", "POST", body), params(id));
const link = (body: unknown, id = callId) => linkCase.POST(request(id + "/case", "POST", body), params(id));
function privateResponse(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("private, no-store"); expect(response.headers.get("Set-Cookie")).toBeNull();
}
const call = () => f.db.find("motorist_calls", row => row.id === callId)!;

beforeEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries({ MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
    VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk", APP_BASE_URL: "https://test.dispecing.linkapomoci.sk",
    SUPABASE_URL: issuer.replace("/auth/v1", ""), SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture", SUPABASE_SECRET_KEY: "sb_secret_fixture",
    TELEPHONY_STABILITY_V1_ENABLED: "false", MOTORIST_ORGANIZATION_ID: "" })) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network IO"); }));
  mocks.claims.mockResolvedValue({ data: { claims: claimsBody() }, error: null }); mocks.organization.mockResolvedValue(organizationId);
  f = createFakeSupabase();
  f.db.seed("motorist_organizations", [{ id: organizationId, slug: "pomoc-motoristom", active: true }]);
  f.db.seed("motorist_profiles", [
    { id: profileId, user_id: userId, organization_id: organizationId, display_name: "Mobilná dispečerka", role: "dispatcher", active: true, access_status: "active", kind: "human", created_at: "2026-02-01T00:00:00Z" },
    { id: colleagueId, user_id: colleagueId, organization_id: organizationId, display_name: "Prvý profil", role: "admin", active: true, access_status: "active", kind: "human", created_at: "2026-01-01T00:00:00Z" },
  ]);
  f.db.seed("motorist_contacts", [{ id: contactId, organization_id: organizationId, name: "Ján Novák", phone: "+421 905 111 222", role: "Zákazník", updated_at: "2026-10-18T08:00:00Z" }]);
  f.db.seed("motorist_cases", [
    { id: caseA, organization_id: organizationId, case_number: "PM-2026-0101", case_type: "assistance", status: "in_progress", contact_id: contactId, updated_at: "2026-10-18T08:00:00Z" },
    { id: caseB, organization_id: organizationId, case_number: "PM-2026-0102", case_type: "assistance", status: "new", contact_id: null, updated_at: "2026-10-18T07:00:00Z" },
    { id: caseClosed, organization_id: organizationId, case_number: "PM-2026-0050", case_type: "assistance", status: "completed_assisted", contact_id: contactId, updated_at: "2026-10-10T07:00:00Z" },
  ]);
  f.db.seed("motorist_calls", [
    { id: callId, organization_id: organizationId, provider: "telnyx", provider_session_id: "provider-private", session_id: null, direction: "inbound", status: "missed",
      caller_number: "+421905111222", called_number: "+421232000000", destination_number: null, case_id: null, raw_latest_payload: { provider_secret: "PRIVATE" }, started_at: "2026-10-18T09:00:00Z" },
    { id: otherCall, organization_id: organizationId, provider: "telnyx", session_id: null, direction: "outbound", status: "ended",
      caller_number: "+421232000000", called_number: "+421905111222", destination_number: "+421905111222", case_id: caseB, raw_latest_payload: {}, started_at: "2026-10-17T09:00:00Z" },
    { id: foreignCall, organization_id: foreignOrg, provider: "telnyx", session_id: null, direction: "inbound", status: "missed", caller_number: "+421905111222", case_id: null, raw_latest_payload: {} },
  ]);
  mocks.admin.mockReturnValue(f.client);
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); expect(mocks.dispatch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("mobile after-call routes: authorization", () => {
  const invocations: [string, (headers: Record<string, string>) => Promise<Response>][] = [
    ["wrap-up", headers => wrapUp.GET(request(callId + "/wrap-up", "GET", undefined, headers), params(callId))],
    ["outcome", headers => outcome.POST(request(callId + "/outcome", "POST", { mutationId, outcome: "reached", note: null, callbackMinutes: null }, headers), params(callId))],
    ["case", headers => linkCase.POST(request(callId + "/case", "POST", { caseId: caseA, expectedCaseId: null }, headers), params(callId))],
  ];
  it.each(invocations)("%s authenticates before data or cookies", async (_name, invoke) => {
    for (const authorization of ["", "Bearer invalid"]) {
      const response = await invoke({ authorization, Cookie: "session=pretend" }); expect(response.status).toBe(401); privateResponse(response);
    }
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it.each(invocations)("%s rejects wrong environment or organization fences", async (_name, invoke) => {
    expect((await invoke({ "X-PM-App-Environment": "production" })).status).toBe(409);
    expect((await invoke({ "X-PM-Expected-Organization": foreignOrg })).status).toBe(409);
    expect(call()).toMatchObject({ case_id: null, raw_latest_payload: { provider_secret: "PRIVATE" } });
  });
  it.each(invocations)("%s requires the organization fence header", async (name) => {
    const path = callId + "/" + name, init = { headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": "test", "Content-Type": "application/json" } };
    const req = new Request("https://test.dispecing.linkapomoci.sk/api/mobile/v1/calls/" + path, name === "wrap-up" ? init : { ...init, method: "POST", body: "{}" });
    const response = name === "wrap-up" ? await wrapUp.GET(req, params(callId)) : name === "outcome" ? await outcome.POST(req, params(callId)) : await linkCase.POST(req, params(callId));
    expect(response.status).toBe(409);
  });
  it.each(invocations)("%s rejects an unavailable actor", async (_name, invoke) => {
    f.db.update("motorist_profiles", { active: false }, row => row.id === profileId);
    expect((await invoke({})).status).toBe(403);
  });
  it("does not expose or change another organization's call", async () => {
    expect((await read(foreignCall)).status).toBe(404);
    expect((await save({ mutationId, outcome: "reached", note: null, callbackMinutes: null }, foreignCall)).status).toBe(404);
    expect((await link({ caseId: caseA, expectedCaseId: null }, foreignCall)).status).toBe(404);
    expect(f.db.find("motorist_calls", row => row.id === foreignCall)).toMatchObject({ case_id: null, raw_latest_payload: {} });
  });
  it("registers bearer auth for all routes and exports only their methods", () => {
    expect(Object.keys(wrapUp).sort()).toEqual(["GET", "runtime"]); expect(Object.keys(outcome).sort()).toEqual(["POST", "runtime"]); expect(Object.keys(linkCase).sort()).toEqual(["POST", "runtime"]);
    for (const path of ["mobile/v1/calls/[id]/wrap-up", "mobile/v1/calls/[id]/outcome", "mobile/v1/calls/[id]/case"]) {
      expect(ROUTE_AUTH_REGISTRY[path]).toMatchObject({ class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"] });
    }
  });
});

describe("mobile after-call read", () => {
  it("projects the stored outcome, link state and live case suggestions without provider fields", async () => {
    f.db.update("motorist_calls", { raw_latest_payload: { provider_secret: "PRIVATE", outcome: "callback", outcomeNote: "Volať po\n11:00", callbackMinutes: 30, outcomeAt: "2026-10-18T09:05:00Z" } }, row => row.id === callId);
    const response = await read(callId.toUpperCase()); expect(response.status).toBe(200); privateResponse(response);
    const body = await response.json();
    expect(body).toEqual({ ok: true, apiVersion: 1, environment: "test", profileId, organizationId, checkedAt: expect.any(String), callId, number: "+421905111222",
      linkedCaseId: null, linkedCase: null, outcome: { value: "callback", label: "Zavolať naspäť", note: "Volať po\n11:00", callbackMinutes: 30, at: "2026-10-18T09:05:00.000Z" },
      callbackScheduling: "unavailable", matchesAvailable: true,
      suggestions: [
        { caseId: caseA, caseNumber: "PM-2026-0101", statusLabel: expect.any(String), open: true, contactName: "Ján Novák", reason: "contact" },
        { caseId: caseB, caseNumber: "PM-2026-0102", statusLabel: expect.any(String), open: true, contactName: null, reason: "previous_call" },
        { caseId: caseClosed, caseNumber: "PM-2026-0050", statusLabel: expect.any(String), open: false, contactName: "Ján Novák", reason: "contact" },
      ] });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("PRIVATE"); expect(raw).not.toContain(contactId); expect(raw).not.toContain(foreignCall);
  });
  it("reports the linked case, excludes it from suggestions and offers queue scheduling when enabled", async () => {
    f.db.update("motorist_calls", { case_id: caseA }, row => row.id === callId);
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    const body = await (await read()).json();
    expect(body).toMatchObject({ linkedCaseId: caseA, linkedCase: { id: caseA, caseNumber: "PM-2026-0101" }, callbackScheduling: "queue", outcome: null });
    expect(body.suggestions.map((item: { caseId: string }) => item.caseId)).not.toContain(caseA);
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "false");
    expect((await (await read()).json()).callbackScheduling).toBe("case_task");
  });
  it("keeps the call readable when caller matching fails", async () => {
    f.db.failNext("motorist_contacts", "select", "PRIVATE_MATCH_FAILURE");
    const body = await (await read()).json();
    expect(body).toMatchObject({ suggestions: [], matchesAvailable: false, number: "+421905111222" });
  });
  it("rejects malformed identifiers and query overrides", async () => {
    expect((await read("not-a-uuid")).status).toBe(404);
    expect((await wrapUp.GET(request(callId + "/wrap-up?profileId=" + colleagueId), params(callId))).status).toBe(400);
  });
});

describe("mobile call outcome", () => {
  it("records the outcome with the actor, audit source and exact replay", async () => {
    const response = await save({ mutationId: mutationId.toUpperCase(), outcome: "reached", note: "  Dovolané, odťah objednaný  ", callbackMinutes: null });
    expect(response.status).toBe(200); privateResponse(response);
    expect(await response.json()).toEqual({ ok: true, apiVersion: 1, environment: "test", profileId, organizationId, checkedAt: expect.any(String), callId, mutationId, replayed: false });
    expect(call()).toMatchObject({ summary: "Dovolané: Dovolané, odťah objednaný",
      raw_latest_payload: { provider_secret: "PRIVATE", outcome: "reached", outcomeNote: "Dovolané, odťah objednaný", outcomeBy: "mobile_app", outcomeMutationId: mutationId, outcomeActorId: profileId } });
    expect(f.db.rows("motorist_audit_log")).toEqual([expect.objectContaining({ action: "call.outcome", actor_profile_id: profileId, source: "mobile_app", entity_id: callId })]);
    const replay = await save({ mutationId, outcome: "reached", note: "Dovolané, odťah objednaný", callbackMinutes: null });
    expect(await replay.json()).toMatchObject({ replayed: true });
    expect(f.db.rows("motorist_audit_log")).toHaveLength(1); expect(f.db.rows("motorist_call_events")).toHaveLength(1);
  });
  it("writes the case timeline when the call is linked and creates the legacy callback task", async () => {
    f.db.update("motorist_calls", { case_id: caseA }, row => row.id === callId);
    expect((await save({ mutationId, outcome: "callback", note: null, callbackMinutes: 60 })).status).toBe(200);
    expect(f.db.rows("motorist_case_events")).toEqual([expect.objectContaining({ case_id: caseA, actor_profile_id: profileId, event_type: "call_outcome", title: "Výsledok hovoru: Zavolať naspäť" })]);
    expect(f.db.rows("motorist_case_tasks")).toEqual([expect.objectContaining({ case_id: caseA, assigned_to: profileId, status: "open", title: "Zavolať späť: +421905111222" })]);
  });
  it("schedules through the shared queue contract with the mutation as action identity", async () => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    const scheduled = vi.fn((args: Record<string, unknown>) => { void args; return null; }); f.db.registerRpc("motorist_schedule_callback_v1", scheduled);
    expect((await save({ mutationId, outcome: "callback", note: null, callbackMinutes: 15 })).status).toBe(200);
    expect(scheduled).toHaveBeenCalledOnce();
    expect(scheduled.mock.calls[0][0]).toMatchObject({ p_organization_id: organizationId, p_call_id: callId, p_actor_id: profileId, p_action_id: mutationId });
    expect(Date.parse(String(scheduled.mock.calls[0][0].p_due_at)) - Date.now()).toBeGreaterThan(14 * 60_000);
  });
  it("refuses a callback promise that nothing would schedule", async () => {
    const response = await save({ mutationId, outcome: "callback", note: null, callbackMinutes: 30 });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "callback_scheduling_unavailable" });
    expect(call().raw_latest_payload).toEqual({ provider_secret: "PRIVATE" });
  });
  it.each([
    "malformed", "[]", { outcome: "reached" }, { mutationId: "x", outcome: "reached" }, { mutationId, outcome: "maybe" },
    { mutationId, outcome: "reached", note: 4 }, { mutationId, outcome: "reached", note: "x".repeat(501) }, { mutationId, outcome: "reached", note: "a\u0007b" },
    { mutationId, outcome: "reached", callbackMinutes: 30 }, { mutationId, outcome: "callback", callbackMinutes: 2 }, { mutationId, outcome: "callback", callbackMinutes: 15.5 },
    { mutationId, outcome: "reached", profileId },
  ])("rejects invalid outcome input before writing %#", async body => {
    const response = await save(typeof body === "string" ? body : JSON.stringify(body)); expect(response.status).toBe(400); privateResponse(response);
    expect(f.db.rows("motorist_audit_log")).toHaveLength(0);
  });
  it("hides database failure details", async () => {
    f.db.failNext("motorist_calls", "update", "PRIVATE_DB_DETAIL");
    const response = await save({ mutationId, outcome: "reached", note: null, callbackMinutes: null });
    expect(response.status).toBeGreaterThanOrEqual(500); expect(JSON.stringify(await response.json())).not.toContain("PRIVATE");
  });
});

describe("mobile after-call review fixes", () => {
  it("answers as a replay only after every effect completed", async () => {
    f.db.update("motorist_calls", { case_id: caseA }, row => row.id === callId);
    f.db.failNext("motorist_audit_log", "insert", "PRIVATE_AUDIT_FAILURE");
    expect((await save({ mutationId, outcome: "callback", note: null, callbackMinutes: 30 })).status).toBeGreaterThanOrEqual(500);
    expect(call().raw_latest_payload).not.toHaveProperty("outcomeMutationId");
    const retry = await save({ mutationId, outcome: "callback", note: null, callbackMinutes: 30 });
    expect(await retry.json()).toMatchObject({ replayed: false });
    expect(call().raw_latest_payload).toMatchObject({ outcomeMutationId: mutationId, outcomeActorId: profileId });
    expect(f.db.rows("motorist_case_tasks")).toHaveLength(1);
    expect(f.db.rows("motorist_audit_log")).toEqual([expect.objectContaining({ action: "call.outcome" })]);
  });
  it("drops the mobile marker when the web overwrites the outcome", async () => {
    await save({ mutationId, outcome: "reached", note: null, callbackMinutes: null });
    const { recordCallOutcome } = await import("@/server/telephony-workflow");
    await recordCallOutcome(callId, { outcome: "not_reached" });
    expect(call().raw_latest_payload).toMatchObject({ outcome: "not_reached" });
    expect(call().raw_latest_payload).not.toHaveProperty("outcomeMutationId");
    expect(call().raw_latest_payload).not.toHaveProperty("outcomeActorId");
  });
  it("does not offer queue scheduling for a number the queue cannot ring", async () => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    f.db.update("motorist_calls", { caller_number: "158" }, row => row.id === callId);
    expect((await (await read()).json()).callbackScheduling).toBe("unavailable");
    const response = await save({ mutationId, outcome: "callback", note: null, callbackMinutes: 30 });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "callback_scheduling_unavailable", error: expect.stringContaining("číslo") });
  });
  it("maps the queue's unknown-number refusal to a clear conflict", async () => {
    vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
    f.db.registerRpc("motorist_schedule_callback_v1", () => { throw Object.assign(new Error("callback number unknown"), { code: "P0001" }); });
    const response = await save({ mutationId, outcome: "callback", note: null, callbackMinutes: 30 });
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "callback_scheduling_unavailable" });
  });
  it("normalizes a stored outcome time", async () => {
    f.db.update("motorist_calls", { raw_latest_payload: { outcome: "reached", outcomeAt: "2026-10-18 09:05:00+00" } }, row => row.id === callId);
    expect((await (await read()).json()).outcome.at).toBe("2026-10-18T09:05:00.000Z");
  });
});

describe("mobile call case link", () => {
  it("links with the actor identity and repeats as a no-op", async () => {
    const response = await link({ caseId: caseA.toUpperCase(), expectedCaseId: null }); expect(response.status).toBe(200); privateResponse(response);
    expect(await response.json()).toMatchObject({ callId, caseId: caseA, changed: true });
    expect(call()).toMatchObject({ case_id: caseA, raw_latest_payload: { linkedCaseId: caseA, linkedBy: "mobile_app" } });
    expect(f.db.rows("motorist_case_events")).toEqual([expect.objectContaining({ case_id: caseA, actor_profile_id: profileId, event_type: "call_linked" })]);
    expect(f.db.rows("motorist_audit_log")).toEqual([expect.objectContaining({ action: "call.link_case", actor_profile_id: profileId, source: "mobile_app" })]);
    expect(await (await link({ caseId: caseA, expectedCaseId: null })).json()).toMatchObject({ changed: false });
    expect(f.db.rows("motorist_case_events")).toHaveLength(1);
  });
  it("moves a link only from the link the dispatcher saw", async () => {
    f.db.update("motorist_calls", { case_id: caseB }, row => row.id === callId);
    const stale = await link({ caseId: caseA, expectedCaseId: null });
    expect(stale.status).toBe(409); expect((await stale.json()).error).toContain("kolega");
    expect(call().case_id).toBe(caseB);
    expect((await link({ caseId: caseA, expectedCaseId: caseB })).status).toBe(200); expect(call().case_id).toBe(caseA);
  });
  it("refuses an unknown or foreign case", async () => {
    f.db.seed("motorist_cases", [{ id: "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc", organization_id: foreignOrg, case_number: "X", status: "new" }]);
    expect((await link({ caseId: "bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc", expectedCaseId: null })).status).toBe(404);
    expect(call().case_id).toBeNull();
  });
  it.each(["malformed", { caseId: caseA }, { caseId: "x", expectedCaseId: null }, { caseId: caseA, expectedCaseId: "x" }, { caseId: caseA, expectedCaseId: null, profileId }])("rejects invalid link input %#", async body => {
    expect((await link(typeof body === "string" ? body : JSON.stringify(body))).status).toBe(400); expect(call().case_id).toBeNull();
  });
});
