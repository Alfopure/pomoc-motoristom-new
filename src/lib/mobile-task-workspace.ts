/** Shared mobile task workspace. Auth user IDs identify employees; this does not
 * grant dispatch or case access to employees with a field membership only. */
export type TaskWorkspacePerson = { userId: string; displayName: string };
export type TaskWorkspaceGroup = { id: string; name: string; canManage: boolean };
export type TaskWorkspaceState = "todo" | "in_progress" | "in_review" | "done";
export type TaskWorkspaceView = "mine" | "branch" | "created" | "review";
export type TaskWorkspaceScope = {
  ok: true; apiVersion: 1; environment: "test" | "production";
  userId: string; organizationId: string; checkedAt: string;
};
export type TaskWorkspaceTarget = { kind: "person"; userId: string } | { kind: "group"; groupId: string };
export type TaskWorkspacePermissions = {
  start: boolean; complete: boolean; reopen: boolean; claim: boolean;
  assign: boolean; comment: boolean; submitReview: boolean; approve: boolean; return: boolean;
};
export type EmployeeTask = {
  id: string; title: string; description: string; state: TaskWorkspaceState;
  priority: "urgent" | "high" | "normal" | "low"; dueAt: string | null;
  revision: number; createdAt: string; updatedAt: string;
  createdBy: TaskWorkspacePerson | null; assignee: TaskWorkspacePerson | null;
  group: { id: string; name: string } | null; reviewer: TaskWorkspacePerson | null;
  caseLinks: { id: string; number: string }[];
  reviewSubmission: string | null; reviewReturnReason: string | null;
  permissions: TaskWorkspacePermissions;
};
export type TaskWorkspaceActivity = {
  id: string; author: TaskWorkspacePerson | null; body: string; createdAt: string;
  kind: "comment" | "created" | "assigned" | "state";
};
export type TaskWorkspacePage = TaskWorkspaceScope & {
  view: TaskWorkspaceView; tasks: EmployeeTask[]; nextCursor: string | null;
};
export type TaskWorkspaceDirectory = TaskWorkspaceScope & {
  people: TaskWorkspacePerson[]; groups: TaskWorkspaceGroup[];
  hasMorePeople: boolean; canLinkCases: boolean;
};
export type TaskWorkspaceDetail = TaskWorkspaceScope & {
  task: EmployeeTask; activity: TaskWorkspaceActivity[]; nextActivityCursor: string | null;
};
export type TaskWorkspaceCreate = {
  commandId: string; title: string; target: TaskWorkspaceTarget;
  description?: string; dueAt?: string | null;
  priority?: EmployeeTask["priority"]; caseId?: string | null;
};
export type TaskWorkspaceCommand = {
  commandId: string; expectedRevision: number;
} & (
  | { action: "assign"; target: TaskWorkspaceTarget }
  | { action: "comment"; body: string }
  | { action: "submit_review"; reviewerUserId: string; comment: string }
  | { action: "return"; comment: string }
  | { action: "claim" | "start" | "complete" | "reopen" | "approve" }
);
export type TaskWorkspaceReceipt = TaskWorkspaceScope & {
  commandId: string; committedRevision: number; task: EmployeeTask;
};
