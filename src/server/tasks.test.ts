import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), deliver: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ kind: "admin" }) }));
vi.mock("./task-notifications", () => ({ deliverTaskAssignmentNotifications: mocks.deliver }));
import { createWorkspaceTask, deleteWorkspaceTask, loadTaskMessages, loadWorkspaceTask, sendTaskMessage, updateWorkspaceTask, validateTaskInput } from "./tasks";
import type { MotoristActor } from "./api-auth";
const actor: MotoristActor = { organizationId: "org", profileId: "a", userId: "u", role: "dispatcher", displayName: "A" };
const id = "00000000-0000-4000-8000-000000000001";
beforeEach(() => mocks.rpc.mockReset().mockResolvedValue({ data: {}, error: null }));
describe("task workspace service boundary", () => {
  it("attempts immediate assignment delivery after commit while preserving successful save on a retryable handoff failure", async () => {
    mocks.rpc.mockResolvedValue({ data: { id }, error: null });
    mocks.deliver.mockRejectedValueOnce(new Error("temporary push outage"));
    await expect(createWorkspaceTask(actor, { title: "No deadline" })).resolves.toEqual({ id });
    expect(mocks.deliver).toHaveBeenCalledWith({ kind: "admin" }, "org", id);
  });

  it("creates independent tasks through the authenticated actor-scoped transaction", async () => {
    await createWorkspaceTask(actor, { title: "Independent", note: undefined });
    expect(mocks.rpc).toHaveBeenCalledWith("motorist_task_workspace", { p_organization_id: "org", p_actor_profile_id: "a", p_action: "create", p_task_id: null, p_input: { title: "Independent", caseIds: [] } });
  });
  it("requires CAS on edit/delete and ignores injected provenance/author fields", async () => {
    expect(() => updateWorkspaceTask(actor, id, { title: "Unsafe" })).toThrow();
    expect(() => deleteWorkspaceTask(actor, id, undefined)).toThrow();
    await updateWorkspaceTask(actor, id, { expectedRevision: 3, title: "Safe", originLocked: false, organizationId: "elsewhere", createdBy: "spoof" });
    expect(mocks.rpc.mock.calls[0][1].p_input).toEqual({ expectedRevision: 3, title: "Safe" });
  });
  it.each([{ title: "" }, { title: "x", caseIds: [id, id] }, { title: "x", caseIds: ["bad"] }, { title: "x", assignedTo: "bad" }, { title: "x", dueAt: "yesterday" }, { title: "x", priority: "broken" }, { title: "x", reminderChannels: ["sms"] }])("rejects invalid create payload %j before any RPC", input => {
    expect(() => validateTaskInput(input, true)).toThrow(); expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("enforces chat length and idempotent message identity without allowing author override", async () => {
    expect(() => sendTaskMessage(actor, id, { body: "x".repeat(10001), clientMessageId: id })).toThrow();
    expect(() => sendTaskMessage(actor, id, { body: " ", clientMessageId: id })).toThrow();
    await sendTaskMessage(actor, id, { body: " hello ", clientMessageId: id, authorProfileId: "spoof" });
    expect(mocks.rpc.mock.calls[0][1].p_input).toEqual({ body: "hello", clientMessageId: id });
  });
  it("validates both pagination cursor fields", () => {
    expect(() => loadTaskMessages(actor, id, { createdAt: "bad", id })).toThrow();
    expect(() => loadTaskMessages(actor, id, { createdAt: "2026-09-10", id: "bad" })).toThrow();
  });
  it.each([["42501",403],["P0002",404],["PT409",409], ["40001",409],["55000",503]])("preserves %s failure without exposing internal detail", async (code, status) => {
    mocks.rpc.mockResolvedValue({ error: { code, message: "CHAT_PRIVATE_INTERNAL" } });
    await expect(loadWorkspaceTask(actor, id)).rejects.toMatchObject({ status });
    await expect(loadWorkspaceTask(actor, id)).rejects.not.toMatchObject({ message: "CHAT_PRIVATE_INTERNAL" });
  });
});
