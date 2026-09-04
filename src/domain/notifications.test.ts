import { describe, expect, it } from "vitest";
import type { CaseTask, DispatchNotification } from "./types";
import {
  buildTaskNotificationText,
  buildNotificationDedupeKey,
  buildReminderDedupeKey,
  compareNotifications,
  isNotificationForProfile,
  isNotificationReady,
  isNotificationSnoozed,
  isNotificationUnread,
  notificationKindForTask,
  notificationSeverityForTask,
} from "./notifications";

const now = new Date("2026-06-08T10:00:00.000Z");

function task(overrides: Partial<CaseTask> = {}): CaseTask {
  return {
    id: "task-1",
    caseId: "case-1",
    title: "Zavolať zákazníkovi",
    assignedTo: "operator-1",
    dueAt: "2026-06-08T11:00:00.000Z",
    status: "open",
    priority: "normal",
    kind: "callback",
    ...overrides,
  };
}

function notification(overrides: Partial<DispatchNotification> = {}): DispatchNotification {
  return {
    id: "notification-1",
    visibility: "team",
    kind: "task_due",
    severity: "info",
    title: "Úloha",
    status: "unread",
    deliveryStatus: "in_app",
    dedupeKey: "dedupe",
    createdAt: "2026-06-08T10:00:00.000Z",
    updatedAt: "2026-06-08T10:00:00.000Z",
    ...overrides,
  };
}

describe("notification domain rules", () => {
  it("does not expose the internal task type in notification text", () => {
    const text = buildTaskNotificationText(task({ kind: "callback" }), "PM-123");

    expect(text.title).toBe("PM-123: Zavolať zákazníkovi");
    expect(text.body).toMatch(/^Termín /);
    expect(text.body).not.toContain("Spätné volanie");
  });

  it("builds stable reminder and notification dedupe keys from normalized time", () => {
    expect(buildReminderDedupeKey({ taskId: "task-1", recipientProfileId: "op-1", scheduledFor: "2026-06-08T12:00:00+02:00" })).toBe(
      "task-1:op-1:2026-06-08T10:00:00.000Z",
    );
    expect(buildNotificationDedupeKey({ taskId: "task-1", reminderId: "rem-1", recipientProfileId: null, scheduledFor: "2026-06-08T10:00:00.000Z" })).toBe(
      "task-1:rem-1:team:2026-06-08T10:00:00.000Z",
    );
  });

  it("derives kind and severity from task state", () => {
    expect(notificationKindForTask(task({ kind: "handover" }), now)).toBe("handover");
    expect(notificationKindForTask(task({ dueAt: "2026-06-08T09:59:00.000Z" }), now)).toBe("task_overdue");
    expect(notificationSeverityForTask(task({ priority: "high" }), now)).toBe("warning");
    expect(notificationSeverityForTask(task({ priority: "low", dueAt: "2026-06-08T09:59:00.000Z" }), now)).toBe("urgent");
  });

  it("sorts unread urgent notifications before older low-signal items", () => {
    const ordered = [
      notification({ id: "read-urgent", status: "read", severity: "urgent", createdAt: "2026-06-08T10:10:00.000Z" }),
      notification({ id: "unread-info", severity: "info", createdAt: "2026-06-08T10:20:00.000Z" }),
      notification({ id: "unread-urgent", severity: "urgent", createdAt: "2026-06-08T10:00:00.000Z" }),
    ].sort(compareNotifications);

    expect(isNotificationUnread(ordered[0])).toBe(true);
    expect(ordered.map((item) => item.id)).toEqual(["unread-urgent", "unread-info", "read-urgent"]);
  });

  it("matches only a notification explicitly assigned to the logged-in profile", () => {
    expect(isNotificationForProfile(notification({ recipientProfileId: "operator-1", visibility: "private" }), "operator-1")).toBe(true);
    expect(isNotificationForProfile(notification({ recipientProfileId: "operator-2", visibility: "private" }), "operator-1")).toBe(false);
    expect(isNotificationForProfile(notification({ recipientProfileId: undefined, visibility: "team" }), "operator-1")).toBe(false);
    expect(isNotificationForProfile(notification({ recipientProfileId: "operator-1", visibility: "private" }), undefined)).toBe(false);
  });

  it("keeps a snoozed unread notification inactive until its selected time", () => {
    const snoozed = notification({ snoozedUntil: "2026-06-08T10:30:00.000Z" });

    expect(isNotificationUnread(snoozed)).toBe(true);
    expect(isNotificationSnoozed(snoozed, now)).toBe(true);
    expect(isNotificationReady(snoozed, now)).toBe(false);
    expect(isNotificationSnoozed(snoozed, new Date("2026-06-08T10:30:00.000Z"))).toBe(false);
    expect(isNotificationReady(snoozed, new Date("2026-06-08T10:30:00.000Z"))).toBe(true);
    expect(isNotificationSnoozed({ ...snoozed, status: "read" }, now)).toBe(false);
  });
});
