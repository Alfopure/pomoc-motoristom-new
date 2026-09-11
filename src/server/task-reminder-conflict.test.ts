import { describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";

const delivery = vi.hoisted(() => ({ push: vi.fn(), email: vi.fn() }));
vi.mock("./web-push", () => ({ sendTaskPush: delivery.push }));
vi.mock("./email-delivery", () => ({ buildAppUrl: (path: string) => path, escapeHtml: (text: string) => text, sendEmail: delivery.email }));
import { materializeDueTaskReminders } from "./task-notifications";

describe("private reminder SQL conflict compatibility", () => {
  it.each(["PT409", "40001"])("%s rejects delivery before email/push and records bounded retry state", async (code) => {
    vi.clearAllMocks();
    const fake = createFakeSupabase();
    fake.db.registerRpc("motorist_claim_task_assignments", () => []);
    fake.db.seed("motorist_case_tasks", [{ id: "task", organization_id: "org", assigned_to: "profile", title: "Synthetic task", status: "open", kind: "other", priority: "normal", reminder_generation: 1, due_at: "2026-09-11T12:00:00Z" }]);
    fake.db.seed("motorist_profiles", [{ id: "profile", organization_id: "org", active: true, role: "dispatcher", email: "synthetic@example.test" }]);
    fake.db.seed("motorist_task_reminders", [{ id: "reminder", organization_id: "org", task_id: "task", case_id: null, status: "pending", recipient_profile_id: "profile", visibility: "private", channels: ["in_app", "email"], scheduled_for: "2026-09-11T12:00:00Z", generation: 1, attempt_count: 0, max_attempts: 3, last_attempt_at: null, payload: { source: "task_default_reminder" } }]);
    fake.db.failNext("motorist_notifications", "upsert", { code, message: "Stale reminder generation or recipient", details: null, hint: null });
    expect(await materializeDueTaskReminders(fake.admin, "org", new Date("2026-09-11T12:01:00Z"))).toMatchObject({ processed: 1, sent: 0 });
    expect(fake.db.rows("motorist_notifications")).toEqual([]);
    expect(fake.db.rows("motorist_task_reminders")[0]).toMatchObject({ status: "pending", attempt_count: 1, last_error: "Stale reminder generation or recipient" });
    expect(delivery.push).not.toHaveBeenCalled();
    expect(delivery.email).not.toHaveBeenCalled();
  });
});
