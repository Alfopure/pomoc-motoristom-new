import { beforeEach, describe, expect, it, vi } from "vitest";
import { MutationError } from "@/server/mutation-error";
const mocks = vi.hoisted(() => ({ actor: vi.fn(), origin: vi.fn(), rpc: vi.fn() }));
vi.mock("@/server/api-auth", () => ({ requireDefaultMotoristActor: mocks.actor, assertSameOriginRequest: mocks.origin }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ rpc: mocks.rpc }) }));
import { GET, POST } from "./route";
import { GET as read, PATCH, DELETE } from "./[id]/route";
import { GET as colleagues } from "./colleagues/route";
const id = "00000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id }) };
const request = (method: string, body: unknown = { title: "Secret", body: "Private", expectedRevision: 1 }) => new Request("https://example.test/api/notes", { method, body: JSON.stringify(body) });
const handlers = { list: () => GET(), read: () => read(new Request("https://example.test"), context), colleagues: () => colleagues(), create: () => POST(request("POST")), save: () => PATCH(request("PATCH"), context), delete: () => DELETE(request("DELETE"), context) };
beforeEach(() => { Object.values(mocks).forEach(mock => mock.mockReset()); mocks.actor.mockResolvedValue({ profileId: "actor", organizationId: "org" }); mocks.rpc.mockResolvedValue({ data: [], error: null }); });
describe("notebook API", () => {
  it.each(Object.entries(handlers))("%s requires an authenticated actor before any RPC", async (_name, handler) => {
    mocks.actor.mockRejectedValue(new MutationError("Denied", 401)); const result = await handler();
    expect(result.status).toBe(401); expect(result.headers.get("cache-control")).toBe("private, no-store"); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(["create", "save", "delete"] as const)("%s checks origin before resolving actor", async name => {
    mocks.origin.mockImplementation(() => { throw new MutationError("Denied", 403); }); expect((await handlers[name]()).status).toBe(403); expect(mocks.actor).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(Object.entries(handlers))("%s forwards actor scope to the DB without dispatch snapshot data", async (_name, handler) => {
    const result = await handler(); expect(result.status).toBeLessThan(300); expect(result.headers.get("cache-control")).toBe("private, no-store"); expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_actor_profile_id: "actor", p_organization_id: "org" }); expect(await result.text()).not.toContain("dispatchData");
  });
  it("rejects malformed bodies without an RPC", async () => {
    expect((await POST(new Request("https://example.test", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await PATCH(request("PATCH", { title: "x", body: "y" }), context)).status).toBe(400); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(["PT409", "40001"])("preserves immediate read revocation and %s revision conflicts", async code => {
    mocks.rpc.mockResolvedValueOnce({ error: { code: "P0002", message: "private" } }).mockResolvedValueOnce({ error: { code, message: "private" } });
    expect((await handlers.read()).status).toBe(404); expect((await handlers.save()).status).toBe(409);
  });
});
