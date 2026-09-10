import { describe, expect, it } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
import { taskWorkspaceSystemEnabled } from "./task-system-gate";
describe("server-owned task system writer gate", () => {
  it("keeps legacy writers only for absent/disabled settings", async () => {
    const fake = createFakeSupabase(); expect(await taskWorkspaceSystemEnabled(fake.admin, "org")).toBe(false);
    fake.db.seed("motorist_task_workspace_settings", [{ organization_id: "org", enabled: false }]); expect(await taskWorkspaceSystemEnabled(fake.admin, "org")).toBe(false);
  });
  it("requires verified writer inventory before selecting active compatibility", async () => {
    const fake = createFakeSupabase(); fake.db.seed("motorist_task_workspace_settings", [{ organization_id: "org", enabled: true }]);
    await expect(taskWorkspaceSystemEnabled(fake.admin, "org")).rejects.toThrow("zoznam");
    fake.db.update("motorist_task_workspace_settings", { writer_inventory_verified_at: "2026-09-10", writer_inventory_note: "fixture only" }, () => true);
    expect(await taskWorkspaceSystemEnabled(fake.admin, "org")).toBe(true);
  });
  it("does not silently use legacy writes after a configuration read failure", async () => {
    const fake = createFakeSupabase(); fake.db.failNext("motorist_task_workspace_settings", "select", "unavailable");
    await expect(taskWorkspaceSystemEnabled(fake.admin, "org")).rejects.toThrow("overiť");
  });
});
