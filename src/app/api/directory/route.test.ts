import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MotoristActor } from "@/server/api-auth";
import { emptyDirectoryDraft, type DirectoryEntry } from "@/lib/directory";
import { MutationError } from "@/server/mutation-error";

const mocks = vi.hoisted(() => ({ actor: vi.fn(), sameOrigin: vi.fn(), load: vi.fn(), save: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/server/api-auth", () => ({ assertSameOriginRequest: mocks.sameOrigin, requireDefaultMotoristActor: mocks.actor }));
vi.mock("@/server/directory-service", async importOriginal => ({
  ...await importOriginal<typeof import("@/server/directory-service")>(),
  loadDirectory: mocks.load,
  saveDirectoryEntry: mocks.save,
}));
vi.mock("@/data/dispatch-repository", () => ({ loadDispatchData: mocks.dispatch }));

import { GET, POST } from "./route";
import { PATCH } from "./[kind]/[id]/route";

const actor: MotoristActor = { userId: "test-user", profileId: "test-profile", organizationId: "test-org", displayName: "Manager", role: "manager" };
const id = "20000000-0000-4000-8000-000000000001";
const entry: DirectoryEntry = { ...emptyDirectoryDraft("company"), id, updatedAt: "2026-09-07T10:00:00.000Z", name: "Saved company" };
const dispatchData = { source: "supabase", branches: [] };

function request(method: "POST" | "PATCH", body: unknown, raw = false) {
  return new Request(`https://example.test/api/directory${method === "PATCH" ? `/company/${id}` : ""}`, {
    method,
    headers: { origin: "https://example.test", host: "example.test", "content-type": "application/json" },
    body: raw ? String(body) : JSON.stringify(body),
  });
}
function mutate(method: "POST" | "PATCH", body: unknown, raw = false) {
  const input = request(method, body, raw);
  return method === "POST" ? POST(input) : PATCH(input, { params: Promise.resolve({ kind: "company", id }) });
}

beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockReset());
  mocks.actor.mockResolvedValue(actor);
  mocks.save.mockResolvedValue(entry);
  mocks.load.mockResolvedValue({ entries: [entry], canEdit: true });
  mocks.dispatch.mockResolvedValue(dispatchData);
});
afterEach(() => vi.restoreAllMocks());

describe("directory route permissions and request validation", () => {
  it("requires a directory read role and sends private uncached data", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.actor).toHaveBeenCalledWith(["dispatcher", "senior_dispatcher", "manager", "admin"]);
    expect(mocks.load).toHaveBeenCalledWith(actor);
    await expect(response.json()).resolves.toEqual({ entries: [entry], canEdit: true });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each([401, 403])("returns read authorization failure %s without reading the directory", async status => {
    mocks.actor.mockRejectedValue(new MutationError("Denied", status));
    const response = await GET();
    expect(response.status).toBe(status);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it.each(["POST", "PATCH"] as const)("blocks %s writes rejected by the origin guard before auth or save", async method => {
    mocks.sameOrigin.mockImplementation(() => { throw new MutationError("Origin denied", 403); });
    const response = await mutate(method, { kind: "company", name: "Denied" });
    expect(response.status).toBe(403);
    expect(mocks.actor).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each(["POST", "PATCH"] as const)("requires manager/admin for %s and does not save when authorization fails", async method => {
    mocks.actor.mockRejectedValue(new MutationError("Role denied", 403));
    const response = await mutate(method, { kind: "company", name: "Denied" });
    expect(response.status).toBe(403);
    expect(mocks.actor).toHaveBeenCalledWith(["manager", "admin"]);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each(["POST", "PATCH"] as const)("rejects malformed JSON and oversized %s before save", async method => {
    expect((await mutate(method, "{", true)).status).toBe(400);
    expect((await mutate(method, { kind: "company", name: "a".repeat(32_001) })).status).toBe(413);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it.each([null, [], {}, { kind: "../../company" }, { kind: ["company"] }])("rejects unsupported POST kind %j", async input => {
    expect((await POST(request("POST", input))).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("rejects an unsupported dynamic PATCH kind", async () => {
    const response = await PATCH(request("PATCH", { name: "Company" }), { params: Promise.resolve({ kind: "__proto__", id }) });
    expect(response.status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("preserves service conflicts and hides unexpected errors", async () => {
    mocks.save.mockRejectedValueOnce(new MutationError("Colleague edited this record", 409));
    const conflict = await mutate("PATCH", { name: "Changed" });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({ error: "Colleague edited this record" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.save.mockRejectedValueOnce(new Error("internal-database-detail"));
    const failed = await mutate("POST", { kind: "company", name: "New" });
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("internal-database-detail");
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});

describe("directory committed-write responses", () => {
  it.each(["POST", "PATCH"] as const)("acknowledges one %s and includes canonical dispatch data", async method => {
    const input = { kind: "company", name: "Saved company", ...(method === "PATCH" ? { expectedUpdatedAt: entry.updatedAt } : {}) };
    const response = await mutate(method, input);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({ entry, dispatchData, refreshRequired: false });
    expect(mocks.save).toHaveBeenCalledTimes(1);
    if (method === "POST") expect(mocks.save).toHaveBeenCalledWith(actor, "company", input);
    else expect(mocks.save).toHaveBeenCalledWith(actor, "company", input, id);
  });

  it.each(["POST", "PATCH"] as const)("keeps %s successful when the refresh rejects", async method => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.dispatch.mockRejectedValueOnce(new Error("refresh unavailable"));
    const response = await mutate(method, { kind: "company", name: "Saved company" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ entry, refreshRequired: true });
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it.each(["POST", "PATCH"] as const)("keeps %s successful without replacing real console state with mock fallback data", async method => {
    mocks.dispatch.mockResolvedValueOnce({ source: "mock", branches: [{ id: "demo-branch" }] });
    const response = await mutate(method, { kind: "company", name: "Saved company" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ entry, refreshRequired: true });
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });
});
