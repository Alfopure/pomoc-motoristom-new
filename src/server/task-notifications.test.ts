import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
import type { Database } from "@/lib/supabase/database.types";
import { createDefaultTaskReminder, createTaskAssignmentNotification, deliverTaskAssignmentNotifications, isCurrentTaskReminder, materializeDueTaskReminders } from "./task-notifications";

const { sendTaskPush, sendEmail } = vi.hoisted(() => ({ sendTaskPush: vi.fn(), sendEmail: vi.fn() }));
vi.mock("./web-push", () => ({ sendTaskPush }));
vi.mock("./email-delivery", () => ({ buildAppUrl: (path: string) => path, escapeHtml: (s: string) => s, sendEmail }));

function database(results: unknown[], writes: { table: string; payload: Record<string, unknown> }[] = []) {
  return { rpc(name: string) { if (name === "motorist_claim_task_assignments") return Promise.resolve({ data: [], error: null }); if (!results.length) throw new Error("Unexpected database RPC"); return Promise.resolve({ data: results.shift(), error: null }); }, from(table: string) {
    if (!results.length) throw new Error("Unexpected database query");
    const data = results.shift();
    const chain = new Proxy({}, { get(_target, prop) {
      if (prop === "then") return (resolve: (value: unknown) => unknown) => Promise.resolve(data && typeof data === "object" && "error" in data ? data : { data, error: null }).then(resolve);
      if (prop === "upsert" || prop === "update") return (payload: Record<string, unknown>) => { writes.push({ table, payload }); return chain; };
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
beforeEach(() => { sendTaskPush.mockReset().mockResolvedValue({ sent: 1, failed: 0 }); sendEmail.mockReset().mockResolvedValue({ status: "sent", provider: "test", messageId: "email-1" }); });

describe("notification push handoff", () => {
  it("the existing reminder/cron entry point drains assignment jobs even when no reminder is due", async () => {
    const fake = createFakeSupabase();
    fake.db.registerRpc("motorist_claim_task_assignments", () => [{ notificationId: "notice", taskId: "task", recipientProfileId: "senior", leaseId: "lease", title: "Assigned", body: "No deadline" }]);
    const finish = vi.fn(() => true);
    fake.db.registerRpc("motorist_finish_task_assignment", finish);
    await expect(materializeDueTaskReminders(fake.admin, "org")).resolves.toMatchObject({ processed: 0 });
    expect(sendTaskPush).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ p_success: true }), fake.db);
  });

  it("delegates assignment event creation to the transaction-owned generation bridge", async () => {
    const rpc = vi.fn(async (name: string) => ({ data: name === "motorist_ensure_task_assignment" ? { id: "notification-a" } : [], error: null }));
    const db = { rpc } as unknown as SupabaseClient<Database>;
    expect(await createTaskAssignmentNotification(db, input)).toEqual({ id: "notification-a" });
    expect(rpc).toHaveBeenCalledWith("motorist_ensure_task_assignment", { p_organization_id: "org-a", p_task_id: "task-a" });
    expect(sendTaskPush).not.toHaveBeenCalled();
  });

  it("delivers an assignment lease without a due date and acknowledges its stable notification", async () => {
    const job = { notificationId: "notice", taskId: "task", recipientProfileId: "senior", leaseId: "lease", title: "Nová pridelená úloha", body: "Call" };
    const rpc = vi.fn(async (name: string) => ({ data: name === "motorist_claim_task_assignments" ? [job] : true, error: null }));
    const db = { rpc } as unknown as SupabaseClient<Database>;
    expect(await deliverTaskAssignmentNotifications(db, "org")).toEqual({ processed: 1, sent: 1, failed: 0 });
    expect(sendTaskPush).toHaveBeenCalledExactlyOnceWith(db, { organizationId: "org", recipientProfileId: "senior", notificationId: "notice", taskId: "task", title: job.title, body: "Call" });
    expect(rpc).toHaveBeenLastCalledWith("motorist_finish_task_assignment", { p_organization_id: "org", p_notification_id: "notice", p_lease_id: "lease", p_success: true });
  });

  it("keeps push failure retryable and does not insert another bell on retry", async () => {
    const job = { notificationId: "notice", taskId: "task", recipientProfileId: "profile", leaseId: "lease", title: "New", body: "Task" };
    const rpc = vi.fn(async (name: string) => ({ data: name === "motorist_claim_task_assignments" ? [job] : true, error: null }));
    const db = { rpc } as unknown as SupabaseClient<Database>;
    sendTaskPush.mockResolvedValueOnce({ sent: 0, failed: 1 });
    expect(await deliverTaskAssignmentNotifications(db, "org")).toMatchObject({ failed: 1 });
    expect(rpc).toHaveBeenLastCalledWith("motorist_finish_task_assignment", expect.objectContaining({ p_success: false }));
    expect(await deliverTaskAssignmentNotifications(db, "org")).toMatchObject({ sent: 1 });
    expect(sendTaskPush.mock.calls.map(call => call[1].notificationId)).toEqual(["notice", "notice"]);
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


describe("private reminder generations", () => {
  it("materializes a team reminder for active senior dispatchers and excludes unsupported or inactive profiles", async () => {
    const fake = createFakeSupabase();
    fake.db.registerRpc("motorist_claim_task_assignments", () => []);
    fake.db.seed("motorist_case_tasks", [{ ...task, organization_id: "org-a", assigned_to: null, reminder_generation: 0 }]);
    fake.db.seed("motorist_profiles", [
      { id: "senior", organization_id: "org-a", role: "senior_dispatcher", active: true },
      { id: "inactive", organization_id: "org-a", role: "senior_dispatcher", active: false },
      { id: "driver", organization_id: "org-a", role: "driver", active: true },
    ]);
    fake.db.seed("motorist_task_reminders", [{ id: "team-reminder", organization_id: "org-a", task_id: task.id, case_id: null,
      recipient_profile_id: null, visibility: "team", channels: ["in_app"], scheduled_for: task.due_at, status: "pending",
      generation: 0, attempt_count: 0, max_attempts: 5, last_attempt_at: null }]);
    expect(await materializeDueTaskReminders(fake.admin, "org-a", new Date("2026-09-06T11:01:00Z"))).toMatchObject({ sent: 1 });
    expect(fake.db.rows("motorist_notifications").map(row => row.recipient_profile_id)).toEqual(["senior"]);
    expect(sendTaskPush).toHaveBeenCalledExactlyOnceWith(fake.admin, expect.objectContaining({ recipientProfileId: "senior" }));
  });

  const reminder = { id: "reminder-a", task_id: "task-a", case_id: null, recipient_profile_id: "profile-a", visibility: "private", channels: ["in_app"], scheduled_for: task.due_at, attempt_count: 0, last_attempt_at: null, generation: 2, payload: { source: "task_default_reminder" } };
  const liveTask = { ...task, reminder_generation: 2 };
  it("uses the transaction-owned generation bridge, never an ad-hoc retry key", async () => {
    const rpc = vi.fn(async () => ({ data: [{ id: "stable-generation" }], error: null }));
    const db = { rpc } as unknown as SupabaseClient<Database>;
    await createDefaultTaskReminder(db, { organizationId: "org-a", caseId: null, task, createdBy: "profile-a", channels: ["email", "in_app"] });
    expect(rpc).toHaveBeenCalledWith("motorist_ensure_task_reminders", { p_organization_id: "org-a", p_task_id: "task-a", p_actor_id: "profile-a", p_channels: ["email", "in_app"] });
  });

  it("creates separate private deliveries for recipients of a case-free team task", async () => {
    const writes: { table: string; payload: Record<string, unknown> }[] = [];
    const db = database([null, [{ ...reminder, visibility: "team", recipient_profile_id: null }], [{ ...liveTask, assigned_to: null }], [{ id: "profile-a" }, { id: "profile-b" }], { id: "reminder-a" }, { id: "notification-a" }, { id: "notification-b" }, null], writes);
    expect(await materializeDueTaskReminders(db, "org-a", new Date("2026-09-06T11:01:00Z"))).toMatchObject({ sent: 1, failed: 0 });
    const inserted = writes.filter(write => write.table === "motorist_notifications").map(write => write.payload);
    expect(inserted).toHaveLength(2);
    expect(inserted.map(row => row.recipient_profile_id)).toEqual(["profile-a", "profile-b"]);
    expect(inserted.every(row => row.visibility === "private" && row.case_id === null)).toBe(true);
    expect(inserted[0].dedupe_key).not.toBe(inserted[1].dedupe_key);
    expect(sendTaskPush).toHaveBeenCalledTimes(2);
    expect(sendTaskPush.mock.calls.map(call => call[1].recipientProfileId)).toEqual(["profile-a", "profile-b"]);
  });

  it("does not resend either recipient on retry of the same team generation", async () => {
    const db = database([null, [{ ...reminder, visibility: "team", recipient_profile_id: null }], [{ ...liveTask, assigned_to: null }], [{ id: "profile-a" }, { id: "profile-b" }], { id: "reminder-a" }, null, null, null]);
    await materializeDueTaskReminders(db, "org-a", new Date("2026-09-06T11:01:00Z"));
    expect(sendTaskPush).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it.each([
    { ...liveTask, reminder_generation: 3 },
    { ...liveTask, status: "done" },
    { ...liveTask, assigned_to: "profile-b" },
    { ...liveTask, due_at: "2026-09-07T11:00:00Z" },
  ])("cancels stale task state before locking or delivering", async (changedTask) => {
    const db = database([null, [reminder], [changedTask], [{ id: "profile-a" }], null]);
    expect(await materializeDueTaskReminders(db, "org-a", new Date("2026-09-06T11:01:00Z"))).toMatchObject({ cancelled: 1, sent: 0 });
    expect(sendTaskPush).not.toHaveBeenCalled();
  });

  it("SQL rejection of a concurrent reassignment prevents email and push", async () => {
    const db = database([null, [{ ...reminder, channels: ["in_app", "email"] }], [liveTask], [{ id: "profile-a", email: "test@example.test" }], { id: "reminder-a" }, { data: null, error: { code: "40001", message: "Stale reminder generation" } }, null]);
    await materializeDueTaskReminders(db, "org-a", new Date("2026-09-06T11:01:00Z"));
    expect(sendEmail).not.toHaveBeenCalled(); expect(sendTaskPush).not.toHaveBeenCalled();
  });

  it("links email directly to the task after authorized insert, including without a case", async () => {
    const db = database([null, [{ ...reminder, channels: ["in_app", "email"] }], [liveTask], [{ id: "profile-a", email: "test@example.test" }], { id: "reminder-a" }, { id: "notification-a" }, null, null]);
    await materializeDueTaskReminders(db, "org-a", new Date("2026-09-06T11:01:00Z"));
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "test@example.test", text: expect.stringContaining("/?task=task-a") }));
    expect(sendTaskPush).toHaveBeenCalledOnce();
  });

  it("allows a deliberate custom reminder time while still enforcing lifecycle generation", () => {
    expect(isCurrentTaskReminder({ ...reminder, visibility: "private", scheduled_for: "2026-09-06T10:45:00Z", payload: { source: "task_custom_reminder" } }, { ...liveTask, reminder_at: "2026-09-06T10:45:00Z" })).toBe(true);
  });
  it("ensures an independent reminder even when the task has no deadline", async () => {
    const rpc = vi.fn(async () => ({ data: [], error: null }));
    await createDefaultTaskReminder({ rpc } as unknown as SupabaseClient<Database>, { organizationId: "org-a", caseId: null, task: { ...task, due_at: null, reminder_at: "2026-09-06T10:45:00Z" } });
    expect(rpc).toHaveBeenCalledOnce();
  });

  it("invalidates the old custom reminder when only its independent time changed", () => {
    expect(isCurrentTaskReminder({ ...reminder, visibility: "private", payload: { source: "task_custom_reminder" } }, { ...liveTask, reminder_at: "2026-09-06T10:45:00Z" })).toBe(false);
  });

});
