import type { CasePriority, CaseTask, CaseTaskKind } from "./types";

export type TaskView = "mine" | "team" | "today" | "overdue" | "handover" | "done";

export const taskKinds = ["callback", "sms", "dispatch", "documents", "billing", "handover", "other"] as const satisfies readonly CaseTaskKind[];
export const taskPriorities = ["urgent", "high", "normal", "low"] as const satisfies readonly CasePriority[];

export const taskKindLabels: Record<CaseTaskKind, string> = {
  callback: "Zavolať naspäť",
  sms: "SMS",
  dispatch: "Dispečing",
  documents: "Doklady",
  billing: "Fakturácia",
  handover: "Odovzdanie",
  other: "Iné",
};

export const taskPriorityLabels: Record<CasePriority, string> = {
  urgent: "Horí",
  high: "Vysoká",
  normal: "Bežná",
  low: "Nízka",
};

export const taskPriorityTone: Record<CasePriority, string> = {
  urgent: "bg-red-600 text-white",
  high: "bg-orange-500 text-white",
  normal: "bg-zinc-800 text-white",
  low: "bg-zinc-200 text-zinc-700",
};

const priorityRank: Record<CasePriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export function isTaskOpen(task: Pick<CaseTask, "status">) {
  return task.status !== "done";
}

export function isTaskOverdue(task: Pick<CaseTask, "dueAt" | "status">, now = new Date()) {
  return isTaskOpen(task) && (task.status === "overdue" || dateValue(task.dueAt) < now.getTime());
}

export function isTaskDueToday(task: Pick<CaseTask, "dueAt" | "status">, now = new Date()) {
  if (!isTaskOpen(task)) {
    return false;
  }

  const due = new Date(task.dueAt);

  return due.getFullYear() === now.getFullYear() && due.getMonth() === now.getMonth() && due.getDate() === now.getDate();
}

export function isTaskHandoverRelevant(task: Pick<CaseTask, "assignedTo" | "dueAt" | "status">, now = new Date()) {
  if (!isTaskOpen(task)) {
    return false;
  }

  const due = dateValue(task.dueAt);
  const twoHoursFromNow = now.getTime() + 2 * 60 * 60_000;

  return task.assignedTo === "unassigned" || due <= twoHoursFromNow;
}

export function taskStatusLabel(task: Pick<CaseTask, "dueAt" | "status">, now = new Date()) {
  if (task.status === "done") {
    return "Vybavené";
  }

  if (task.status === "overdue") {
    return "Po termíne";
  }

  return isTaskOverdue(task, now) ? "Po termíne" : "Otvorená";
}

export function compareOperationalTasks<T extends Pick<CaseTask, "dueAt" | "priority" | "status">>(left: T, right: T, now = new Date()) {
  const overdueDiff = Number(isTaskOverdue(right, now)) - Number(isTaskOverdue(left, now));

  if (overdueDiff !== 0) {
    return overdueDiff;
  }

  const priorityDiff = priorityRank[left.priority] - priorityRank[right.priority];

  if (priorityDiff !== 0) {
    return priorityDiff;
  }

  return dateValue(left.dueAt) - dateValue(right.dueAt);
}

export function defaultTaskTitle(kind: CaseTaskKind) {
  if (kind === "callback") return "Zavolať zákazníkovi";
  if (kind === "sms") return "Poslať SMS";
  if (kind === "dispatch") return "Doriešiť dispečing";
  if (kind === "documents") return "Doplniť doklady";
  if (kind === "billing") return "Skontrolovať fakturáciu";
  if (kind === "handover") return "Odovzdať prípad";

  return "Nová úloha";
}

function dateValue(value: string) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}
