import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmployeeTask } from "@/lib/mobile-task-workspace";
import { MutationError } from "@/server/mutation-error";

const mocks = vi.hoisted(() => ({ verify: vi.fn(), rpc: vi.fn() }));
vi.mock("./auth", () => ({ verifyMobileUser: mocks.verify, mobileEnvironment: () => "test" }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ rpc: mocks.rpc }) }));
import { GET as list, POST as create } from "@/app/api/mobile/v1/tasks/workspace/route";
import { GET as directory } from "@/app/api/mobile/v1/tasks/workspace/directory/route";
import { GET as detail } from "@/app/api/mobile/v1/tasks/workspace/[id]/route";
import { POST as command } from "@/app/api/mobile/v1/tasks/workspace/[id]/commands/route";
import { parseEmployeeTaskCreate, parseEmployeeTaskCommand } from "./employee-tasks";

const userId = "10000000-0000-4000-8000-000000000001", organizationId = "20000000-0000-4000-8000-000000000001";
const taskId = "30000000-0000-4000-8000-000000000001", otherTaskId = "30000000-0000-4000-8000-000000000002";
const commandId = "40000000-0000-4000-8000-000000000001", groupId = "50000000-0000-4000-8000-000000000001";
const at = "2026-11-06T12:00:00.000Z", person = { userId, displayName: "Vodič bez dispečerského profilu" };
const context = { params: Promise.resolve({ id: taskId }) };
const user = { userId, organizationId, expectedOrganization: null, email: "field@example.test" };
function task(): EmployeeTask {
  return { id: taskId, title: "Pripraviť vozidlo", description: "Doplniť výbavu.", state: "todo", priority: "normal", dueAt: null,
    revision: 3, createdAt: at, updatedAt: at, createdBy: person, assignee: person, group: null, reviewer: null,
    caseLinks: [], reviewSubmission: null, reviewReturnReason: null,
    permissions: { start: true, complete: true, reopen: false, claim: false, assign: true, comment: true, submitReview: false, approve: false, return: false } };
}
const createInput = () => ({ commandId, title: "Pripraviť vozidlo", target: { kind: "person", userId } });
const commandInput = () => ({ commandId, expectedRevision: 2, action: "start" });
function request(method = "GET", query = "", body?: unknown, headers: HeadersInit = { "Content-Type": "application/json" }) {
  return new Request("https://test.dispecing.linkapomoci.sk/api/mobile/v1/tasks/workspace?" + query,
    { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function result(data: unknown) { mocks.rpc.mockResolvedValueOnce({ data, error: null }); }
function rpcData(action: string) {
  if (action === "list") return { view: "mine", tasks: [task()], nextCursor: null };
  if (action === "directory") return { people: [person], groups: [{ id: groupId, name: "Žilina", canManage: true }], hasMorePeople: false, canLinkCases: false };
  if (action === "get") return { task: task(), activity: [{ id: commandId, author: person, body: "Pridelená úloha", createdAt: at, kind: "assigned" }], nextActivityCursor: null };
  return { commandId, committedRevision: 3, task: task() };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.verify.mockResolvedValue(user);
  mocks.rpc.mockImplementation(async (_name: string, args: { p_action: string }) => ({ data: rpcData(args.p_action), error: null }));
});

describe("employee task API authorization and private scope", () => {
  it("distinguishes revoked employee membership from one refused task action", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "Employee task access denied" } });
    const revoked = await command(request("POST", "", commandInput()), context);
    expect(revoked.status).toBe(403);
    expect(await revoked.json()).toMatchObject({ code: "employee_access_revoked" });
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "Task action denied" } });
    const denied = await command(request("POST", "", commandInput()), context);
    expect(denied.status).toBe(403);
    expect(await denied.json()).not.toHaveProperty("code", "employee_access_revoked");
  });
  it("allows a verified field-only employee without requiring dispatch or delivery flags", async () => {
    const response = await list(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, apiVersion: 1, environment: "test", userId, organizationId, view: "mine", tasks: [{ id: taskId }] });
    expect(mocks.rpc).toHaveBeenCalledWith("motorist_employee_tasks", { p_user_id: userId, p_organization_id: organizationId,
      p_action: "list", p_task_id: null, p_input: { view: "mine", category: "open", q: "", cursor: null, limit: 25 } });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Vary")).toBe("Authorization, X-PM-App-Environment");
  });
  const endpoints = [
    { name: "list", invoke: () => list(request()) },
    { name: "directory", invoke: () => directory(request()) },
    { name: "detail", invoke: () => detail(request(), context) },
    { name: "create", invoke: () => create(request("POST", "", createInput())) },
    { name: "command", invoke: () => command(request("POST", "", commandInput()), context) },
  ];
  it.each(endpoints)("verifies identity before $name data or form handling", async ({ invoke }) => {
    mocks.verify.mockRejectedValue(new MutationError("Prihláste sa.", 401));
    const response = await invoke();
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("retains environment verification failures from the shared verifier", async () => {
    mocks.verify.mockRejectedValue(new MutationError("Nesprávne prostredie.", 409));
    expect((await list(request())).status).toBe(409);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(endpoints)("fences a changed organization before $name RPC", async ({ invoke }) => {
    mocks.verify.mockResolvedValue({ ...user, expectedOrganization: otherTaskId });
    const response = await invoke();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "expected_organization_mismatch" });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("takes scope only from verified server identity and never publishes extra RPC fields", async () => {
    result({ ...rpcData("list"), secret: "PRIVATE", userId: otherTaskId, organizationId: otherTaskId });
    const body = await (await list(request())).json();
    expect(body).toMatchObject({ userId, organizationId });
    expect(body).not.toHaveProperty("secret");
  });
});

describe("employee task forms and selection", () => {
  it("creates a standalone task with a stable command ID and normalized target", async () => {
    const response = await create(request("POST", "", { ...createInput(), title: "  Pripraviť vozidlo  " }));
    expect(response.status).toBe(201);
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_action: "create", p_task_id: null,
      p_input: { commandId, title: "Pripraviť vozidlo", target: { kind: "person", userId }, priority: "normal" } });
    expect(await response.json()).toMatchObject({ commandId, committedRevision: 3, task: { id: taskId } });
  });
  it("accepts a branch target and optional case/date/description without inventing a case", () => {
    expect(parseEmployeeTaskCreate({ ...createInput(), target: { kind: "group", groupId }, caseId: taskId,
      description: "  Pokyn  ", dueAt: "2026-11-07T17:00:00+01:00", priority: "high" })).toEqual({
      commandId, title: "Pripraviť vozidlo", target: { kind: "group", groupId }, caseId: taskId,
      description: "Pokyn", dueAt: "2026-11-07T16:00:00.000Z", priority: "high",
    });
  });
  it.each([
    { userId }, { organizationId }, { actorId: userId }, { profileId: userId }, { commandId: "bad" }, { title: " " },
    { title: "x".repeat(501) }, { description: "x".repeat(10_001) }, { dueAt: "2026-02-30T12:00:00Z" },
    { dueAt: "2026-11-06 12:00" }, { dueAt: "not-a-date" }, { priority: "critical" }, { caseId: "bad" },
    { target: { kind: "person", userId, groupId } }, { target: { kind: "person", userId: "bad" } },
    { target: { kind: "group", groupId, userId } }, { target: { kind: "everyone" } },
  ])("rejects malformed/spoofed create fields before any write: %j", async change => {
    const response = await create(request("POST", "", { ...createInput(), ...change }));
    expect(response.status).toBe(400); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it.each(["userId=spoof", "organizationId=spoof", "view=all", "category=closed", "limit=51", "limit=0", "limit=1.5", "limit=01", "q=a&q=b", "cursor=", "q=" + "x".repeat(201)])("rejects invalid list selection %s", async query => {
    expect((await list(request("GET", query))).status).toBe(400); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("passes only bounded normalized filters and exact cursor", async () => {
    const next = "cursor-for-next-page";
    result({ view: "branch", tasks: [], nextCursor: null });
    expect((await list(request("GET", "view=branch&category=all&q=%20doklady%20&limit=7&cursor=" + next))).status).toBe(200);
    expect(mocks.rpc.mock.calls[0][1].p_input).toEqual({ view: "branch", category: "all", q: "doklady", cursor: next, limit: 7 });
  });
  it("returns a minimal employee directory, including the honest truncation flag", async () => {
    const response = await directory(request("GET", "q=%20Vodi%C4%8D%20"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ people: [person], canLinkCases: false, hasMorePeople: false, groups: [{ id: groupId, canManage: true }] });
    expect(mocks.rpc.mock.calls[0][1].p_input).toEqual({ q: "Vodič" });
  });
  it.each(["q=a&q=b", "userId=" + userId, "cursor=unexpected"])("rejects directory scope injection %s", async query => {
    expect((await directory(request("GET", query))).status).toBe(400); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("bounds form bytes and enforces JSON before a create RPC", async () => {
    expect((await create(request("POST", "", createInput(), { "Content-Type": "text/plain" }))).status).toBe(400);
    expect((await create(request("POST", "", { title: "x".repeat(64_000) }))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("rejects malformed detail ids or duplicate cursors before reading task data", async () => {
    expect((await detail(request(), { params: Promise.resolve({ id: "bad" }) })).status).toBe(400);
    expect((await detail(request("GET", "cursor=a&cursor=b"), context)).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("employee task commands and unconfirmed responses", () => {
  it.each([
    { ...commandInput(), action: "assign", target: { kind: "group", groupId } },
    { ...commandInput(), action: "comment", body: "  Pripravené.  " },
    { ...commandInput(), action: "submit_review", reviewerUserId: otherTaskId, comment: "Overiť doklady." },
    { ...commandInput(), action: "return", comment: "Doplniť podpis." },
    ...["claim", "start", "complete", "reopen", "approve"].map(action => ({ ...commandInput(), action })),
  ])("keeps original command identity for %j", async input => {
    const response = await command(request("POST", "", input), context);
    expect(response.status).toBe(200);
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_action: "command", p_task_id: taskId, p_input: { commandId, expectedRevision: 2, action: input.action } });
    expect(await response.json()).toMatchObject({ commandId, task: { id: taskId } });
  });
  it.each([
    { expectedRevision: 0 }, { expectedRevision: "2" }, { expectedRevision: 2.5 }, { expectedRevision: 2_147_483_648 },
    { commandId: "bad" }, { action: "delete" }, { actorId: userId }, { userId },
    { action: "comment", body: " " }, { action: "claim", target: { kind: "person", userId } },
    { action: "submit_review", reviewerUserId: userId, comment: " " },
  ])("rejects unsafe command fields %j", async change => {
    const response = await command(request("POST", "", { ...commandInput(), ...change }), context);
    expect(response.status).toBe(400); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("normalizes a comment without changing its command ID", () => {
    expect(parseEmployeeTaskCommand({ ...commandInput(), action: "comment", body: "  Hotovo.  " })).toEqual({ ...commandInput(), action: "comment", body: "Hotovo." });
  });
  it.each([
    ["42501", 403], ["P0002", 404], ["PT409", 409], ["23505", 409], ["22023", 400],
    ["55000", 503], ["PGRST202", 503], ["42P01", 503], ["XX000", 503],
  ])("maps database code %s to %i without disclosing SQL", async (code, status) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code, message: "PRIVATE_SQL_AND_USER_VALUES" } });
    const response = await command(request("POST", "", commandInput()), context);
    expect(response.status).toBe(status);
    expect(JSON.stringify(await response.json())).not.toContain("PRIVATE_SQL_AND_USER_VALUES");
    if (status === 409) expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it.each([
    { commandId: otherTaskId }, { committedRevision: 0 }, { committedRevision: 4 },
    { task: { ...task(), id: otherTaskId } }, { task: { ...task(), permissions: {} } },
    { task: { ...task(), state: "unknown" } }, { task: { ...task(), revision: "3" } },
  ])("fails closed on an unconfirmed/mismatched command receipt %j", async change => {
    result({ ...rpcData("command"), ...change });
    const response = await command(request("POST", "", commandInput()), context);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "task_workspace_unconfirmed" });
  });
  it("rejects a create receipt for a different creator instead of confirming the wrong task", async () => {
    result({ ...rpcData("create"), task: { ...task(), createdBy: { ...person, userId: otherTaskId } } });
    expect((await create(request("POST", "", createInput()))).status).toBe(503);
  });
  it.each([
    { tasks: [task(), task()] }, { view: "created" }, { nextCursor: "next", tasks: [] },
    { tasks: [{ ...task(), caseLinks: [{ id: groupId, number: "1" }, { id: groupId, number: "1" }] }] },
  ])("refuses a mixed or malformed task page %j", async change => {
    result({ ...rpcData("list"), ...change });
    expect((await list(request())).status).toBe(503);
  });
  it("rejects duplicate people in the directory", async () => {
    result({ ...rpcData("directory"), people: [person, person] });
    expect((await directory(request())).status).toBe(503);
  });
  it("reads exact detail with bounded activity and rejects a different task", async () => {
    expect((await detail(request(), context)).status).toBe(200);
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_action: "get", p_task_id: taskId, p_input: { cursor: null } });
    result({ ...rpcData("get"), task: { ...task(), id: otherTaskId } });
    expect((await detail(request(), context)).status).toBe(503);
  });
  it("does not return raw transport errors after an uncertain create", async () => {
    mocks.rpc.mockRejectedValue(new Error("PRIVATE_SERVICE_KEY_DATABASE_DETAILS"));
    const response = await create(request("POST", "", createInput()));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("PRIVATE_SERVICE_KEY_DATABASE_DETAILS");
  });
});

describe("employee task extensions", () => {
  const item = { id: groupId, title: "Skontrolovať pneumatiky", done: false };
  it("explains an inactive recurrence owner without exposing the internal database error", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "22023", message: "Task recurrence owner inactive" } });
    const response = await command(request("POST", "", { ...commandInput(), action: "recurrence", schedule: { frequency: "daily", time: "08:30" } }), context);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "task_recurrence_owner_inactive", error: "Autor série už nemá prístup. Vytvorte novú opakovanú úlohu." });
  });
  it("explains an unavailable recurrence recipient with an actionable localized error", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "22023", message: "Task recurrence recipient inactive" } });
    const response = await command(request("POST", "", { ...commandInput(), action: "recurrence", expectedSeriesRevision: 2, schedule: { frequency: "daily", time: "08:30" } }), context);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "task_recurrence_recipient_inactive", error: "Príjemca série už nie je dostupný. Vytvorte novú opakovanú úlohu s platným príjemcom." });
  });
  it("forwards server due filters and verifies the response echo/time zone", async () => {
    result({ ...rpcData("list"), dueFilter: "today", timeZone: "Europe/Bratislava" });
    const response = await list(request("GET", "dueFilter=today"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ dueFilter: "today", timeZone: "Europe/Bratislava" });
    expect(mocks.rpc).toHaveBeenLastCalledWith("motorist_employee_tasks", expect.objectContaining({ p_input: expect.objectContaining({ dueFilter: "today" }) }));
    result({ ...rpcData("list"), dueFilter: "all", timeZone: "Europe/Bratislava" });
    expect((await list(request("GET", "dueFilter=overdue"))).status).toBe(503);
  });
  it.each(["dueFilter=tomorrow", "dueFilter=today&dueFilter=overdue"])("rejects invalid due filter %s", async query => {
    expect((await list(request("GET", query))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("creates a bounded checklist and daily/weekly series without accepting client time zones", () => {
    expect(parseEmployeeTaskCreate({ ...createInput(), checklist: [item], recurrence: { frequency: "weekly", time: "08:30", weekday: 7 } })).toMatchObject({ checklist: [item], recurrence: { frequency: "weekly", time: "08:30", weekday: 7 } });
    expect(() => parseEmployeeTaskCreate({ ...createInput(), checklist: [item, item] })).toThrow();
    expect(() => parseEmployeeTaskCreate({ ...createInput(), recurrence: { frequency: "weekly", time: "08:30", weekday: 0 } })).toThrow();
    expect(() => parseEmployeeTaskCreate({ ...createInput(), recurrence: { frequency: "daily", time: "24:00" } })).toThrow();
    expect(() => parseEmployeeTaskCreate({ ...createInput(), recurrence: { frequency: "daily", time: "08:30", timeZone: "UTC" } })).toThrow();
    expect(() => parseEmployeeTaskCreate({ ...createInput(), checklist: Array.from({ length: 51 }, (_, index) => ({ ...item, id: `50000000-0000-4000-8000-${String(index).padStart(12, "0")}` })) })).toThrow();
  });
  it("preserves checklist commands, pause and explicit completion confirmation", () => {
    expect(parseEmployeeTaskCommand({ ...commandInput(), action: "checklist", items: [item] })).toMatchObject({ action: "checklist", items: [item] });
    expect(parseEmployeeTaskCommand({ ...commandInput(), action: "recurrence", schedule: null })).toMatchObject({ action: "recurrence", schedule: null });
    expect(parseEmployeeTaskCommand({ ...commandInput(), action: "recurrence", schedule: null, expectedSeriesRevision: 4 })).toMatchObject({ action: "recurrence", schedule: null, expectedSeriesRevision: 4 });
    for (const expectedSeriesRevision of [0, -1, 1.5, "1", null, 2_147_483_648]) {
      expect(() => parseEmployeeTaskCommand({ ...commandInput(), action: "recurrence", schedule: null, expectedSeriesRevision })).toThrow();
    }
    for (const action of ["complete", "approve"]) {
      expect(parseEmployeeTaskCommand({ ...commandInput(), action, allowIncompleteChecklist: true })).toMatchObject({ action, allowIncompleteChecklist: true });
      expect(() => parseEmployeeTaskCommand({ ...commandInput(), action, allowIncompleteChecklist: "true" })).toThrow();
    }
  });
  it("does not expose attachment confirmation through arbitrary task command JSON", () => {
    expect(() => parseEmployeeTaskCommand({ ...commandInput(), action: "attachment_finish", attachmentId: groupId })).toThrow();
  });
  it("returns typed extensions and rejects malformed private storage metadata", async () => {
    const extended = { ...task(), checklist: [item], recurrence: { id: groupId, revision: 1, frequency: "daily", time: "08:30", weekday: null, timeZone: "Europe/Bratislava", state: "active", nextAt: at },
      attachments: [{ id: groupId, fileName: "foto.jpg", mimeType: "image/jpeg", sizeBytes: 100, createdAt: at, canRemove: true }], permissions: { ...task().permissions, attach: true, editChecklist: true, manageRecurrence: false } };
    result({ ...rpcData("get"), task: extended });
    const response = await detail(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ task: extended });
    result({ ...rpcData("get"), task: { ...extended, recurrence: { ...extended.recurrence, timeZone: "not/a/zone" } } });
    expect((await detail(request(), context)).status).toBe(503);
    result({ ...rpcData("get"), task: { ...extended, recurrence: { ...extended.recurrence, revision: undefined } } });
    expect((await detail(request(), context)).status).toBe(503);
    for (const issue of ["creator_inactive", "recipient_unavailable"]) {
      result({ ...rpcData("get"), task: { ...extended, recurrence: { ...extended.recurrence, state: "needs_attention", issue } } });
      const withIssue = await detail(request(), context);
      expect(withIssue.status).toBe(200);
      expect(await withIssue.json()).toMatchObject({ task: { recurrence: { issue } } });
    }
    result({ ...rpcData("get"), task: { ...extended, recurrence: { ...extended.recurrence, issue: "private_database_error" } } });
    expect((await detail(request(), context)).status).toBe(503);
    result({ ...rpcData("get"), task: { ...extended, attachments: [...extended.attachments, ...extended.attachments] } });
    expect((await detail(request(), context)).status).toBe(503);
  });
});
