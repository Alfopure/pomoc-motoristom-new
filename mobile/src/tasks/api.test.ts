import { describe, expect, it, vi } from "vitest";
import { createEmployeeTasksApi, taskCommandInput, taskCreateInput } from "./api";
import { commandId, orgId, otherId, receipt, scope, task, taskId, userId } from "./fixtures.test-helper";
import type { MobileConfig } from "../lib/config";

const config: MobileConfig = { environment: "test", apiOrigin: "https://test.dispecing.linkapomoci.sk", supabaseUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", publishableKey: "sb_publishable_fixture" };
function fixture(value: unknown, status = 200) {
  const transport = vi.fn(async (_url: string, _init: RequestInit) => Response.json(value, { status }));
  const api = createEmployeeTasksApi(config, async () => "fixture-token", userId, orgId, transport);
  return { api, transport };
}

describe("employee task transport", () => {
  it("uses bearer identity and organization fencing, with no cookies", async () => {
    const f = fixture({ ...scope, view: "mine", tasks: [task], nextCursor: null });
    await f.api.list({ view: "mine", category: "open", q: "Doklady & auto" });
    const [url, init] = f.transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("q=Doklady+%26+auto");
    expect(init.credentials).toBe("omit");
    expect(init.headers).toMatchObject({ Authorization: "Bearer fixture-token", "X-PM-App-Environment": "test", "X-PM-Expected-Organization": orgId });
  });

  it.each([{ userId: otherId }, { environment: "production" }, { organizationId: otherId }])("rejects another response scope %j and revokes cached access", async change => {
    const f = fixture({ ...scope, ...change, view: "mine", tasks: [task], nextCursor: null }), revoked = vi.fn();
    f.api.subscribeAccessLoss(revoked);
    await expect(f.api.list({ view: "mine", category: "open", q: "" })).rejects.toMatchObject({ status: 502 });
    expect(revoked).toHaveBeenCalledOnce();
  });

  it("rechecks the organization learned by the first directory call", async () => {
    const transport = vi.fn().mockResolvedValueOnce(Response.json({ ...scope, people: [], groups: [], hasMorePeople: false, canLinkCases: false }))
      .mockResolvedValueOnce(Response.json({ ...scope, organizationId: otherId, people: [], groups: [], hasMorePeople: false, canLinkCases: false }));
    const api = createEmployeeTasksApi(config, async () => "token", userId, undefined, transport);
    await api.directory();
    await expect(api.directory("Martin")).rejects.toMatchObject({ status: 502 });
    expect(transport.mock.calls[1][1].headers["X-PM-Expected-Organization"]).toBe(orgId);
  });

  it("keeps explicit directory overflow and sends literal search", async () => {
    const f = fixture({ ...scope, people: [task.assignee], groups: [{ id: otherId, name: "Žilina", canManage: false }], hasMorePeople: true, canLinkCases: false });
    expect(await f.api.directory("O'Brian")).toMatchObject({ hasMorePeople: true, canLinkCases: false });
    expect(f.transport.mock.calls[0][0]).toContain("q=O%27Brian");
  });

  it("rejects duplicate directory identities and malformed permissions", async () => {
    const f = fixture({ ...scope, people: [task.assignee, task.assignee], groups: [], hasMorePeople: false, canLinkCases: false });
    await expect(f.api.directory()).rejects.toMatchObject({ status: 502 });
    const malformed = fixture({ ...scope, view: "mine", tasks: [{ ...task, permissions: { start: true } }], nextCursor: null });
    await expect(malformed.api.list({ view: "mine", category: "open", q: "" })).rejects.toMatchObject({ status: 502 });
  });

  it("rejects a repeated pagination cursor rather than looping", async () => {
    const f = fixture({ ...scope, view: "mine", tasks: [task], nextCursor: "same" });
    await expect(f.api.list({ view: "mine", category: "open", q: "", cursor: "same" })).rejects.toMatchObject({ status: 502 });
  });

  it("rejects a detail or command receipt for another task", async () => {
    await expect(fixture({ ...scope, task: { ...task, id: otherId }, activity: [], nextActivityCursor: null }).api.detail(taskId)).rejects.toMatchObject({ status: 502 });
    await expect(fixture({ ...receipt(), task: { ...task, id: otherId } }).api.command(taskId, { action: "start", expectedRevision: 1, commandId })).rejects.toMatchObject({ status: 502 });
  });

  it("rejects an unrelated command receipt and impossible committed revision", async () => {
    const input = { commandId, title: "Auto", target: { kind: "person" as const, userId } };
    await expect(fixture(receipt(otherId)).api.create(input)).rejects.toMatchObject({ status: 502 });
    await expect(fixture({ ...receipt(), committedRevision: 2 }).api.create(input)).rejects.toMatchObject({ status: 502 });
  });

  it("keeps transient failures separate from authorization loss", async () => {
    const transient = fixture({ error: "Nedostupné" }, 503), noAccess = fixture({ error: "Odobraté" }, 403);
    const first = vi.fn(), second = vi.fn(); transient.api.subscribeAccessLoss(first); noAccess.api.subscribeAccessLoss(second);
    await expect(transient.api.directory()).rejects.toMatchObject({ status: 503 });
    await expect(noAccess.api.directory()).rejects.toMatchObject({ status: 403 });
    expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledOnce();
  });

  it("a stale task action does not revoke the whole employee workspace", async () => {
    const f = fixture({ error: "Túto akciu už nemôžete vykonať." }, 403), revoked = vi.fn();
    f.api.subscribeAccessLoss(revoked);
    await expect(f.api.command(taskId, { action: "complete", commandId, expectedRevision: 1 })).rejects.toMatchObject({ status: 403 });
    expect(revoked).not.toHaveBeenCalled();
    const denied = fixture({ error: "Prístup odobratý", code: "employee_access_revoked" }, 403), lost = vi.fn(); denied.api.subscribeAccessLoss(lost);
    await expect(denied.api.command(taskId, { action: "complete", commandId, expectedRevision: 1 })).rejects.toMatchObject({ status: 403 });
    expect(lost).toHaveBeenCalledOnce();
  });

  it("rejects actor spoofing, mixed targets and invalid dates before sending", () => {
    const input = { commandId, title: "Auto", target: { kind: "person", userId } };
    expect(() => taskCreateInput({ ...input, actorId: otherId })).toThrow();
    expect(() => taskCreateInput({ ...input, target: { kind: "person", userId, groupId: otherId } })).toThrow();
    expect(() => taskCreateInput({ ...input, dueAt: "2026-02-31T12:00:00Z" })).toThrow();
    expect(() => taskCommandInput({ action: "complete", commandId, expectedRevision: 1, reviewerUserId: userId })).toThrow();
  });
});
