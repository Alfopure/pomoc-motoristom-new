import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
const mocks = vi.hoisted(() => ({ admin: vi.fn(), capabilities: vi.fn(), create: vi.fn(), get: vi.fn(), update: vi.fn(), remove: vi.fn(), actor: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
vi.mock("./workspace-capabilities", () => ({ loadWorkspaceCapabilities: mocks.capabilities }));
vi.mock("./api-auth", () => ({ requireMotoristActor: mocks.actor }));
vi.mock("./tasks", () => ({ createWorkspaceTask: mocks.create, loadWorkspaceTask: mocks.get, updateWorkspaceTask: mocks.update, deleteWorkspaceTask: mocks.remove, TASK_WORKSPACE_ROLES: ["dispatcher"] }));
vi.mock("./task-notifications", () => ({ createDefaultTaskReminder: vi.fn(), createTaskAssignmentNotification: vi.fn(), cancelPendingTaskReminders: vi.fn(), markTaskNotificationsRead: vi.fn(), archiveTaskNotifications: vi.fn() }));
import { assignCase, runCaseAction } from "./motorist-mutations";
function setup() {
  const fake = createFakeSupabase(); mocks.admin.mockReturnValue(fake.admin);
  fake.db.seed("motorist_organizations", [{ id: "org", slug: "pomoc-motoristom", active: true }]);
  fake.db.seed("motorist_profiles", [{ id: "actor", organization_id: "org", active: true }]);
  fake.db.seed("motorist_cases", [{ id: "case", organization_id: "org", owner_id: "actor", pickup_location_id: "pickup", status: "new", job_types: [] }]);
  fake.db.seed("motorist_fleet_assets", [{ id: "asset", organization_id: "org", kind: "tow_truck", active: true }]);
  return fake;
}
function writes(fake: ReturnType<typeof setup>) { return fake.db.log.filter(entry => ["insert", "update", "delete", "upsert"].includes(entry.operation ?? "")); }
beforeEach(() => {
  vi.clearAllMocks(); mocks.capabilities.mockResolvedValue({ tasks: true });
  mocks.actor.mockResolvedValue({ profileId: "actor", organizationId: "org" });
  mocks.get.mockResolvedValue({ caseIds: ["case"] });
  mocks.update.mockResolvedValue({}); mocks.remove.mockResolvedValue({ deleted: true });
  mocks.create.mockResolvedValue({ id: "task", caseId: "case", assignedTo: "actor", updatedAt: "2026-09-10T00:00:00Z" });
});
describe("task integration gates before legacy effects", () => {
  it.each(["complete_task", "delete_task"] as const)("%s uses only the task transaction", async action => {
    const fake = setup();
    await runCaseAction("case", { action, taskId: "task", taskExpectedRevision: 4 }, "actor");
    expect(writes(fake)).toEqual([]);
    expect(action === "complete_task" ? mocks.update : mocks.remove).toHaveBeenCalledTimes(1);
  });
  it.each(["complete_task", "delete_task", "invoice"] as const)("%s stops on capability failure before reminders, events or task writes", async action => {
    const fake = setup(); mocks.capabilities.mockRejectedValue(new Error("unavailable"));
    await expect(runCaseAction("case", { action, taskId: "task", taskExpectedRevision: 4 }, "actor")).rejects.toThrow("unavailable");
    expect(writes(fake)).toEqual([]);
  });
  it("preflights assignment before changing case, vehicle or timeline", async () => {
    const fake = setup(); mocks.capabilities.mockRejectedValue(new Error("unavailable"));
    await expect(assignCase("case", { assetId: "asset" }, "actor")).rejects.toThrow("unavailable");
    expect(writes(fake)).toEqual([]);
  });
  it("rejects a substituted creator before assignment side effects", async () => {
    const fake = setup(); mocks.actor.mockResolvedValue({ profileId: "other", organizationId: "org" });
    await expect(assignCase("case", { assetId: "asset" }, "actor")).rejects.toMatchObject({ status: 403 });
    expect(writes(fake)).toEqual([]);
  });
  it("carries the successful preflight into shared insertion without a second capability probe", async () => {
    const fake = setup();
    await assignCase("case", { assetId: "asset" }, "actor");
    expect(mocks.capabilities).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith({ organizationId: "org", profileId: "actor" }, expect.objectContaining({ caseIds: ["case"], kind: "sms" }));
    expect(writes(fake).filter(entry => entry.table === "motorist_case_tasks")).toEqual([]);
  });
});
