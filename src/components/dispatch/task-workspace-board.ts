import { compareOperationalTasks, isTaskDueToday, isTaskOverdue } from "@/domain/tasks";
import type { WorkspaceTask } from "@/domain/task-workspace";
import type { TaskBoardMutation } from "./task-workspace-store";

export const taskBoardColumns = [
  { id: "overdue", label: "Po termíne", empty: "Všetko načas." },
  { id: "today", label: "Dnes", empty: "Na dnes nič nezostáva." },
  { id: "scheduled", label: "Naplánované", empty: "Žiadne ďalšie termíny." },
  { id: "undated", label: "Bez termínu", empty: "Všetky úlohy majú termín." },
  { id: "done", label: "Vybavené", empty: "Zatiaľ bez vybavených úloh." },
] as const;

export type TaskBoardColumnId = typeof taskBoardColumns[number]["id"];

export type TaskBoardDateColumn = "scheduled" | "overdue";
export type TaskBoardDrop =
  | { kind: "save"; patch: TaskBoardMutation }
  | { kind: "date"; column: TaskBoardDateColumn; suggestedDueAt: string };

/** Date columns are derived from dueAt, so a move must update it atomically with status. */
export function taskBoardDrop(task: WorkspaceTask, column: string, now: Date): TaskBoardDrop | null {
  if (!taskBoardColumns.some(item => item.id === column) || taskBoardColumn(task, now) === column) return null;
  if (column === "done") return { kind: "save", patch: { status: "done" } };
  if (column === "undated") return { kind: "save", patch: { status: "open", dueAt: null } };
  if (column === "today") {
    const due = new Date(task.dueAt);
    // Reopening a task with a still-valid deadline today need not change its time.
    if (!Number.isFinite(due.getTime()) || due.getTime() < now.getTime() || !isTaskDueToday({ ...task, status: "open" }, now)) {
      due.setTime(now.getTime()); due.setHours(23, 59, 59, 999);
    }
    return { kind: "save", patch: { status: "open", dueAt: due.toISOString() } };
  }
  if (column === "scheduled" || column === "overdue") {
    const due = new Date(task.dueAt);
    if (!Number.isFinite(due.getTime()) || taskBoardColumn({ ...task, status: "open" }, now) !== column) {
      due.setTime(now.getTime());
      // Calendar arithmetic preserves local-day semantics across DST changes.
      due.setDate(due.getDate() + (column === "scheduled" ? 1 : -1));
      due.setHours(column === "scheduled" ? 9 : 23, column === "scheduled" ? 0 : 59, 0, 0);
    }
    return { kind: "date", column, suggestedDueAt: due.toISOString() };
  }
  return null;
}

export function taskBoardDateMutation(column: TaskBoardDateColumn, dueAt: string, now: Date): TaskBoardMutation | null {
  const due = new Date(dueAt);
  if (!dueAt || !Number.isFinite(due.getTime())) return null;
  const candidate = { status: "open" as const, dueAt: due.toISOString() };
  return taskBoardColumn(candidate, now) === column ? { status: "open", dueAt: due.toISOString() } : null;
}

/** A task appears exactly once: elapsed deadlines take precedence over today's date. */
export function taskBoardColumn(task: Pick<WorkspaceTask, "status" | "dueAt">, now: Date): TaskBoardColumnId {
  if (task.status === "done") return "done";
  if (isTaskOverdue(task, now)) return "overdue";
  if (isTaskDueToday(task, now)) return "today";
  return task.dueAt && Number.isFinite(new Date(task.dueAt).getTime()) ? "scheduled" : "undated";
}

export function groupTaskBoard(tasks: WorkspaceTask[], now: Date) {
  return taskBoardColumns.map(column => ({
    ...column,
    tasks: tasks.filter(task => taskBoardColumn(task, now) === column.id).sort((left, right) =>
      column.id === "done"
        ? new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
        : compareOperationalTasks(left, right, now)),
  }));
}
