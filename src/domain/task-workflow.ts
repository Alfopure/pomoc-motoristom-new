import type { WorkspaceTask } from "./task-workspace";

export const taskWorkflowStates = ["todo", "in_progress", "in_review", "done"] as const;
export type TaskWorkflowState = (typeof taskWorkflowStates)[number];
export const taskWorkflowLabels: Record<TaskWorkflowState, string> = {
  todo: "Na vybavenie", in_progress: "Rozpracované", in_review: "Na kontrolu", done: "Vybavené",
};
export const taskWorkflowActions = ["start", "submit_review", "approve", "return", "complete", "reopen", "to_todo"] as const;
export type TaskWorkflowAction = (typeof taskWorkflowActions)[number];
export type TaskWorkflowCommand = {
  action: TaskWorkflowAction;
  expectedRevision: number;
  commandId: string;
  reviewerProfileId?: string;
  comment?: string;
};
export type TaskWorkflowReceipt = { task: WorkspaceTask; commandId: string; committedRevision: number };
export const TASK_REVIEW_COMMENT_LIMIT = 10_000;

/** Old rows keep their existing status; a deadline never determines a stage. */
export function taskWorkflowState(task: Pick<WorkspaceTask, "status" | "workflowState">): TaskWorkflowState {
  if (task.status === "done") return "done";
  return task.workflowState && task.workflowState !== "done" ? task.workflowState : "todo";
}
export function taskRequiresReview(task: Pick<WorkspaceTask, "reviewerProfileId">): boolean {
  return Boolean(task.reviewerProfileId);
}
export function canReviewTask(task: Pick<WorkspaceTask, "status" | "workflowState" | "reviewerProfileId">, viewerProfileId?: string): boolean {
  return Boolean(viewerProfileId && task.reviewerProfileId === viewerProfileId && taskWorkflowState(task) === "in_review");
}
