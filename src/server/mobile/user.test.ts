import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ actor: vi.fn(), client: vi.fn(), fetch: vi.fn() }));
vi.mock("./auth", () => ({ requireMobileActor: mocks.actor }));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.client }));
import { requireMobileUser } from "./user";

const actor = { organizationId: "33333333-3333-4333-8333-333333333333", profileId: "22222222-2222-4222-8222-222222222222", userId: "11111111-1111-4111-8111-111111111111", displayName: "Dispečer", role: "dispatcher" };
const token = "verified.user.signature";
function request(signal?: AbortSignal) {
  return new Request("https://test.dispecing.linkapomoci.sk/api/mobile/v1/tasks", { headers: { authorization: "Bearer " + token }, signal });
}
beforeEach(() => {
  vi.resetAllMocks(); vi.unstubAllEnvs();
  vi.stubEnv("SUPABASE_URL", "https://nzpnqdstvkfncflgqlny.supabase.co");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_fixture");
  vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_must_not_be_used");
  mocks.actor.mockResolvedValue(actor); mocks.client.mockReturnValue({ fixture: "user" });
  mocks.fetch.mockResolvedValue(new Response("{}")); vi.stubGlobal("fetch", mocks.fetch);
});

describe("verified mobile user database client", () => {
  it("authenticates before constructing a public-key client with the exact verified bearer", async () => {
    const result = await requireMobileUser(request());
    expect(result).toEqual({ actor, client: { fixture: "user" } });
    expect(mocks.actor.mock.invocationCallOrder[0]).toBeLessThan(mocks.client.mock.invocationCallOrder[0]);
    const [url, key, options] = mocks.client.mock.calls[0];
    expect(url).toBe("https://nzpnqdstvkfncflgqlny.supabase.co"); expect(key).toBe("sb_publishable_fixture");
    expect(options.auth).toEqual({ persistSession: false, autoRefreshToken: false, detectSessionInUrl: false });
    expect(options.global.headers).toEqual({ Authorization: "Bearer " + token });
  });
  it.each([401, 403, 409, 503])("never constructs a user/RPC client when actor verification fails with %s", async status => {
    mocks.actor.mockRejectedValue({ status });
    await expect(requireMobileUser(request())).rejects.toMatchObject({ status });
    expect(mocks.client).not.toHaveBeenCalled();
  });
  it("bounds each downstream request and respects request and query cancellation", async () => {
    const outer = new AbortController(), query = new AbortController();
    await requireMobileUser(request(outer.signal));
    const downstream = mocks.client.mock.calls[0][2].global.fetch;
    await downstream("https://nzpnqdstvkfncflgqlny.supabase.co/rest/v1/rpc/task", { method: "POST", signal: query.signal });
    const signal = mocks.fetch.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(false); query.abort(); expect(signal.aborted).toBe(true);
    await downstream("https://nzpnqdstvkfncflgqlny.supabase.co/rest/v1/tasks");
    const next = mocks.fetch.mock.calls[1][1].signal as AbortSignal;
    outer.abort(); expect(next.aborted).toBe(true);
  });
  it("the installed Supabase SDK sends the exact user Authorization and public API key to RPC", async () => {
    const sdk = await vi.importActual<typeof import("@supabase/supabase-js")>("@supabase/supabase-js");
    mocks.client.mockImplementation(sdk.createClient);
    mocks.fetch.mockResolvedValue(new Response("true", { headers: { "content-type": "application/json" } }));
    const { client } = await requireMobileUser(request());
    const result = await client.rpc("motorist_task_workflow_enabled", { p_organization_id: actor.organizationId, p_actor_profile_id: actor.profileId });
    expect(result).toMatchObject({ data: true, error: null });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.fetch.mock.calls[0];
    expect(String(url)).toBe("https://nzpnqdstvkfncflgqlny.supabase.co/rest/v1/rpc/motorist_task_workflow_enabled");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer " + token);
    expect(headers.get("apikey")).toBe("sb_publishable_fixture");
    expect(headers.get("Cookie")).toBeNull();
    expect(JSON.parse(init.body)).toEqual({ p_organization_id: actor.organizationId, p_actor_profile_id: actor.profileId });
  });
  it("keeps the default unbounded response transport unchanged for existing clients", async () => {
    const response = new Response("true"); mocks.fetch.mockResolvedValue(response);
    await requireMobileUser(request());
    const transport = mocks.client.mock.calls[0][2].global.fetch;
    expect(await transport("https://nzpnqdstvkfncflgqlny.supabase.co/rest/v1/rpc/task")).toBe(response);
    expect(response.bodyUsed).toBe(false);
  });
  it("accepts the exact decoded UTF8 byte bound through the installed RPC client", async () => {
    const sdk = await vi.importActual<typeof import("@supabase/supabase-js")>("@supabase/supabase-js");
    mocks.client.mockImplementation(sdk.createClient);
    const data = { fixture: "é 🚗" }, body = JSON.stringify(data);
    mocks.fetch.mockResolvedValue(new Response(body, { headers: { "content-type": "application/json" } }));
    const { client } = await requireMobileUser(request(), { maxResponseBytes: Buffer.byteLength(body) });
    const result = await client.rpc("motorist_case_handoff", { p_organization_id: actor.organizationId, p_actor_id: actor.profileId,
      p_case_id: "44444444-4444-4444-8444-444444444444", p_action: "context", p_input: {} });
    expect(result).toMatchObject({ data, error: null, status: 200 });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(new Headers(mocks.fetch.mock.calls[0][1].headers).get("Authorization")).toBe("Bearer " + token);
  });
  it.each(["declared", "streamed", "misleading compressed length"])("bounds %s oversized RPC responses without parsing or repeating a possibly committed POST", async mode => {
    const sdk = await vi.importActual<typeof import("@supabase/supabase-js")>("@supabase/supabase-js");
    mocks.client.mockImplementation(sdk.createClient);
    const cancelled = vi.fn();
    const bytes = new TextEncoder().encode(JSON.stringify({ private: "PRIVATE_CUSTOMER_DATA_".repeat(20) }));
    let part = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (part === 0) controller.enqueue(bytes.subarray(0, 70));
      else if (part === 1) controller.enqueue(bytes.subarray(70));
      else controller.close();
      part++;
    }, cancel: cancelled }, { highWaterMark: 0 });
    const headers = { "content-type": "application/json", ...(mode === "declared" ? { "content-length": String(bytes.byteLength) }
      : mode === "misleading compressed length" ? { "content-length": "1", "content-encoding": "gzip" } : {}) };
    mocks.fetch.mockResolvedValue(new Response(body, { headers }));
    const { client } = await requireMobileUser(request(), { maxResponseBytes: 100 });
    const result = await client.rpc("motorist_case_handoff", { p_organization_id: actor.organizationId, p_actor_id: actor.profileId,
      p_case_id: "44444444-4444-4444-8444-444444444444", p_action: "issue", p_input: { commandId: "55555555-5555-4555-8555-555555555555" } });
    expect(result).toMatchObject({ data: null, status: 503, error: { code: "MOBILE_RESPONSE_TOO_LARGE" } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_CUSTOMER_DATA");
    expect(mocks.fetch).toHaveBeenCalledTimes(1); expect(mocks.fetch.mock.calls[0][1].method).toBe("POST");
    expect(cancelled).toHaveBeenCalledOnce();
  });
  it("preserves the size rejection when cancelling an oversized response itself fails", async () => {
    await requireMobileUser(request(), { maxResponseBytes: 1 });
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("too large")); }, cancel() { throw new Error("cancel failed"); } });
    mocks.fetch.mockResolvedValue(new Response(body));
    const transport = mocks.client.mock.calls[0][2].global.fetch;
    const result = await transport("https://nzpnqdstvkfncflgqlny.supabase.co/rest/v1/rpc/task");
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ code: "MOBILE_RESPONSE_TOO_LARGE" });
  });
});
