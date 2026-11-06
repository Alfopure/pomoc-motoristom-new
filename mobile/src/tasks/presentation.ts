import type { EmployeeTask } from "../../../src/lib/mobile-task-workspace";

export const taskStateLabels: Record<EmployeeTask["state"], string> = {
  todo: "Na vybavenie", in_progress: "Rozpracované", in_review: "Na kontrolu", done: "Hotovo",
};
export const taskPriorityLabels: Record<EmployeeTask["priority"], string> = {
  urgent: "Súrna", high: "Vysoká", normal: "Bežná", low: "Nízka",
};
const sameDay = (left: Date, right: Date) => left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
export function taskDueLabel(value: string | null, now = new Date()): string {
  if (!value) return "Bez termínu";
  const date = new Date(value), tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const day = sameDay(date, now) ? "Dnes" : sameDay(date, tomorrow) ? "Zajtra" : date.toLocaleDateString("sk-SK", { day: "numeric", month: "short", ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
  return day + " · " + date.toLocaleTimeString("sk-SK", { hour: "2-digit", minute: "2-digit" });
}
export function taskOverdue(task: Pick<EmployeeTask, "state" | "dueAt">, now = Date.now()) {
  return task.state !== "done" && task.dueAt !== null && Date.parse(task.dueAt) < now;
}
export function taskRecipientLabel(task: Pick<EmployeeTask, "assignee" | "group">) {
  if (task.assignee) return [task.assignee.displayName, task.group?.name].filter(Boolean).join(" · ");
  return task.group ? task.group.name + " · Čaká na pridelenie" : "Bez riešiteľa";
}
export function duePreset(days: number, now = new Date()): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 23, 59).toISOString();
}
/** Human local date/time. Invalid dates and missing DST clock times fail closed. */
export function customDueDate(date: string, time: string): string {
  const day = /^\s*(\d{1,2})\s*\.\s*(\d{1,2})\s*\.\s*(\d{4})\s*$/.exec(date);
  const clock = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(time);
  if (!day || !clock) throw new Error("Dátum zadajte napríklad 18. 11. 2026 a čas 17:00.");
  const [, d, m, y] = day.map(Number), [, h, min] = clock.map(Number);
  const value = new Date(y, m - 1, d, h, min);
  if (value.getFullYear() !== y || value.getMonth() !== m - 1 || value.getDate() !== d || value.getHours() !== h || value.getMinutes() !== min) {
    throw new Error("Tento dátum alebo čas neexistuje. Skontrolujte ho.");
  }
  return value.toISOString();
}
