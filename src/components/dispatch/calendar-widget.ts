import type { WorkspaceTask } from "@/domain/task-workspace";

/** Match the existing task board's local calendar-day semantics, including DST. */
export function calendarDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function calendarMonthDays(month: Date): Date[] {
  const start = new Date(month.getFullYear(), month.getMonth(), 1, 12);
  start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0, 12);
  last.setDate(last.getDate() + (7 - last.getDay()) % 7);
  const days: Date[] = [];
  for (const day = new Date(start); day <= last; day.setDate(day.getDate() + 1)) days.push(new Date(day));
  return days;
}

export function calendarTasksByDay(tasks: WorkspaceTask[], includeDone: boolean): Map<string, WorkspaceTask[]> {
  const grouped = new Map<string, WorkspaceTask[]>();
  for (const task of tasks) {
    if ((!includeDone && task.status === "done") || !task.dueAt) continue;
    const due = new Date(task.dueAt);
    if (!Number.isFinite(due.getTime())) continue;
    const key = calendarDayKey(due);
    grouped.set(key, [...(grouped.get(key) ?? []), task]);
  }
  for (const tasks of grouped.values()) tasks.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.title.localeCompare(b.title, "sk"));
  return grouped;
}
