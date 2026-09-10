import { beforeEach, describe, expect, it, vi } from "vitest";
import { MutationError } from "@/server/mutation-error";
const mocks = vi.hoisted(() => ({ actor: vi.fn(), origin: vi.fn(), rpc: vi.fn() }));
vi.mock("@/server/api-auth", () => ({ requireDefaultMotoristActor: mocks.actor, assertSameOriginRequest: mocks.origin }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ rpc: mocks.rpc }) }));
import { GET, POST } from "./route";
import { GET as get, PATCH, DELETE } from "./[id]/route";
import { POST as link, DELETE as unlink } from "./[id]/links/route";
import { GET as messages, POST as send } from "./[id]/messages/route";
const id = "00000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id }) };
const request = (method: string, body: unknown = { title: "Title", expectedRevision: 1, caseId: id, clientMessageId: id, body: "Chat" }) => new Request("https://example.test/api/tasks", { method, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
const handlers = { list: () => GET(), get: () => get(request("GET"), context), create: () => POST(request("POST")), update: () => PATCH(request("PATCH"), context), delete: () => DELETE(request("DELETE"), context), link: () => link(request("POST"), context), unlink: () => unlink(request("DELETE"), context), messages: () => messages(request("GET"), context), send: () => send(request("POST"), context) };
beforeEach(() => { Object.values(mocks).forEach(mock => mock.mockReset()); mocks.actor.mockResolvedValue({ profileId: "actor", organizationId: "org" }); mocks.rpc.mockResolvedValue({ data: [], error: null }); });
describe("task-first API authorization", () => {
  it.each(Object.entries(handlers))("%s requires auth before data access", async (_name, handler) => {
    mocks.actor.mockRejectedValue(new MutationError("Denied", 401)); const response = await handler();
    expect(response.status).toBe(401); expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(["create", "update", "delete", "link", "unlink", "send"] as const)("%s checks origin before auth or mutation", async name => {
    mocks.origin.mockImplementation(() => { throw new MutationError("Denied", 403); }); expect((await handlers[name]()).status).toBe(403); expect(mocks.actor).not.toHaveBeenCalled(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(Object.entries(handlers))("%s passes real actor and org and returns uncached DTO", async (_name, handler) => {
    const response = await handler(); expect(response.status).toBeLessThan(300); expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_actor_profile_id: "actor", p_organization_id: "org" });
  });
  it("refuses malformed bodies and missing revision before any side effects", async () => {
    expect((await POST(new Request("https://example.test", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await PATCH(request("PATCH", { title: "Changed" }), context)).status).toBe(400); expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
