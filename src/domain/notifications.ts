import { isTaskOverdue } from "./tasks";
import { MOTORIST_TIME_ZONE } from "./time";
import type { CasePriority, CaseTask, DispatchNotification, NotificationKind, NotificationSeverity, NotificationStatus } from "./types";

export const notificationKindLabels: Record<NotificationKind, string> = {
  task_due: "Pripomienka úlohy",
  task_overdue: "Úloha po termíne",
  handover: "Odovzdanie",
  system: "Systém",
};

export const notificationSeverityLabels: Record<NotificationSeverity, string> = {
  info: "Info",
  warning: "Pozor",
  urgent: "Urgentné",
};

export const notificationSeverityTone: Record<NotificationSeverity, string> = {
  info: "bg-zinc-100 text-zinc-700 ring-zinc-200",
  warning: "bg-orange-100 text-orange-800 ring-orange-200",
  urgent: "bg-red-600 text-white ring-red-600",
};

const severityRank: Record<NotificationSeverity, number> = {
  urgent: 0,
  warning: 1,
  info: 2,
};

export function buildReminderDedupeKey(input: { taskId: string; recipientProfileId?: string | null; scheduledFor: string }) {
  return [input.taskId, input.recipientProfileId || "team", normalizeIso(input.scheduledFor)].join(":");
}

export function buildNotificationDedupeKey(input: { taskId: string; reminderId: string; recipientProfileId?: string | null; scheduledFor: string }) {
  return [input.taskId, input.reminderId, input.recipientProfileId || "team", normalizeIso(input.scheduledFor)].join(":");
}

export function notificationSeverityForTask(task: Pick<CaseTask, "priority" | "dueAt" | "status">, now = new Date()) {
  if (isTaskOverdue(task, now)) {
    return "urgent";
  }

  return severityForPriority(task.priority);
}

export function notificationKindForTask(task: Pick<CaseTask, "kind" | "dueAt" | "status">, now = new Date()): NotificationKind {
  if (task.kind === "handover") {
    return "handover";
  }

  return isTaskOverdue(task, now) ? "task_overdue" : "task_due";
}

export function buildTaskNotificationText(task: Pick<CaseTask, "title" | "dueAt">, caseNumber?: string) {
  const caseLabel = caseNumber ? `${caseNumber}: ` : "";

  return {
    title: `${caseLabel}${task.title}`,
    body: `Termín ${formatDue(task.dueAt)}`,
  };
}

export function isNotificationUnread(notification: Pick<DispatchNotification, "status">) {
  return notification.status === "unread";
}

export function isNotificationSnoozed(
  notification: Pick<DispatchNotification, "snoozedUntil" | "status">,
  now: Date | number = new Date(),
) {
  if (!isNotificationUnread(notification) || !notification.snoozedUntil) {
    return false;
  }

  const snoozedUntil = new Date(notification.snoozedUntil).getTime();
  const currentTime = typeof now === "number" ? now : now.getTime();

  return Number.isFinite(snoozedUntil) && snoozedUntil > currentTime;
}

export function isNotificationReady(
  notification: Pick<DispatchNotification, "snoozedUntil" | "status">,
  now: Date | number = new Date(),
) {
  return isNotificationUnread(notification) && !isNotificationSnoozed(notification, now);
}

export function isNotificationForProfile(
  notification: Pick<DispatchNotification, "recipientProfileId">,
  profileId: string | undefined,
) {
  return Boolean(profileId && notification.recipientProfileId === profileId);
}

export function compareNotifications(left: DispatchNotification, right: DispatchNotification) {
  const unreadDiff = Number(isNotificationUnread(right)) - Number(isNotificationUnread(left));

  if (unreadDiff !== 0) {
    return unreadDiff;
  }

  const severityDiff = severityRank[left.severity] - severityRank[right.severity];

  if (severityDiff !== 0) {
    return severityDiff;
  }

  return dateValue(right.createdAt) - dateValue(left.createdAt);
}

export function notificationStatusLabel(status: NotificationStatus) {
  if (status === "read") return "Prečítané";
  if (status === "archived") return "Archivované";

  return "Nové";
}

export function formatNotificationReminderTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;

  return date.toLocaleString("sk-SK", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: MOTORIST_TIME_ZONE,
  });
}

function severityForPriority(priority: CasePriority): NotificationSeverity {
  if (priority === "urgent") return "urgent";
  if (priority === "high") return "warning";

  return "info";
}

function normalizeIso(value: string) {
  const time = new Date(value).getTime();

  if (!Number.isFinite(time)) {
    return value;
  }

  return new Date(time).toISOString();
}

function formatDue(value: string) {
  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return value;
  }

  return date.toLocaleString("sk-SK", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: MOTORIST_TIME_ZONE,
  });
}

function dateValue(value: string) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}
