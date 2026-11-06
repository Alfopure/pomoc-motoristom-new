/** Shared mobile task workspace. Auth user IDs identify employees; this does not
 * grant dispatch or case access to employees with a field membership only. */
export type TaskWorkspacePerson = { userId: string; displayName: string };
export type TaskWorkspaceGroup = { id: string; name: string; canManage: boolean };
export type TaskWorkspaceState = "todo" | "in_progress" | "in_review" | "done";
export type TaskWorkspaceView = "mine" | "branch" | "created" | "review";
export type TaskWorkspaceDueFilter = "all" | "today" | "overdue";
export type TaskChecklistItem = { id: string; title: string; done: boolean };
export type TaskRecurrenceSchedule = { frequency: "daily" | "weekly"; time: string; weekday?: number | null };
export type TaskRecurrence = TaskRecurrenceSchedule & {
  id: string; revision: number; weekday: number | null; timeZone: string;
  state: "active" | "paused" | "needs_attention"; nextAt?: string | null;
  issue?: "creator_inactive" | "recipient_unavailable";
};
export const TASK_PHOTO_MAX_BYTES = 8 * 1024 * 1024;
export type TaskAttachment = { id: string; fileName: string; mimeType: "image/jpeg" | "image/png"; sizeBytes: number; createdAt: string; canRemove?: boolean };
export type TaskWorkspaceScope = {
  ok: true; apiVersion: 1; environment: "test" | "production";
  userId: string; organizationId: string; checkedAt: string;
};
export type TaskWorkspaceTarget = { kind: "person"; userId: string } | { kind: "group"; groupId: string };
export type TaskWorkspacePermissions = {
  start: boolean; complete: boolean; reopen: boolean; claim: boolean;
  assign: boolean; comment: boolean; submitReview: boolean; approve: boolean; return: boolean;
  editChecklist?: boolean; manageRecurrence?: boolean; attach?: boolean;
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
  checklist?: TaskChecklistItem[];
  recurrence?: TaskRecurrence | null;
  attachments?: TaskAttachment[];
};
export type TaskWorkspaceActivity = {
  id: string; author: TaskWorkspacePerson | null; body: string; createdAt: string;
  kind: "comment" | "created" | "assigned" | "state";
};
export type TaskWorkspacePage = TaskWorkspaceScope & {
  view: TaskWorkspaceView; tasks: EmployeeTask[]; nextCursor: string | null;
  dueFilter?: TaskWorkspaceDueFilter; timeZone?: string;
};
export type TaskWorkspaceDirectory = TaskWorkspaceScope & {
  people: TaskWorkspacePerson[]; groups: TaskWorkspaceGroup[];
  hasMorePeople: boolean; canLinkCases: boolean;
  timeZone?: string;
};
export type TaskWorkspaceDetail = TaskWorkspaceScope & {
  task: EmployeeTask; activity: TaskWorkspaceActivity[]; nextActivityCursor: string | null;
};
export type TaskWorkspaceCreate = {
  commandId: string; title: string; target: TaskWorkspaceTarget;
  description?: string; dueAt?: string | null;
  priority?: EmployeeTask["priority"]; caseId?: string | null;
  checklist?: TaskChecklistItem[]; recurrence?: TaskRecurrenceSchedule;
};
export type TaskWorkspaceCommand = {
  commandId: string; expectedRevision: number;
} & (
  | { action: "assign"; target: TaskWorkspaceTarget }
  | { action: "comment"; body: string }
  | { action: "submit_review"; reviewerUserId: string; comment: string }
  | { action: "return"; comment: string }
  | { action: "checklist"; items: TaskChecklistItem[] }
  | { action: "recurrence"; schedule: TaskRecurrenceSchedule | null; expectedSeriesRevision?: number }
  | { action: "complete" | "approve"; allowIncompleteChecklist?: boolean }
  | { action: "claim" | "start" | "reopen" }
);
export type TaskWorkspaceReceipt = TaskWorkspaceScope & {
  commandId: string; committedRevision: number; task: EmployeeTask;
};
export type TaskAttachmentPrepare = {
  commandId: string; expectedRevision: number; attachmentId: string;
  fileName: string; mimeType: TaskAttachment["mimeType"]; sizeBytes: number;
};
export type TaskAttachmentCommand = { commandId: string; expectedRevision: number };
export type TaskAttachmentUpload = TaskWorkspaceScope & {
  receipt: TaskWorkspaceReceipt; attachment: TaskAttachment;
  upload: { url: string; token: string; path: string; method: "PUT"; contentType: TaskAttachment["mimeType"] };
};
export type TaskAttachmentDownload = TaskWorkspaceScope & { attachment: TaskAttachment; url: string; expiresAt: string };
