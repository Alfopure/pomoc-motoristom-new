import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ rpc: mocks.rpc }) }));
import { taskWorkflowEnabled, transitionWorkspaceTask, validateTaskWorkflowCommand } from "./task-workflow";
const actor = { organizationId: "org", profileId: "actor" };
const id = "00000000-0000-4000-8000-000000000001";
const commandId = "00000000-0000-4000-8000-000000000002";
const reviewerProfileId = "00000000-0000-4000-8000-000000000003";
const command = { action: "submit_review", expectedRevision: 4, commandId, reviewerProfileId, comment: "Skontrolujte podpis" };
const receipt = { task: { id, revision: 5, status: "open", workflowVersion: 1, workflowState: "in_review" }, commandId, committedRevision: 5 };
beforeEach(() => mocks.rpc.mockReset().mockResolvedValue({ data: receipt, error: null }));

describe("authenticated task workflow service", () => {
  it("sends only validated command fields and the real actor through one transaction", async () => {
    await expect(transitionWorkspaceTask(actor, id, { ...command, comment: "  Skontrolujte podpis  ", actorProfileId: "forged", status: "done", dueAt: "2000-01-01", organizationId: "other", reviewedBy: "forged" })).resolves.toEqual(receipt);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("motorist_task_workflow", { p_organization_id: "org", p_actor_profile_id: "actor", p_task_id: id, p_input: command });
  });
  it.each([
    { action: "unknown" }, { action: null }, { expectedRevision: undefined }, { expectedRevision: 1.5 }, { expectedRevision: 0 }, { expectedRevision: 2_147_483_648 },
    { commandId: "missing" }, { reviewerProfileId: null }, { reviewerProfileId: "unassigned" }, { comment: " " }, { comment: 3 }, { comment: "x".repeat(10_001) },
  ])("rejects invalid command %j before contacting the database", async patch => {
    await expect(transitionWorkspaceTask(actor, id, { ...command, ...patch })).rejects.toMatchObject({ status: 400 });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("requires a return reason and ignores reviewer injection in ordinary transitions", () => {
    expect(() => validateTaskWorkflowCommand({ action: "return", commandId, expectedRevision: 4 })).toThrow("dôvod");
    expect(validateTaskWorkflowCommand({ action: "approve", commandId, expectedRevision: 4, reviewerProfileId: "forged" })).toEqual({ action: "approve", commandId, expectedRevision: 4 });
  });
  it.each([
    null, {}, { ...receipt, commandId: id }, { ...receipt, committedRevision: 0 }, { ...receipt, committedRevision: 6 },
    { ...receipt, task: { id: reviewerProfileId, revision: 5 } }, { ...receipt, task: { id, revision: "5" } },
  ])("treats a malformed receipt as uncertain instead of reporting a successful save", async data => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    await expect(transitionWorkspaceTask(actor, id, command)).rejects.toMatchObject({ status: 503 });
  });
  it("accepts the latest canonical revision alongside an earlier stable command receipt", async () => {
    const later = { ...receipt, task: { ...receipt.task, revision: 8, status: "done", workflowState: "done" } };
    mocks.rpc.mockResolvedValue({ data: later, error: null });
    await expect(transitionWorkspaceTask(actor, id, command)).resolves.toEqual(later);
  });
  it.each([["42501", 403], ["P0002", 404], ["PT409", 409], ["40001", 409], ["55000", 503], ["PGRST202", 503], ["22023", 400]])("maps %s without exposing private database details", async (code, status) => {
    mocks.rpc.mockResolvedValue({ error: { code, message: "PRIVATE_DATABASE_DETAIL" } });
    await expect(transitionWorkspaceTask(actor, id, command)).rejects.toMatchObject({ status });
    await expect(transitionWorkspaceTask(actor, id, command)).rejects.not.toMatchObject({ message: "PRIVATE_DATABASE_DETAIL" });
  });
  it("explains the review requirement and invalid reviewer without disclosing who exists", async () => {
    mocks.rpc.mockResolvedValue({ error: { code: "22023", message: "Task review required" } });
    await expect(transitionWorkspaceTask(actor, id, command)).rejects.toThrow("vyžaduje kontrolu");
    mocks.rpc.mockResolvedValue({ error: { code: "22023", message: "Invalid task reviewer" } });
    await expect(transitionWorkspaceTask(actor, id, command)).rejects.toThrow("aktívneho kolegu");
  });
});

describe("task workflow rollout capability", () => {
  it("uses an authenticated actor probe and requires a true server flag", async () => {
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    await expect(taskWorkflowEnabled(actor)).resolves.toBe(true);
    expect(mocks.rpc).toHaveBeenCalledWith("motorist_task_workflow_enabled", { p_organization_id: "org", p_actor_profile_id: "actor" });
    mocks.rpc.mockResolvedValue({ data: "true", error: null });
    await expect(taskWorkflowEnabled(actor)).resolves.toBe(false);
  });
  it.each(["PGRST202", "42883"])("treats missing schema %s as unavailable", async code => {
    mocks.rpc.mockResolvedValue({ error: { code } });
    await expect(taskWorkflowEnabled(actor)).resolves.toBe(false);
  });
  it("does not turn permission or connection failure into a working fallback", async () => {
    mocks.rpc.mockResolvedValue({ error: { code: "42501" } });
    await expect(taskWorkflowEnabled(actor)).rejects.toMatchObject({ status: 403 });
    mocks.rpc.mockResolvedValue({ error: { code: "XX000" } });
    await expect(taskWorkflowEnabled(actor)).rejects.toMatchObject({ status: 503 });
  });
});
