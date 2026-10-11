import { beforeEach, describe, expect, it, vi } from "vitest";
import { MutationError } from "@/server/mutation-error";
const mocks = vi.hoisted(() => ({ user: vi.fn(), list: vi.fn(), detail: vi.fn(), colleagues: vi.fn(), create: vi.fn(), workflow: vi.fn(), messages: vi.fn(), send: vi.fn() }));
vi.mock("./user", () => ({ requireMobileUser: mocks.user }));
vi.mock("./tasks", async importOriginal => ({ ...await importOriginal<object>(),
  listMobileCaseTasks: mocks.list, getMobileTask: mocks.detail, listMobileTaskColleagues: mocks.colleagues,
  createMobileTask: mocks.create, transitionMobileTask: mocks.workflow, listMobileTaskMessages: mocks.messages, sendMobileTaskMessage: mocks.send,
}));
import { GET as list, POST as create } from "@/app/api/mobile/v1/cases/[id]/tasks/route";
import { GET as detail } from "@/app/api/mobile/v1/tasks/[id]/route";
import { GET as colleagues } from "@/app/api/mobile/v1/tasks/colleagues/route";
import { POST as workflow } from "@/app/api/mobile/v1/tasks/[id]/workflow/route";
import { GET as messages, POST as send } from "@/app/api/mobile/v1/tasks/[id]/messages/route";

const id = "55555555-5555-4555-8555-555555555555", commandId = "66666666-6666-4666-8666-666666666666";
const actor = { organizationId: "org", profileId: "actor", userId: "user", role: "dispatcher", displayName: "Dispečer" };
const client = { fixture: "verified-public-key-user-client" }, context = { params: Promise.resolve({ id }) };
const routes = [
  { name: "list", method: "GET", handler: list, body: undefined, spy: mocks.list },
  { name: "create", method: "POST", handler: create, body: { title: "Dokumenty" }, spy: mocks.create },
  { name: "detail", method: "GET", handler: detail, body: undefined, spy: mocks.detail },
  { name: "colleagues", method: "GET", handler: (request: Request) => colleagues(request), body: undefined, spy: mocks.colleagues },
  { name: "workflow", method: "POST", handler: workflow, body: { action: "start", commandId, expectedRevision: 4 }, spy: mocks.workflow },
  { name: "messages", method: "GET", handler: messages, body: undefined, spy: mocks.messages },
  { name: "send", method: "POST", handler: send, body: { body: "Správa", clientMessageId: commandId }, spy: mocks.send },
];
beforeEach(() => {
  vi.resetAllMocks(); vi.stubEnv("MOTORIST_APP_ENV", "test");
  mocks.user.mockResolvedValue({ actor, client });
  mocks.list.mockResolvedValue({ caseId: id, tasks: [], nextCursor: null, capabilities: { create: true, workflow: true, messages: true } });
  mocks.detail.mockResolvedValue({ task: { id }, linkedCases: [], capabilities: {} }); mocks.colleagues.mockResolvedValue([]);
  mocks.create.mockResolvedValue({ caseId: id, taskId: id, refreshRequired: true });
  mocks.workflow.mockResolvedValue({ taskId: id, commandId, committedRevision: 5, currentRevision: 5, refreshRequired: true });
  mocks.messages.mockResolvedValue({ taskId: id, messages: [], nextCursor: null }); mocks.send.mockResolvedValue({ taskId: id, message: {}, refreshRequired: true });
});
function request(method: string, body?: unknown) {
  return new Request("https://test.dispecing.linkapomoci.sk/api/mobile/v1/tasks/" + id, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
describe("mobile task HTTP boundaries", () => {
  it.each(routes)("authenticates $name before path/body/data and returns private denied response", async route => {
    mocks.user.mockRejectedValue(new MutationError("Prihláste sa.", 401));
    const result = await route.handler(request(route.method, route.body), context);
    expect(result.status).toBe(401); expect(result.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(result.headers.get("Cache-Control")).toBe("private, no-store"); expect(result.headers.get("Vary")).toContain("Authorization");
    expect(route.spy).not.toHaveBeenCalled();
  });
  it.each(routes)("passes exact actor and user client for $name and returns scoped response", async route => {
    const result = await route.handler(request(route.method, route.body), context);
    expect(result.status).toBe(route.name === "create" || route.name === "send" ? 201 : 200);
    expect(await result.json()).toMatchObject({ ok: true, apiVersion: 1, environment: "test", profileId: actor.profileId });
    expect(route.spy.mock.calls[0][0]).toBe(actor); expect(route.spy.mock.calls[0].at(-1)).toBe(client);
  });
  it.each(routes.filter(route => route.method === "POST"))("bounds/validates $name body before any operation", async route => {
    const malformed = new Request("https://test.dispecing.linkapomoci.sk/api/mobile/v1/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: "{\"title\":\"" + "x".repeat(64_000) });
    expect((await route.handler(malformed, context)).status).toBe(400); expect(route.spy).not.toHaveBeenCalled();
    expect((await route.handler(request("POST", { ...(route.body ?? {}), organizationId: "spoof" }), context)).status).toBe(400);
    expect(route.spy).not.toHaveBeenCalled();
  });
  it("does not disclose database failures or make a postcommit profile read necessary", async () => {
    mocks.create.mockRejectedValue(new Error("PRIVATE_DATABASE_FAILURE"));
    const result = await create(request("POST", { title: "Úloha" }), context);
    expect(result.status).toBe(503); expect(JSON.stringify(await result.json())).not.toContain("PRIVATE_DATABASE_FAILURE");
  });
});
