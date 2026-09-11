import { compareOperationalTasks, isTaskDueToday, isTaskOverdue } from "@/domain/tasks";
import type { WorkspaceTask } from "@/domain/task-workspace";

export const taskBoardColumns = [
  { id: "overdue", label: "Po termíne", empty: "Všetko načas." },
  { id: "today", label: "Dnes", empty: "Na dnes nič nezostáva." },
  { id: "scheduled", label: "Naplánované", empty: "Žiadne ďalšie termíny." },
  { id: "undated", label: "Bez termínu", empty: "Všetky úlohy majú termín." },
  { id: "done", label: "Vybavené", empty: "Zatiaľ bez vybavených úloh." },
] as const;

export type TaskBoardColumnId = typeof taskBoardColumns[number]["id"];

/** Moving a card changes completion only; date buckets never invent a deadline. */
export function taskBoardDropStatus(task: WorkspaceTask, column: string): "open" | "done" | null {
  if (!taskBoardColumns.some(item => item.id === column)) return null;
  if (task.status !== "done") return column === "done" ? "done" : null;
  return column === "done" ? null : "open";
}

/** A task appears exactly once: elapsed deadlines take precedence over today's date. */
export function taskBoardColumn(task: WorkspaceTask, now: Date): TaskBoardColumnId {
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
