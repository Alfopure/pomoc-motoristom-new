import { beforeEach, describe, expect, it, vi } from "vitest";
import { MutationError } from "@/server/mutation-error";
const mocks = vi.hoisted(() => ({ actor: vi.fn(), origin: vi.fn(), rpc: vi.fn() }));
vi.mock("@/server/api-auth", () => ({ requireDefaultMotoristActor: mocks.actor, assertSameOriginRequest: mocks.origin }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ rpc: mocks.rpc }) }));
import { POST } from "./route";
const id = "00000000-0000-4000-8000-000000000001";
const commandId = "00000000-0000-4000-8000-000000000002";
const context = { params: Promise.resolve({ id }) };
const body = { action: "start", commandId, expectedRevision: 1 };
const request = (input: unknown = body) => new Request("https://dispatch-copy.example/api/tasks/example/workflow", { method: "POST", body: JSON.stringify(input) });
beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.actor.mockResolvedValue({ profileId: "actor", organizationId: "org" });
  mocks.rpc.mockResolvedValue({ data: { task: { id, revision: 2, status: "open", workflowState: "in_progress", workflowVersion: 1 }, commandId, committedRevision: 2 }, error: null });
});
describe("task workflow route boundary", () => {
  it("checks origin before authentication and any command", async () => {
    mocks.origin.mockImplementation(() => { throw new MutationError("Origin denied", 403); });
    expect((await POST(request(), context)).status).toBe(403);
    expect(mocks.actor).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("requires an authorized real session before reading or changing a task", async () => {
    mocks.actor.mockRejectedValue(new MutationError("Sign in", 401));
    const response = await POST(request(), context);
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("returns an uncached canonical receipt and ignores claimed identity", async () => {
    const response = await POST(request({ ...body, actorProfileId: "forged", organizationId: "other" }), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(await response.json()).toMatchObject({ task: { id, revision: 2 }, commandId, committedRevision: 2 });
    expect(mocks.rpc).toHaveBeenCalledWith("motorist_task_workflow", { p_organization_id: "org", p_actor_profile_id: "actor", p_task_id: id, p_input: body });
  });
  it("rejects malformed body and a missing idempotency identity before RPC", async () => {
    expect((await POST(request({ action: "start", expectedRevision: 1 }), context)).status).toBe(400);
    expect((await POST(new Request("https://dispatch-copy.example", { method: "POST", body: "{" }), context)).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("preserves schema activation errors as unavailable without a fabricated success", async () => {
    mocks.rpc.mockResolvedValue({ error: { code: "PGRST202" } });
    const response = await POST(request(), context);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: expect.stringContaining("nie sú aktivované") });
  });
});
