import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
const mocks = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: () => { throw new Error("COOKIE CLIENT MUST NOT BE USED"); } }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("@/server/task-notifications", () => ({ deliverTaskAssignmentNotifications: async () => { throw new Error("postcommit notice unavailable"); } }));
import { createFakeSupabase, fakeError, type FakeRow } from "@/test/fake-supabase";
import {
  createMobileTask, getMobileTask, listMobileCaseTasks, listMobileTaskColleagues, listMobileTaskMessages,
  parseMobileTaskCreate, parseMobileTaskMessage, parseMobileTaskQuery, parseMobileTaskWorkflow,
  sendMobileTaskMessage, transitionMobileTask,
} from "./tasks";

const org = "33333333-3333-4333-8333-333333333333", profile = "22222222-2222-4222-8222-222222222222";
const caseId = "44444444-4444-4444-8444-444444444444", taskId = "55555555-5555-4555-8555-555555555555";
const commandId = "66666666-6666-4666-8666-666666666666", colleagueId = "77777777-7777-4777-8777-777777777777";
const otherOrg = "88888888-8888-4888-8888-888888888888";
const actor = { organizationId: org, profileId: profile, userId: "11111111-1111-4111-8111-111111111111", role: "dispatcher" as const, displayName: "Dispečer" };
const at = "2026-10-11T20:00:00.123456+00:00";
const workflow = { action: "start" as const, expectedRevision: 4, commandId };
function dto(extra: Record<string, unknown> = {}) {
  return { id: taskId, title: "Pripraviť dokumenty", assignedTo: colleagueId, dueAt: "", status: "open", priority: "normal", kind: "documents", createdBy: profile,
    revision: 4, originLocked: false, createdAt: at, updatedAt: at, caseIds: [caseId], caseLinks: [{ caseId, caseNumber: "MOCK-1", status: "open" }], origins: [], ...extra };
}
function row(id = taskId, extra: Record<string, unknown> = {}) {
  return { id, organization_id: org, title: "Pripraviť dokumenty", assigned_to: colleagueId, due_at: null, status: "open", priority: "normal", kind: "documents", created_by: profile,
    revision: 4, origin_locked: false, created_at: "2026-10-10T01:00:00Z", updated_at: at, ...extra };
}
let fake: ReturnType<typeof createFakeSupabase>;
let user: SupabaseClient<Database>;
function seed(table: string, rows: FakeRow[]) { fake.db.storage(table).length = 0; fake.db.seed(table, rows); }
beforeEach(() => {
  fake = createFakeSupabase();
  mocks.admin.mockReset().mockReturnValue(fake.admin);
  user = { from: (table: string) => {
    if (table === "motorist_task_workspace_settings") throw new Error("AUTHENTICATED HAS NO SETTINGS GRANT");
    return fake.client.from(table);
  }, rpc: fake.client.rpc } as unknown as SupabaseClient<Database>;
  seed("motorist_cases", [{ id: caseId, organization_id: org, case_number: "MOCK-1", status: "open" }]);
  seed("motorist_task_case_links", [{ organization_id: org, case_id: caseId, task_id: taskId, created_at: at }]);
  seed("motorist_case_tasks", [row()]);
  seed("motorist_profiles", [{ id: colleagueId, organization_id: org, user_id: actor.userId, display_name: "Kolega", role: "dispatcher", active: true, access_status: "active", kind: "human" }]);
  seed("motorist_task_workspace_settings", [{ organization_id: org, enabled: true, writer_inventory_verified_at: at, writer_inventory_note: "Verified web writers" }]);
  fake.db.registerRpc("motorist_task_workflow_enabled", () => true);
  fake.db.registerRpc("motorist_task_workspace", args => args.p_action === "get" || args.p_action === "create" ? dto() : { messages: [], nextCursor: null });
});

describe("bounded mobile case task reads", () => {
  it("uses organization-scoped links, preserves legacy stages and exposes no origin/provider fields", async () => {
    seed("motorist_task_case_links", [
      { organization_id: org, case_id: caseId, task_id: taskId, created_at: at },
      { organization_id: otherOrg, case_id: caseId, task_id: commandId, created_at: at },
    ]);
    const result = await listMobileCaseTasks(actor, caseId, parseMobileTaskQuery(new URLSearchParams()), user);
    expect(result.tasks).toHaveLength(1); expect(result.tasks[0]).toMatchObject({ id: taskId, workflowState: "todo", assignedTo: { id: colleagueId, name: "Kolega" }, createdByMe: true });
    expect(result.capabilities).toEqual({ create: true, workflow: true, messages: true });
    expect(JSON.stringify(result)).not.toContain("origins");
    expect(fake.db.log.filter(entry => entry.kind === "query").every(entry => entry.filters?.includes("eq(organization_id)"))).toBe(true);
    expect(fake.db.log.filter(entry => entry.kind === "rpc").map(entry => entry.table)).toEqual(["motorist_task_workflow_enabled"]);
  });
  it("derives the cursor from link time/id, not task creation time, retaining microseconds and scope", async () => {
    const second = "99999999-9999-4999-8999-999999999999";
    seed("motorist_task_case_links", [
      { organization_id: org, case_id: caseId, task_id: second, created_at: at },
      { organization_id: org, case_id: caseId, task_id: taskId, created_at: "2026-10-11T20:00:00.123455+00:00" },
    ]);
    seed("motorist_case_tasks", [row(), row(second)]);
    const first = await listMobileCaseTasks(actor, caseId, parseMobileTaskQuery(new URLSearchParams("limit=1")), user);
    expect(first.tasks[0].id).toBe(second);
    const decoded = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString()); expect(decoded.createdAt).toBe(at); expect(decoded.id).toBe(second);
    const query = parseMobileTaskQuery(new URLSearchParams({ cursor: first.nextCursor!, limit: "1" }));
    const next = await listMobileCaseTasks(actor, caseId, query, user);
    expect(next.tasks.map(task => task.id)).toEqual([taskId]); expect(next.nextCursor).toBeNull();
    await expect(listMobileCaseTasks({ ...actor, profileId: colleagueId }, caseId, query, user)).rejects.toMatchObject({ status: 400 });
    expect(fake.db.log.some(entry => entry.filters?.includes("eq(created_at)"))).toBe(true);
  });
  it("reports missing link schema and disappearing task data as unavailable rather than empty success", async () => {
    fake.db.failNext("motorist_task_case_links", "select", fakeError("relation missing", "42P01"));
    await expect(listMobileCaseTasks(actor, caseId, parseMobileTaskQuery(new URLSearchParams()), user)).rejects.toMatchObject({ status: 503 });
    seed("motorist_case_tasks", []);
    await expect(listMobileCaseTasks(actor, caseId, parseMobileTaskQuery(new URLSearchParams()), user)).rejects.toMatchObject({ status: 503 });
  });
  it("keeps inactive historical assignee names while excluding them from eligible choices", async () => {
    seed("motorist_profiles", [{ id: colleagueId, organization_id: org, user_id: actor.userId, display_name: "Bývalý kolega", role: "dispatcher", active: false, access_status: "disabled", kind: "human" }]);
    const result = await listMobileCaseTasks(actor, caseId, parseMobileTaskQuery(new URLSearchParams()), user);
    expect(result.tasks[0].assignedTo?.name).toBe("Bývalý kolega");
    expect(await listMobileTaskColleagues(actor, user)).toEqual([]);
  });
  it("requires active/access-active human login roles for eligible choices, with explicit overflow", async () => {
    const good = { id: colleagueId, organization_id: org, user_id: actor.userId, display_name: "Kolega", role: "dispatcher", active: true, access_status: "active", kind: "human" };
    seed("motorist_profiles", [good, ...[{ active: false }, { access_status: "disabled" }, { kind: "ai" }, { role: "unknown" }, { organization_id: otherOrg }, { user_id: null }].map((patch, index) => ({ ...good, id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, ...patch }))]);
    expect(await listMobileTaskColleagues(actor, user)).toEqual([{ id: colleagueId, name: "Kolega" }]);
    seed("motorist_profiles", Array.from({ length: 201 }, (_, index) => ({ ...good, id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` })));
    await expect(listMobileTaskColleagues(actor, user)).rejects.toMatchObject({ status: 503 });
  });
  it("keeps read-only lists while disabled settings or absent workflow RPC do not enable writes", async () => {
    seed("motorist_task_workspace_settings", [{ organization_id: org, enabled: false }]);
    fake.db.failNext("motorist_task_workflow_enabled", "rpc", fakeError("function missing", "PGRST202"));
    const result = await listMobileCaseTasks(actor, caseId, parseMobileTaskQuery(new URLSearchParams()), user);
    expect(result.tasks).toHaveLength(1); expect(result.capabilities).toEqual({ create: false, workflow: false, messages: false });
  });
  it("does not mask configuration outages or enabled settings with missing writer verification", async () => {
    fake.db.failNext("motorist_task_workspace_settings", "select", fakeError("settings outage", "57014"));
    await expect(listMobileCaseTasks(actor, caseId, parseMobileTaskQuery(new URLSearchParams()), user)).rejects.toMatchObject({ status: 503 });
    seed("motorist_task_workspace_settings", [{ organization_id: org, enabled: true, writer_inventory_verified_at: null, writer_inventory_note: "" }]);
    await expect(getMobileTask(actor, taskId, user)).rejects.toMatchObject({ status: 503 });
  });
  it("loads task detail via the exact injected user RPC and safely maps linked cases", async () => {
    const result = await getMobileTask(actor, taskId, user);
    expect(result.linkedCases).toEqual([{ id: caseId, caseNumber: "MOCK-1", status: "open" }]);
    expect(result.task.workflowState).toBe("todo");
    expect(fake.db.log.find(entry => entry.table === "motorist_task_workspace")?.payload).toMatchObject({ p_organization_id: org, p_actor_profile_id: profile, p_task_id: taskId, p_action: "get" });
  });
});

describe("mobile task write boundaries", () => {
  it("forces exactly the path case and preserves a committed create if notification delivery fails", async () => {
    const result = await createMobileTask(actor, caseId, parseMobileTaskCreate({ title: "Pripraviť dokumenty", assignedTo: colleagueId }), user);
    expect(result).toEqual({ caseId, taskId, refreshRequired: true });
    const rpc = fake.db.log.find(entry => entry.table === "motorist_task_workspace");
    expect(rpc?.payload).toMatchObject({ p_action: "create", p_input: { title: "Pripraviť dokumenty", caseIds: [caseId], assignedTo: colleagueId } });
    expect(fake.db.log.filter(entry => entry.table === "motorist_profiles")).toHaveLength(1);
  });
  it.each([{ createdBy: colleagueId }, { caseIds: [] }, { caseIds: [caseId, commandId] }, { id: "bad" }, { revision: 0 }])("does not call a malformed/unbound create receipt successful %j", async extra => {
    fake.db.registerRpc("motorist_task_workspace", () => dto(extra));
    await expect(createMobileTask(actor, caseId, { title: "Pripraviť dokumenty" }, user)).rejects.toMatchObject({ status: 503, code: "mobile_task_create_uncertain" });
  });
  it("rejects inactive assignee before new create, with no task write", async () => {
    seed("motorist_profiles", []);
    await expect(createMobileTask(actor, caseId, { title: "Úloha", assignedTo: colleagueId }, user)).rejects.toMatchObject({ status: 400 });
    expect(fake.db.log.some(entry => entry.table === "motorist_task_workspace")).toBe(false);
  });
  it("accepts exact workflow replay with an advanced current revision without checking now-inactive reviewer", async () => {
    const command = { ...workflow, action: "submit_review" as const, reviewerProfileId: colleagueId, comment: "Skontrolujte podpis" };
    seed("motorist_profiles", []);
    fake.db.registerRpc("motorist_task_workflow", () => ({ task: dto({ workflowVersion: 1, workflowState: "done", status: "done", revision: 9 }), commandId, committedRevision: 5 }));
    const result = await transitionMobileTask(actor, taskId, command, user);
    expect(result).toEqual({ taskId, commandId, committedRevision: 5, currentRevision: 9, refreshRequired: true });
    expect(fake.db.log.filter(entry => entry.kind === "query")).toEqual([]);
  });
  it.each([{ committedRevision: 4 }, { committedRevision: 10 }, { commandId: colleagueId }])("rejects unrelated/older workflow receipt %j as uncertain", async extra => {
    fake.db.registerRpc("motorist_task_workflow", () => ({ task: dto({ workflowVersion: 1, workflowState: "in_progress", revision: 5 }), commandId, committedRevision: 5, ...extra }));
    await expect(transitionMobileTask(actor, taskId, workflow, user)).rejects.toMatchObject({ status: 503 });
  });
  it("preserves generic reused-command/revision conflict without inventing a safe-reset code", async () => {
    fake.db.failNext("motorist_task_workflow", "rpc", fakeError("Task command ID reused", "PT409"));
    await expect(transitionMobileTask(actor, taskId, workflow, user)).rejects.toMatchObject({ status: 409 });
  });
  it("returns exact message receipt without a postcommit read and rejects wrong actor/body/identity", async () => {
    const message = { id: commandId, taskId, authorProfileId: profile, authorName: "Dispečer", body: "Pripravené", createdAt: at, clientMessageId: colleagueId };
    fake.db.registerRpc("motorist_task_workspace", () => message);
    expect(await sendMobileTaskMessage(actor, taskId, { clientMessageId: colleagueId, body: "  Pripravené  " }, user)).toEqual({ taskId, message, refreshRequired: true });
    expect(fake.db.log.filter(entry => entry.kind === "query")).toEqual([]);
    for (const patch of [{ taskId: colleagueId }, { authorProfileId: colleagueId }, { body: "iné" }, { clientMessageId: commandId }]) {
      fake.db.registerRpc("motorist_task_workspace", () => ({ ...message, ...patch }));
      await expect(sendMobileTaskMessage(actor, taskId, { clientMessageId: colleagueId, body: "Pripravené" }, user)).rejects.toMatchObject({ status: 503 });
    }
  });
  it("bounds and validates message page and actor/task-scoped opaque cursor", async () => {
    const message = { id: commandId, taskId, authorProfileId: profile, authorName: "Dispečer", body: "Správa", createdAt: at, clientMessageId: colleagueId };
    fake.db.registerRpc("motorist_task_workspace", () => ({ messages: [message], nextCursor: { createdAt: at, id: commandId } }));
    const first = await listMobileTaskMessages(actor, taskId, new URLSearchParams(), user);
    fake.db.registerRpc("motorist_task_workspace", () => ({ messages: [message], nextCursor: null }));
    const next = await listMobileTaskMessages(actor, taskId, new URLSearchParams({ cursor: first.nextCursor! }), user);
    expect(next.messages).toEqual([message]);
    expect(fake.db.log.at(-1)?.payload).toMatchObject({ p_input: { beforeCreatedAt: at, beforeId: commandId } });
    await expect(listMobileTaskMessages(actor, colleagueId, new URLSearchParams({ cursor: first.nextCursor! }), user)).rejects.toMatchObject({ status: 400 });
    fake.db.registerRpc("motorist_task_workspace", () => ({ messages: Array(51).fill(message), nextCursor: null }));
    await expect(listMobileTaskMessages(actor, taskId, new URLSearchParams(), user)).rejects.toMatchObject({ status: 503 });
    fake.db.registerRpc("motorist_task_workspace", () => ({ messages: [message], nextCursor: { createdAt: at, id: colleagueId } }));
    await expect(listMobileTaskMessages(actor, taskId, new URLSearchParams(), user)).rejects.toMatchObject({ status: 503 });
  });
});

describe("strict mobile task forms", () => {
  it.each([{ title: "" }, { title: "x", caseIds: [caseId] }, { title: "x", status: "done" }, { title: "x", createdBy: colleagueId }, { title: "x", reminderChannels: ["email"] }, { title: "x\0" }, { title: "x", dueAt: "2026-02-30" }, { title: "x", priority: ["normal"] }, { title: "x", kind: ["documents"] }])("rejects unsupported or malformed create %j", value => {
    expect(() => parseMobileTaskCreate(value)).toThrow();
  });
  it.each([{ ...workflow, actorProfileId: colleagueId }, { ...workflow, comment: "x\0" }, { ...workflow, expectedRevision: 1.5 }, { ...workflow, action: "return" }])("rejects unsupported workflow %j", value => {
    expect(() => parseMobileTaskWorkflow(value)).toThrow();
  });
  it.each([{ clientMessageId: colleagueId, body: "x", authorProfileId: profile }, { clientMessageId: colleagueId, body: "x\0" }, { clientMessageId: colleagueId, body: " " }])("rejects unsupported message %j", value => {
    expect(() => parseMobileTaskMessage(value)).toThrow();
  });
  it.each(["limit=26", "limit=1&limit=2", "cursor=bad", "organizationId=spoof"])("rejects invalid scoped list filter %s", query => {
    expect(() => parseMobileTaskQuery(new URLSearchParams(query))).toThrow();
  });
});
