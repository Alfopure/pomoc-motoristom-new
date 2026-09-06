import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/lib/supabase/database.types";
import { createTaskAssignmentNotification, materializeDueTaskReminders } from "./task-notifications";

const { sendTaskPush } = vi.hoisted(() => ({ sendTaskPush: vi.fn() }));
vi.mock("./web-push", () => ({ sendTaskPush }));
vi.mock("./email-delivery", () => ({ buildAppUrl: () => "/", escapeHtml: (s: string) => s, sendEmail: vi.fn() }));

function database(results: unknown[]) {
  return { from() {
    if (!results.length) throw new Error("Unexpected database query");
    const data = results.shift();
    const chain = new Proxy({}, { get(_target, prop) {
      if (prop === "then") return (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve);
      return () => chain;
    } });
    return chain;
  } } as unknown as SupabaseClient<Database>;
}

const task = {
  id: "task-a", assigned_to: "profile-a", created_at: "2026-09-06T10:00:00Z", due_at: "2026-09-06T11:00:00Z",
  kind: "other" as const, priority: "normal" as const, status: "open" as const, title: "Zavolať", updated_at: "2026-09-06T10:00:00Z",
};
const input = { organizationId: "org-a", caseId: "case-a", task };
beforeEach(() => sendTaskPush.mockReset().mockResolvedValue({ sent: 1, failed: 0 }));

describe("notification push handoff", () => {
  it("sends only after a newly inserted assignment notification", async () => {
    const db = database([{ case_number: "P-123" }, { id: "notification-a" }]);
    expect(await createTaskAssignmentNotification(db, input)).toEqual({ id: "notification-a" });
    expect(sendTaskPush).toHaveBeenCalledWith(db, expect.objectContaining({
      organizationId: "org-a", recipientProfileId: "profile-a", notificationId: "notification-a", taskId: "task-a", title: "P-123: nová pridelená úloha",
    }));
  });

  it("does not resend push when database deduplication ignored a duplicate assignment", async () => {
    await createTaskAssignmentNotification(database([{ case_number: "P-123" }, null]), input);
    expect(sendTaskPush).not.toHaveBeenCalled();
  });

  it("keeps assignment successful when push is unavailable", async () => {
    sendTaskPush.mockResolvedValue({ sent: 0, failed: 1 });
    expect(await createTaskAssignmentNotification(database([{ case_number: "P-123" }, { id: "notification-a" }]), input)).toEqual({ id: "notification-a" });
  });

  it("delivers due reminders through the same push path exactly once", async () => {
    const reminder = {
      id: "reminder-a", task_id: "task-a", case_id: "case-a", recipient_profile_id: "profile-a", visibility: "private",
      channels: ["in_app"], scheduled_for: "2026-09-06T11:00:00Z", attempt_count: 0, last_attempt_at: null,
    };
    const db = database([null, [reminder], [task], [{ id: "case-a", case_number: "P-123" }], [{ id: "profile-a" }], { id: "reminder-a" }, { id: "notification-a" }, null]);
    expect(await materializeDueTaskReminders(db, "org-a", new Date("2026-09-06T11:01:00Z"))).toMatchObject({ sent: 1, failed: 0 });
    expect(sendTaskPush).toHaveBeenCalledExactlyOnceWith(db, expect.objectContaining({ notificationId: "notification-a", recipientProfileId: "profile-a" }));
  });

  it("does not resend a previously materialized due reminder", async () => {
    const reminder = { id: "reminder-a", task_id: "task-a", case_id: "case-a", recipient_profile_id: "profile-a", visibility: "private", channels: ["in_app"], scheduled_for: task.due_at, attempt_count: 0, last_attempt_at: null };
    const db = database([null, [reminder], [task], [{ id: "case-a" }], [{ id: "profile-a" }], { id: "reminder-a" }, null, null]);
    await materializeDueTaskReminders(db, "org-a", new Date("2026-09-06T11:01:00Z"));
    expect(sendTaskPush).not.toHaveBeenCalled();
  });
});
