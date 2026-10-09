import { useEffect } from "react";
import type { WorkspaceTask } from "../../src/domain/task-workspace";
import { TaskWorkspaceCard } from "../../src/components/dispatch/TaskWorkspaceBoard";

export const hydrationTasks: WorkspaceTask[] = [
  { id: "summer", dueAt: "2026-10-09T12:30:00.000Z" },
  { id: "winter", dueAt: "2026-01-09T12:30:00.000Z" },
  { id: "dst-fallback", dueAt: "2026-10-25T01:30:00.000Z" },
  { id: "undated", dueAt: "" },
].map(({ id, dueAt }) => ({
  id, dueAt, title: `Syntetická úloha ${id}`, kind: "other", caseId: "", assignedTo: "unassigned",
  status: "open", priority: "normal", caseIds: [], caseLinks: [], revision: 1,
  originLocked: false, provenance: "manual", origins: [], updatedAt: "2026-01-01T00:00:00.000Z",
}));

export function TaskCardHydrationFixture() {
  useEffect(() => { window.taskCardHydration.ready = true; }, []);
  return <ul>{hydrationTasks.map(task => <TaskWorkspaceCard key={task.id} task={task} operators={[]}
    disabled now={new Date("2026-01-01T00:00:00.000Z")} onSelect={() => {}} onStatusChange={() => {}} />)}</ul>;
}

declare global {
  interface Window {
    taskCardHydration: { ready: boolean; errors: string[] };
  }
}
