import type { EmployeeTask, TaskWorkspaceReceipt } from "../../../src/lib/mobile-task-workspace";
import type { EmployeeTasksApi } from "./api";

export const userId = "00000000-0000-4000-8000-000000000001";
export const orgId = "00000000-0000-4000-8000-000000000002";
export const taskId = "00000000-0000-4000-8000-000000000003";
export const otherId = "00000000-0000-4000-8000-000000000004";
export const commandId = "00000000-0000-4000-8000-000000000005";
export const scope = { ok: true as const, apiVersion: 1 as const, environment: "test" as const, userId, organizationId: orgId, checkedAt: "2026-11-06T10:00:00Z" };
export const task: EmployeeTask = {
  id: taskId, title: "Pripraviť auto", description: "Skontrolovať doklady.", state: "todo", priority: "normal", dueAt: null,
  revision: 1, createdAt: scope.checkedAt, updatedAt: scope.checkedAt,
  createdBy: { userId, displayName: "Martin" }, assignee: { userId, displayName: "Martin" }, group: null, reviewer: null,
  caseLinks: [], reviewSubmission: null, reviewReturnReason: null,
  permissions: { start: true, complete: true, reopen: false, claim: false, assign: true, comment: true, submitReview: false, approve: false, return: false },
};
export const receipt = (id = commandId): TaskWorkspaceReceipt => ({ ...scope, commandId: id, committedRevision: 1, task });
export function stubApi(overrides: Partial<EmployeeTasksApi> = {}): EmployeeTasksApi {
  return { list: async query => ({ ...scope, view: query.view, tasks: [task], nextCursor: null }),
    directory: async () => ({ ...scope, people: [task.assignee!], groups: [], hasMorePeople: false, canLinkCases: true }),
    detail: async () => ({ ...scope, task, activity: [], nextActivityCursor: null }),
    create: async input => receipt(input.commandId), command: async (_id, input) => receipt(input.commandId),
    subscribeAccessLoss: () => () => {}, ...overrides };
}
