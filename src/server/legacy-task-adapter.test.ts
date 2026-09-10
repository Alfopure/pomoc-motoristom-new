import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  capabilities: vi.fn(), create: vi.fn(), get: vi.fn(), update: vi.fn(), remove: vi.fn(),
}));
vi.mock("./workspace-capabilities", () => ({ loadWorkspaceCapabilities: mocks.capabilities }));
vi.mock("./tasks", () => ({ createWorkspaceTask: mocks.create, loadWorkspaceTask: mocks.get, updateWorkspaceTask: mocks.update, deleteWorkspaceTask: mocks.remove }));
import { runCompatibleCaseTaskAction } from "./legacy-task-adapter";
beforeEach(() => {
  vi.clearAllMocks(); mocks.capabilities.mockResolvedValue({ tasks: true });
  mocks.get.mockResolvedValue({ caseIds: ["case"], revision: 4 });
});
describe("legacy case task adapter", () => {
  it("passes actor, exact context and revision without trusting case URL alone", async () => {
    await runCompatibleCaseTaskAction("org", "actor", "case", { action: "complete_task", taskId: "task", taskExpectedRevision: 4 });
    expect(mocks.update).toHaveBeenCalledWith({ organizationId: "org", profileId: "actor" }, "task", { expectedRevision: 4, status: "done" });
    mocks.get.mockResolvedValueOnce({ caseIds: ["other"] });
    await expect(runCompatibleCaseTaskAction("org", "actor", "case", { action: "delete_task", taskId: "task", taskExpectedRevision: 4 })).rejects.toMatchObject({ status: 404 });
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("retains explicit reminder channels and deletion audit note", async () => {
    await runCompatibleCaseTaskAction("org", "actor", "case", { action: "update_task", taskId: "task", taskExpectedRevision: 4, taskReminderChannels: ["email"] });
    expect(mocks.update.mock.calls[0][2]).toEqual({ expectedRevision: 4, reminderChannels: ["email"] });
    await runCompatibleCaseTaskAction("org", "actor", "case", { action: "delete_task", taskId: "task", taskExpectedRevision: 4, note: "duplicate" });
    expect(mocks.remove).toHaveBeenCalledWith({ organizationId: "org", profileId: "actor" }, "task", 4, "duplicate");
  });
  it("returns to old workflow only for disabled capability, never on a failed probe", async () => {
    mocks.capabilities.mockResolvedValueOnce({ tasks: false });
    await expect(runCompatibleCaseTaskAction("org", "actor", "case", { action: "create_task" })).resolves.toBe(false);
    mocks.capabilities.mockRejectedValueOnce(new Error("temporary"));
    await expect(runCompatibleCaseTaskAction("org", "actor", "case", { action: "delete_task", taskId: "task" })).rejects.toThrow("temporary");
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  });
});
