import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
import { registerCallbackQueueRpc } from "@/test/fake-callback-queue";
import * as list from "@/app/api/mobile/v1/callbacks/route";
import * as summary from "@/app/api/mobile/v1/callbacks/summary/route";
import * as claim from "@/app/api/mobile/v1/callbacks/[id]/claim/route";
import * as resolve from "@/app/api/mobile/v1/callbacks/[id]/resolve/route";
import * as target from "@/app/api/mobile/v1/calls/target/route";
import { ROUTE_AUTH_REGISTRY } from "@/server/route-auth-registry";

const mocks = vi.hoisted(() => ({ claims: vi.fn(), admin: vi.fn(), organization: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getClaims: mocks.claims } }) }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("@/server/default-organization", () => ({ resolveDefaultOrganizationId: mocks.organization }));

const userId = "11111111-1111-4111-8111-111111111111", profileId = "22222222-2222-4222-8222-222222222222";
const organizationId = "33333333-3333-4333-8333-333333333333", colleagueId = "44444444-4444-4444-8444-444444444444";
const otherOrganization = "55555555-5555-4555-8555-555555555555", sessionId = "66666666-6666-4666-8666-666666666666";
const ids = { requested: "a1111111-1111-4111-8111-111111111111", missed: "a2222222-2222-4222-8222-222222222222", claimed: "a3333333-3333-4333-8333-333333333333",
  hidden: "a4444444-4444-4444-8444-444444444444", done: "a5555555-5555-4555-8555-555555555555", foreign: "a6666666-6666-4666-8666-666666666666" };
const lineId = "77777777-7777-4777-8777-777777777777", caseId = "88888888-8888-4888-8888-888888888888";
const verificationId = "99999999-9999-4999-8999-999999999999";
const issuer = "https://nzpnqdstvkfncflgqlny.supabase.co/auth/v1";
const claimsBody = () => ({ sub: userId, iss: issuer, aud: "authenticated", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });
const token = Buffer.from(JSON.stringify({ alg: "ES256" })).toString("base64url") + "." + Buffer.from(JSON.stringify(claimsBody())).toString("base64url") + ".c2lnbmF0dXJl";
let f: ReturnType<typeof createFakeSupabase>;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function request(path: string, method: "GET" | "POST" = "GET", headers: Record<string, string> = {}, body?: unknown) {
  return new Request("https://test.dispecing.linkapomoci.sk/api/mobile/v1/" + path, {
    method, headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": "test", "X-PM-Expected-Organization": organizationId,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
function privateResponse(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("Vary")).toBe("Authorization, X-PM-App-Environment");
  expect(response.headers.get("Set-Cookie")).toBeNull();
}
function seedQueue() {
  f.db.seed("motorist_telephony_lines", [{ id: lineId, organization_id: organizationId, label: "Allianz asistencia", partner_name: "Allianz", active: true }]);
  f.db.seed("motorist_call_sessions", [{ id: sessionId, organization_id: organizationId, metadata: { secret_provider: "PRIVATE", callback: { confirmed: true, requested_at: minutesAgo(5), digit: "1", context: "waiting_room" } } }]);
  f.db.seed("motorist_callback_requests", [
    { id: ids.missed, organization_id: organizationId, caller_number: "+421905111222", caller_name: "Ján Novák", source: "missed", status: "open",
      line_id: lineId, case_id: caseId, created_at: minutesAgo(40), due_at: minutesAgo(10), metadata: { provider_secret: "PRIVATE" } },
    { id: ids.requested, organization_id: organizationId, caller_number: "+421905333444", caller_name: null, source: "ivr", status: "open",
      session_id: sessionId, created_at: minutesAgo(6), due_at: new Date(Date.now() + 24 * 60_000).toISOString(), metadata: {} },
    { id: ids.claimed, organization_id: organizationId, caller_number: "anonymous", source: "missed", status: "scheduled",
      claimed_by: colleagueId, claimed_at: minutesAgo(3), created_at: minutesAgo(50), due_at: null, metadata: {} },
    { id: ids.done, organization_id: organizationId, caller_number: "+421905555666", source: "missed", status: "done",
      claimed_by: profileId, created_at: minutesAgo(90), resolved_at: minutesAgo(30), notes: "Dovolané, odťah objednaný", metadata: {} },
    { id: ids.foreign, organization_id: otherOrganization, caller_number: "+421905777888", source: "missed", status: "open", created_at: minutesAgo(5), metadata: {} },
  ]);
}

beforeEach(() => {
  vi.resetAllMocks();
  for (const [key, value] of Object.entries({ MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
    VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk", APP_BASE_URL: "https://test.dispecing.linkapomoci.sk",
    SUPABASE_URL: issuer.replace("/auth/v1", ""), SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture", TELEPHONY_STABILITY_V1_ENABLED: "false" })) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network IO"); }));
  mocks.claims.mockResolvedValue({ data: { claims: claimsBody() }, error: null }); mocks.organization.mockResolvedValue(organizationId);
  f = createFakeSupabase();
  registerCallbackQueueRpc(f.db);
  f.db.seed("motorist_profiles", [
    { id: profileId, user_id: userId, organization_id: organizationId, display_name: "Mobilná dispečerka", role: "dispatcher", active: true, access_status: "active", kind: "human" },
    { id: colleagueId, user_id: colleagueId, organization_id: organizationId, display_name: "Peter Kolega", role: "dispatcher", active: true, access_status: "active", kind: "human" },
  ]);
  mocks.admin.mockReturnValue(f.client);
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const invocations: [string, () => Promise<Response>, (headers: Record<string, string>) => Request][] = [
  ["list", () => list.GET(request("callbacks")), headers => request("callbacks", "GET", headers)],
  ["summary", () => summary.GET(request("callbacks/summary")), headers => request("callbacks/summary", "GET", headers)],
  ["claim", () => claim.POST(request("callbacks/" + ids.missed + "/claim", "POST"), params(ids.missed)), headers => request("callbacks/" + ids.missed + "/claim", "POST", headers)],
  ["resolve", () => resolve.POST(request("callbacks/" + ids.missed + "/resolve", "POST", {}, { status: "done", notes: null }), params(ids.missed)), headers => request("callbacks/" + ids.missed + "/resolve", "POST", headers, { status: "done" })],
  ["target", () => target.GET(request("calls/target?number=%2B421905111222")), headers => request("calls/target?number=%2B421905111222", "GET", headers)],
];
async function call(name: string, req: Request): Promise<Response> {
  if (name === "list") return list.GET(req);
  if (name === "summary") return summary.GET(req);
  if (name === "claim") return claim.POST(req, params(ids.missed));
  if (name === "resolve") return resolve.POST(req, params(ids.missed));
  return target.GET(req);
}

describe.each(invocations)("mobile callback route authorization: %s", (name, _invoke, build) => {
  it.each(["", "Bearer invalid"])("authenticates before reading data or cookies: %s", async authorization => {
    const response = await call(name, build({ authorization, Cookie: "session=pretend" }));
    expect(response.status).toBe(401); privateResponse(response); expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it.each<Record<string, string>>([{ "X-PM-App-Environment": "production" }, { "X-PM-Expected-Organization": otherOrganization }])("rejects a wrong verified scope %j", async headers => {
    seedQueue();
    const response = await call(name, build(headers)); expect(response.status).toBe(409); privateResponse(response);
    expect(f.db.find("motorist_callback_requests", row => row.id === ids.missed)?.status).toBe("open");
  });
  it.each([{ active: false }, { kind: "ai" }, { role: "driver" }, { access_status: "suspended" }])("rejects unavailable actor %j", async patch => {
    seedQueue();
    f.db.update("motorist_profiles", patch, row => row.id === profileId);
    const response = await call(name, build({})); expect(response.status).toBe(403); privateResponse(response);
  });
});

describe("mobile callback queue", () => {
  it("projects the organization's priority queue without provider or session metadata", async () => {
    seedQueue();
    const response = await list.GET(request("callbacks")); expect(response.status).toBe(200); privateResponse(response);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, apiVersion: 1, environment: "test", profileId, organizationId, nextCursor: null, resetPage: false,
      counts: { open: 3, requested: 1, missed: 2, manual: 0, unknown: 0 } });
    // Confirmed caller requests first, then unresolved calls oldest first.
    expect(body.open.map((item: { id: string }) => item.id)).toEqual([ids.requested, ids.claimed, ids.missed]);
    expect(body.open[0]).toMatchObject({ origin: "requested", sourceLabel: "Voľba v menu", originDetail: expect.stringContaining("Volajúci stlačil 1 · počas čakania"),
      claimant: null, actions: { claim: true, takeover: false, call: true, resolve: true, blockedReason: null } });
    expect(body.open[2]).toEqual({ id: ids.missed, number: "+421905111222", name: "Ján Novák", status: "open", origin: "missed", originDetail: null,
      sourceLabel: "Zmeškaný hovor", lineLabel: "Allianz asistencia", partnerName: "Allianz", caseId, claimant: null, claimedAt: null,
      deadlineAt: expect.any(String), createdAt: expect.any(String), resolvedAt: null, notes: null, lastCalledAt: null,
      actions: { claim: true, takeover: false, call: true, resolve: true, blockedReason: null } });
    expect(body.open[1]).toMatchObject({ number: null, claimant: { id: colleagueId, name: "Peter Kolega", mine: false },
      actions: { claim: false, takeover: false, call: false, resolve: false, blockedReason: "Požiadavku má prevzatú Peter Kolega." } });
    expect(Date.parse(body.open[1].deadlineAt)).toBe(Date.parse(f.db.find("motorist_callback_requests", row => row.id === ids.claimed)!.created_at as string) + 30 * 60_000);
    expect(body.resolved).toEqual([expect.objectContaining({ id: ids.done, status: "done", notes: "Dovolané, odťah objednaný", deadlineAt: null,
      claimant: { id: profileId, name: "Mobilná dispečerka", mine: true }, actions: { claim: false, takeover: false, call: false, resolve: false, blockedReason: "Požiadavka je už uzavretá." } })]);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("PRIVATE"); expect(raw).not.toContain(ids.foreign); expect(raw).not.toContain(sessionId);
  });
  it("lets senior roles take over a colleague's claim", async () => {
    seedQueue(); f.db.update("motorist_profiles", { role: "senior_dispatcher" }, row => row.id === profileId);
    const body = await (await list.GET(request("callbacks"))).json();
    expect(body.open[1].actions).toEqual({ claim: true, takeover: true, call: false, resolve: true, blockedReason: null });
  });
  it("requires an expected organization and rejects query overrides", async () => {
    seedQueue();
    const missing = await list.GET(request("callbacks", "GET", { "X-PM-Expected-Organization": "" }));
    expect(missing.status).toBe(400);
    const withoutHeader = new Request("https://test.dispecing.linkapomoci.sk/api/mobile/v1/callbacks", { headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": "test" } });
    expect((await list.GET(withoutHeader)).status).toBe(409);
    for (const query of ["?profileId=" + colleagueId, "?cursor=a&cursor=b", "?cursor=" + "a".repeat(513), "?cursor=bad%20cursor", "?cursor=bm90LWpzb24"]) {
      const response = await list.GET(request("callbacks" + query)); expect(response.status).toBe(400); privateResponse(response);
    }
  });
  it("hides database failure details", async () => {
    seedQueue(); f.db.failNext("motorist_callback_requests", "select", "PRIVATE_DB_DETAIL");
    const response = await list.GET(request("callbacks")); expect(response.status).toBeGreaterThanOrEqual(500); privateResponse(response);
    expect(await response.json()).toEqual({ ok: false, error: "Spätné volania sa nepodarilo načítať." });
  });
  it("counts open, own, unclaimed and overdue requests exactly", async () => {
    seedQueue();
    f.db.seed("motorist_callback_requests", [{ id: ids.hidden, organization_id: organizationId, caller_number: "+421905999000", source: "manual", status: "scheduled",
      claimed_by: profileId, created_at: minutesAgo(2), due_at: null, metadata: {} }]);
    // Console counters do not need draft organization fencing, but a supplied fence is still verified.
    expect((await summary.GET(request("callbacks/summary", "GET", { "X-PM-Expected-Organization": "" }))).status).toBe(400);
    const plain = await summary.GET(new Request("https://test.dispecing.linkapomoci.sk/api/mobile/v1/callbacks/summary", { headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": "test" } }));
    expect(plain.status).toBe(200); privateResponse(plain);
    expect(await plain.json()).toEqual({ ok: true, apiVersion: 1, environment: "test", profileId, checkedAt: expect.any(String),
      counts: { open: 4, requested: 1, missed: 2, manual: 1, unknown: 0, mine: 1, unclaimed: 2, overdue: 2 } });
    expect((await summary.GET(request("callbacks/summary?mine=1"))).status).toBe(400);
  });
});

describe("mobile callback queue consistency between independent reads", () => {
  it("never lists one request as both open and recently settled", async () => {
    seedQueue();
    f.db.registerRpc("motorist_callback_queue_page_v1", () => {
      const row = f.db.find("motorist_callback_requests", item => item.id === ids.done)!;
      return { entries: [{ request: row, sessionMetadata: null, rank: 1, sortAt: new Date().toISOString() }], revision: "a".repeat(32), reset: false, openTotal: 1,
        totalsByOrigin: { requested: 0, missed: 1, manual: 0, unknown: 0 } };
    });
    const body = await (await list.GET(request("callbacks"))).json();
    expect(body.open.map((item: { id: string }) => item.id)).toEqual([ids.done]); expect(body.resolved).toEqual([]);
  });
  it("bounds subset counters by the open total read separately", async () => {
    seedQueue();
    f.db.registerRpc("motorist_callback_queue_page_v1", () => ({ entries: [], revision: "a".repeat(32), reset: false, openTotal: 1, totalsByOrigin: { requested: 0, missed: 1, manual: 0, unknown: 0 } }));
    const plain = new Request("https://test.dispecing.linkapomoci.sk/api/mobile/v1/callbacks/summary", { headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": "test" } });
    expect((await (await summary.GET(plain)).json()).counts).toEqual({ open: 1, requested: 0, missed: 1, manual: 0, unknown: 0, mine: 0, unclaimed: 1, overdue: 1 });
  });
});

describe("mobile callback actions", () => {
  it("claims a free request once and repeats idempotently for the same dispatcher", async () => {
    seedQueue();
    const response = await claim.POST(request("callbacks/" + ids.missed.toUpperCase() + "/claim", "POST"), params(ids.missed.toUpperCase()));
    expect(response.status).toBe(200); privateResponse(response);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, organizationId, request: { id: ids.missed, status: "scheduled", claimant: { id: profileId, mine: true }, actions: { claim: false, resolve: true } } });
    expect(f.db.find("motorist_callback_requests", row => row.id === ids.missed)).toMatchObject({ status: "scheduled", claimed_by: profileId });
    expect(f.db.rows("motorist_audit_log")).toEqual([expect.objectContaining({ action: "telephony.callback.claim", actor_profile_id: profileId, entity_id: ids.missed })]);
    expect((await claim.POST(request("callbacks/" + ids.missed + "/claim", "POST"), params(ids.missed))).status).toBe(200);
    expect(f.db.rows("motorist_audit_log")).toHaveLength(1);
  });
  it("refuses a colleague's claim for a dispatcher and permits a senior takeover", async () => {
    seedQueue();
    const refused = await claim.POST(request("callbacks/" + ids.claimed + "/claim", "POST"), params(ids.claimed));
    expect(refused.status).toBe(409); expect(await refused.json()).toMatchObject({ ok: false, error: "Požiadavku má prevzatú Peter Kolega.", code: "already_claimed" });
    f.db.update("motorist_profiles", { role: "senior_dispatcher" }, row => row.id === profileId);
    const taken = await claim.POST(request("callbacks/" + ids.claimed + "/claim", "POST"), params(ids.claimed));
    expect(taken.status).toBe(200); expect(f.db.find("motorist_callback_requests", row => row.id === ids.claimed)?.claimed_by).toBe(profileId);
  });
  it("does not act on closed, foreign or malformed requests", async () => {
    seedQueue();
    expect((await claim.POST(request("callbacks/" + ids.done + "/claim", "POST"), params(ids.done))).status).toBe(409);
    expect((await claim.POST(request("callbacks/" + ids.foreign + "/claim", "POST"), params(ids.foreign))).status).toBe(404);
    expect((await claim.POST(request("callbacks/not-a-uuid/claim", "POST"), params("not-a-uuid"))).status).toBe(404);
    expect(f.db.find("motorist_callback_requests", row => row.id === ids.foreign)?.status).toBe("open");
  });
  it("resolves with a bounded note and closes the linked callback task", async () => {
    seedQueue();
    f.db.seed("motorist_case_tasks", [{ id: "task", organization_id: organizationId, case_id: caseId, kind: "callback", status: "open" }]);
    const response = await resolve.POST(request("callbacks/" + ids.missed + "/resolve", "POST", {}, { status: "done", notes: "  Zákazník dovolaný  " }), params(ids.missed));
    expect(response.status).toBe(200); privateResponse(response);
    expect((await response.json()).request).toMatchObject({ id: ids.missed, status: "done", notes: "Zákazník dovolaný", deadlineAt: null, actions: { resolve: false } });
    expect(f.db.find("motorist_callback_requests", row => row.id === ids.missed)).toMatchObject({ status: "done", notes: "Zákazník dovolaný", claimed_by: profileId });
    expect(f.db.find("motorist_case_tasks", row => row.id === "task")).toMatchObject({ status: "done", completed_by: profileId });
    const again = await resolve.POST(request("callbacks/" + ids.missed + "/resolve", "POST", {}, { status: "cancelled" }), params(ids.missed));
    expect(again.status).toBe(409); expect(await again.json()).toMatchObject({ code: "already_resolved" });
  });
  it("cancels without a note and respects a colleague's claim", async () => {
    seedQueue();
    const refused = await resolve.POST(request("callbacks/" + ids.claimed + "/resolve", "POST", {}, { status: "cancelled", notes: null }), params(ids.claimed));
    expect(refused.status).toBe(409);
    const cancelled = await resolve.POST(request("callbacks/" + ids.requested + "/resolve", "POST", {}, { status: "cancelled" }), params(ids.requested));
    expect(cancelled.status).toBe(200); expect((await cancelled.json()).request).toMatchObject({ status: "cancelled", notes: null });
  });
  it.each([
    "malformed", "[]", JSON.stringify({ status: "reopen" }), JSON.stringify({ status: "done", notes: 4 }), JSON.stringify({ status: "done", profileId }),
    JSON.stringify({ status: "done", notes: "x".repeat(501) }), JSON.stringify({ status: "done", notes: "a\u0000b" }), " ".repeat(64_001),
  ])("rejects invalid resolution input before writing: %s", async body => {
    seedQueue();
    const response = await resolve.POST(request("callbacks/" + ids.missed + "/resolve", "POST", {}, body), params(ids.missed));
    expect(response.status).toBe(400); privateResponse(response);
    expect(f.db.find("motorist_callback_requests", row => row.id === ids.missed)?.status).toBe("open");
  });
  it("requires JSON for resolution and an organization fence for both writes", async () => {
    seedQueue();
    const text = new Request("https://test.dispecing.linkapomoci.sk/api/mobile/v1/callbacks/x/resolve", { method: "POST",
      headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": "test", "X-PM-Expected-Organization": organizationId, "Content-Type": "text/plain" }, body: "{\"status\":\"done\"}" });
    expect((await resolve.POST(text, params(ids.missed))).status).toBe(400);
    for (const [invoke, body] of [[claim.POST, undefined], [resolve.POST, JSON.stringify({ status: "done" })]] as const) {
      const unfenced = new Request("https://test.dispecing.linkapomoci.sk/api/mobile/v1/callbacks/x", { method: "POST",
        headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": "test", "Content-Type": "application/json" }, ...(body ? { body } : {}) });
      expect((await invoke(unfenced, params(ids.missed))).status).toBe(409);
    }
    expect(f.db.find("motorist_callback_requests", row => row.id === ids.missed)?.status).toBe("open");
  });
});

describe("mobile dial target confirmation", () => {
  it.each([
    [{ originalNumber: "+421905111222", dialNumber: "+421905111222", status: "original", sourceContactId: null, sourceName: null, targetContactId: null, targetName: null, verificationId: null },
      { status: "original", originalNumber: "+421905111222", dialNumber: "+421905111222", sourceName: null, targetName: null, verificationId: null }],
    [{ originalNumber: "+421232408700", dialNumber: "+421905444555", status: "verified_alternative", sourceContactId: "c1", sourceName: "Recepcia", targetContactId: "c2", targetName: "Ján Novák", verificationId },
      { status: "verified_alternative", originalNumber: "+421232408700", dialNumber: "+421905444555", sourceName: "Recepcia", targetName: "Ján Novák", verificationId }],
    [{ originalNumber: "+421232408700", dialNumber: null, status: "blocked", sourceContactId: "c1", sourceName: "Recepcia", targetContactId: null, targetName: null, verificationId: null },
      { status: "blocked", originalNumber: "+421232408700", dialNumber: null, sourceName: "Recepcia", targetName: null, verificationId: null }],
  ])("projects the directory decision %#", async (resolution, expected) => {
    f.db.registerRpc("motorist_resolve_callback_target", args => { expect(args).toEqual({ p_organization_id: organizationId, p_number: "+421905111222" }); return resolution; });
    const response = await target.GET(request("calls/target?number=%2B421905111222")); expect(response.status).toBe(200); privateResponse(response);
    const body = await response.json();
    expect(body).toEqual({ ok: true, apiVersion: 1, environment: "test", profileId, checkedAt: expect.any(String), target: expected });
    expect(JSON.stringify(body)).not.toContain("c1");
  });
  it("refuses an unusable alternative instead of offering a guessed number", async () => {
    f.db.registerRpc("motorist_resolve_callback_target", () => ({ originalNumber: "+421232408700", dialNumber: "+421905444555", status: "verified_alternative", verificationId: null }));
    const response = await target.GET(request("calls/target?number=%2B421232408700")); expect(response.status).toBe(409);
  });
  it.each(["", "?number=", "?number=a&number=b", "?number=%2B421&profileId=x", "?number=" + "1".repeat(101), "?number=%2B421%0A905"])("rejects invalid query %s", async query => {
    const response = await target.GET(request("calls/target" + query)); expect(response.status).toBe(400); privateResponse(response);
  });
  it("hides resolver failure details", async () => {
    f.db.registerRpc("motorist_resolve_callback_target", () => { throw Object.assign(new Error("PRIVATE"), { code: "XX000" }); });
    const response = await target.GET(request("calls/target?number=%2B421905111222")); expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("PRIVATE");
  });
});

describe("mobile callback route registry", () => {
  it("exports only the supported methods and registers bearer auth", () => {
    expect(Object.keys(list).sort()).toEqual(["GET", "runtime"]); expect(Object.keys(summary).sort()).toEqual(["GET", "runtime"]);
    expect(Object.keys(claim).sort()).toEqual(["POST", "runtime"]); expect(Object.keys(resolve).sort()).toEqual(["POST", "runtime"]);
    expect(Object.keys(target).sort()).toEqual(["GET", "runtime"]);
    for (const path of ["mobile/v1/callbacks", "mobile/v1/callbacks/summary", "mobile/v1/callbacks/[id]/claim", "mobile/v1/callbacks/[id]/resolve", "mobile/v1/calls/target", "mobile/v1/voice/calls/callback"]) {
      expect(ROUTE_AUTH_REGISTRY[path]).toMatchObject({ class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"] });
    }
  });
});
