import { compareOperationalTasks } from "@/domain/tasks";
import type { WorkspaceTask } from "@/domain/task-workspace";
import { canReviewTask, taskRequiresReview, taskWorkflowLabels, taskWorkflowState, taskWorkflowStates, type TaskWorkflowAction, type TaskWorkflowState } from "@/domain/task-workflow";

export const workflowColumnDescriptions: Record<TaskWorkflowState, string> = {
  todo: "Nová práca pripravená na riešenie",
  in_progress: "Práve riešime",
  in_review: "Čaká na kontrolu kolegu",
  done: "Dokončené a dohľadateľné",
};
export function groupWorkflowBoard(tasks: WorkspaceTask[], now: Date) {
  return taskWorkflowStates.map(id => ({ id, label: taskWorkflowLabels[id], description: workflowColumnDescriptions[id],
    tasks: tasks.filter(task => taskWorkflowState(task) === id).sort((a, b) => id === "done" ? Date.parse(b.updatedAt) - Date.parse(a.updatedAt) : compareOperationalTasks(a, b, now)),
  }));
}
export function workflowDropAction(task: WorkspaceTask, target: string, viewerProfileId?: string): TaskWorkflowAction | null {
  const stage = taskWorkflowState(task);
  if (stage === target) return null;
  if (stage === "done") return target === "todo" ? "reopen" : null;
  if (stage === "in_review") return canReviewTask(task, viewerProfileId) ? target === "done" ? "approve" : target === "in_progress" ? "return" : null : null;
  if (target === "in_review") return "submit_review";
  if (target === "done") return taskRequiresReview(task) ? null : "complete";
  if (target === "todo" && stage === "in_progress") return "to_todo";
  if (target === "in_progress" && stage === "todo") return "start";
  return null;
}
export const workflowActionLabels: Record<TaskWorkflowAction, string> = {
  start: "Začať riešiť", submit_review: "Poslať na kontrolu", approve: "Schváliť", return: "Vrátiť na dopracovanie",
  complete: "Vybaviť", reopen: "Otvoriť znova", to_todo: "Vrátiť na vybavenie",
};
export function taskWorkflowCardActions(task: WorkspaceTask, viewerProfileId?: string): TaskWorkflowAction[] {
  const stage = taskWorkflowState(task);
  if (stage === "done") return ["reopen"];
  if (stage === "in_review") return canReviewTask(task, viewerProfileId) ? ["approve", "return"] : [];
  if (stage === "todo") return taskRequiresReview(task) ? ["start", "submit_review"] : ["start", "complete"];
  return taskRequiresReview(task) ? ["submit_review"] : ["submit_review", "complete"];
}
