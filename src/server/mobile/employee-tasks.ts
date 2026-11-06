import "server-only";
import type {
  EmployeeTask, TaskWorkspaceActivity, TaskWorkspaceCommand, TaskWorkspaceCreate,
  TaskWorkspaceDetail, TaskWorkspaceDirectory, TaskWorkspacePage, TaskWorkspacePerson,
  TaskWorkspaceReceipt, TaskWorkspaceScope, TaskWorkspaceTarget, TaskWorkspaceView,
} from "@/lib/mobile-task-workspace";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/telephony/uuid";
import { MutationError } from "@/server/mutation-error";
import { mobileEnvironment, verifyMobileUser } from "./auth";

export type EmployeeTaskActor = { userId: string; organizationId: string };
type Input = Record<string, unknown>;
type RpcError = { code?: string; message?: string };
type EmployeeTaskClient = {
  rpc(name: "motorist_employee_tasks", input: {
    p_user_id: string; p_organization_id: string; p_action: string;
    p_task_id: string | null; p_input: object;
  }): PromiseLike<{ data: unknown; error: RpcError | null }>;
};
const permissionKeys = ["start", "complete", "reopen", "claim", "assign", "comment", "submitReview", "approve", "return"] as const;
const states = ["todo", "in_progress", "in_review", "done"] as const;
const priorities = ["urgent", "high", "normal", "low"] as const;
const views = ["mine", "branch", "created", "review"] as const;
function badInput(message = "Skontrolujte údaje úlohy."): never { throw new MutationError(message, 400); }
function badResponse(): never { throw new MutationError("Odpoveď úloh sa nepodarilo overiť.", 503, "task_workspace_unconfirmed"); }
function object(value: unknown, failure = badInput): Input {
  if (!value || typeof value !== "object" || Array.isArray(value)) failure();
  return value as Input;
}
function keys(value: Input, allowed: readonly string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) badInput("Formulár obsahuje nepovolené údaje.");
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !isUuid(value)) badInput("Neplatné ID úlohy, kolegu alebo pobočky.");
  return value.toLowerCase();
}
function text(value: unknown, limit: number, required = false): string {
  if (typeof value !== "string" || value.length > limit || (required && !value.trim())) badInput();
  return value.trim();
}
function validDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}
function dueDate(value: unknown): string | null {
  if (value === null) return null;
  if (!validDate(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) badInput("Zadajte platný termín úlohy.");
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) badInput("Zadajte platný termín úlohy.");
  return new Date(value).toISOString();
}
function target(value: unknown): TaskWorkspaceTarget {
  const input = object(value);
  if (input.kind === "person") { keys(input, ["kind", "userId"]); return { kind: "person", userId: uuid(input.userId) }; }
  if (input.kind === "group") { keys(input, ["kind", "groupId"]); return { kind: "group", groupId: uuid(input.groupId) }; }
  return badInput("Vyberte kolegu alebo pobočku.");
}
function queryInput(params: URLSearchParams, allowed: readonly string[]): Input {
  const result: Input = {};
  for (const [key, value] of params) {
    if (!allowed.includes(key) || Object.hasOwn(result, key)) badInput("Neplatný výber úloh.");
    result[key] = value;
  }
  return result;
}
function cursor(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value || value.length > 4096) badInput("Neplatná stránka úloh.");
  return value;
}
export function parseEmployeeTaskList(params: URLSearchParams) {
  const input = queryInput(params, ["view", "category", "q", "cursor", "limit"]);
  const view = input.view ?? "mine", category = input.category ?? "open";
  if (!views.includes(view as TaskWorkspaceView) || !["open", "done", "all"].includes(category as string)) badInput("Neplatný výber úloh.");
  const limit = input.limit === undefined ? 25 : Number(input.limit);
  if (input.limit !== undefined && !/^[1-9]\d?$/.test(input.limit as string) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) badInput("Neplatný počet úloh.");
  return { view: view as TaskWorkspaceView, category: category as "open" | "done" | "all", q: input.q === undefined ? "" : text(input.q, 200), cursor: cursor(input.cursor), limit };
}
export function parseEmployeeTaskCreate(value: unknown): TaskWorkspaceCreate {
  const input = object(value);
  keys(input, ["commandId", "title", "target", "description", "dueAt", "priority", "caseId"]);
  const priority = input.priority ?? "normal";
  if (!priorities.includes(priority as EmployeeTask["priority"])) badInput();
  return {
    commandId: uuid(input.commandId), title: text(input.title, 500, true), target: target(input.target),
    ...(input.description === undefined ? {} : { description: text(input.description, 10_000) }),
    ...(input.dueAt === undefined ? {} : { dueAt: dueDate(input.dueAt) }),
    priority: priority as EmployeeTask["priority"],
    ...(input.caseId === undefined ? {} : { caseId: input.caseId === null ? null : uuid(input.caseId) }),
  };
}
export function parseEmployeeTaskCommand(value: unknown): TaskWorkspaceCommand {
  const input = object(value);
  const base = { commandId: uuid(input.commandId), expectedRevision: input.expectedRevision as number };
  if (!Number.isSafeInteger(base.expectedRevision) || base.expectedRevision < 1 || base.expectedRevision > 2_147_483_647) badInput("Chýba aktuálna verzia úlohy.");
  const common = ["commandId", "expectedRevision", "action"];
  if (input.action === "assign") { keys(input, [...common, "target"]); return { ...base, action: "assign", target: target(input.target) }; }
  if (input.action === "comment") { keys(input, [...common, "body"]); return { ...base, action: "comment", body: text(input.body, 10_000, true) }; }
  if (input.action === "submit_review") {
    keys(input, [...common, "reviewerUserId", "comment"]);
    return { ...base, action: "submit_review", reviewerUserId: uuid(input.reviewerUserId), comment: text(input.comment, 10_000, true) };
  }
  if (input.action === "return") { keys(input, [...common, "comment"]); return { ...base, action: "return", comment: text(input.comment, 10_000, true) }; }
  if (["claim", "start", "complete", "reopen", "approve"].includes(input.action as string)) {
    keys(input, common); return { ...base, action: input.action as "claim" | "start" | "complete" | "reopen" | "approve" };
  }
  return badInput("Neplatný krok úlohy.");
}

/** Field-only employees use the same verified Auth identity, without inheriting
 * dispatch or live-delivery permissions. The RPC checks current membership. */
export async function requireEmployeeTaskUser(request: Request): Promise<EmployeeTaskActor> {
  const user = await verifyMobileUser(request);
  if (user.expectedOrganization !== null && user.expectedOrganization.toLowerCase() !== user.organizationId.toLowerCase()) {
    throw new MutationError("Organizácia účtu sa zmenila. Obnovte prihlásenie pred pokračovaním.", 409, "expected_organization_mismatch");
  }
  return { userId: user.userId, organizationId: user.organizationId };
}
function scope(actor: EmployeeTaskActor): TaskWorkspaceScope {
  return { ok: true, apiVersion: 1, environment: mobileEnvironment(), userId: actor.userId, organizationId: actor.organizationId, checkedAt: new Date().toISOString() };
}
function rpcError(error: RpcError): never {
  if (error.code === "42501" && error.message === "Employee task access denied") {
    throw new MutationError("Prístup k úlohám bol odobratý. Obnovte oprávnenia pred pokračovaním.", 403, "employee_access_revoked");
  }
  if (error.code === "42501") throw new MutationError("Úloha nie je dostupná alebo nemáte oprávnenie.", 403);
  if (error.code === "P0002") throw new MutationError("Úloha už nie je dostupná.", 404);
  if (["PT409", "23505", "40001"].includes(error.code ?? "")) throw new MutationError("Úloha sa medzitým zmenila. Obnovte ju a overte pôvodnú požiadavku.", 409, "task_workspace_conflict");
  if (["22023", "22P02", "22007", "22008", "23514"].includes(error.code ?? "")) throw new MutationError("Skontrolujte údaje úlohy, kolegu a pobočku.", 400);
  throw new MutationError("Úlohy momentálne nie sú dostupné.", 503, error.code === "55000" ? "task_workspace_disabled" : "task_workspace_unavailable");
}
async function call(actor: EmployeeTaskActor, action: string, id: string | null, input: object): Promise<Input> {
  const client = createSupabaseAdminClient(AbortSignal.timeout(12_000)) as unknown as EmployeeTaskClient;
  const result = await client.rpc("motorist_employee_tasks", { p_user_id: actor.userId, p_organization_id: actor.organizationId, p_action: action, p_task_id: id, p_input: input });
  if (result.error) rpcError(result.error);
  return object(result.data, badResponse);
}
function responseText(value: unknown, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || required && !value.trim()) badResponse();
  return value;
}
function responseId(value: unknown): string {
  if (typeof value !== "string" || !isUuid(value)) badResponse();
  return value.toLowerCase();
}
function responseDate(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (!validDate(value)) badResponse();
  return value;
}
function person(value: unknown): TaskWorkspacePerson | null {
  if (value === null) return null;
  const row = object(value, badResponse);
  return { userId: responseId(row.userId), displayName: responseText(row.displayName, 200, true) };
}
function responseCursor(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !value || value.length > 4096) badResponse();
  return value;
}
function task(value: unknown, expectedId?: string): EmployeeTask {
  const row = object(value, badResponse), id = responseId(row.id);
  if (expectedId && id !== expectedId || !states.includes(row.state as EmployeeTask["state"]) || !priorities.includes(row.priority as EmployeeTask["priority"])
    || !Number.isSafeInteger(row.revision) || (row.revision as number) < 1 || !Array.isArray(row.caseLinks) || row.caseLinks.length > 100) badResponse();
  const permissions = object(row.permissions, badResponse);
  if (permissionKeys.some(key => typeof permissions[key] !== "boolean")) badResponse();
  const group = row.group === null ? null : object(row.group, badResponse);
  const caseLinks = row.caseLinks.map(value => { const link = object(value, badResponse); return { id: responseId(link.id), number: responseText(link.number, 160, true) }; });
  if (new Set(caseLinks.map(link => link.id)).size !== caseLinks.length) badResponse();
  return {
    id, title: responseText(row.title, 500, true), description: responseText(row.description, 10_000),
    state: row.state as EmployeeTask["state"], priority: row.priority as EmployeeTask["priority"], dueAt: responseDate(row.dueAt, true),
    revision: row.revision as number, createdAt: responseDate(row.createdAt)!, updatedAt: responseDate(row.updatedAt)!,
    createdBy: person(row.createdBy), assignee: person(row.assignee), reviewer: person(row.reviewer),
    group: group ? { id: responseId(group.id), name: responseText(group.name, 200, true) } : null,
    caseLinks, reviewSubmission: row.reviewSubmission === null ? null : responseText(row.reviewSubmission, 10_000),
    reviewReturnReason: row.reviewReturnReason === null ? null : responseText(row.reviewReturnReason, 10_000),
    permissions: Object.fromEntries(permissionKeys.map(key => [key, permissions[key]])) as EmployeeTask["permissions"],
  };
}
function receipt(data: Input, actor: EmployeeTaskActor, commandId: string, expectedTaskId?: string): TaskWorkspaceReceipt {
  if (responseId(data.commandId) !== commandId || !Number.isSafeInteger(data.committedRevision) || (data.committedRevision as number) < 1) badResponse();
  const result = task(data.task, expectedTaskId);
  if ((data.committedRevision as number) > result.revision) badResponse();
  return { ...scope(actor), commandId, committedRevision: data.committedRevision as number, task: result };
}
export async function listEmployeeTasks(actor: EmployeeTaskActor, params: URLSearchParams): Promise<TaskWorkspacePage> {
  const input = parseEmployeeTaskList(params), data = await call(actor, "list", null, input);
  if (data.view !== input.view || !Array.isArray(data.tasks) || data.tasks.length > input.limit) badResponse();
  const tasks = data.tasks.map(value => task(value)), nextCursor = responseCursor(data.nextCursor);
  if (new Set(tasks.map(row => row.id)).size !== tasks.length || nextCursor && (!tasks.length || nextCursor === input.cursor)) badResponse();
  return { ...scope(actor), view: input.view, tasks, nextCursor };
}
export async function directoryEmployeeTasks(actor: EmployeeTaskActor, params: URLSearchParams): Promise<TaskWorkspaceDirectory> {
  const input = queryInput(params, ["q"]), q = input.q === undefined ? "" : text(input.q, 200);
  const data = await call(actor, "directory", null, { q });
  if (!Array.isArray(data.people) || data.people.length > 100 || !Array.isArray(data.groups) || data.groups.length > 500
    || typeof data.hasMorePeople !== "boolean" || typeof data.canLinkCases !== "boolean") badResponse();
  const people = data.people.map(value => person(value) ?? badResponse());
  const groups = data.groups.map(value => { const row = object(value, badResponse); if (typeof row.canManage !== "boolean") badResponse(); return { id: responseId(row.id), name: responseText(row.name, 200, true), canManage: row.canManage }; });
  if (new Set(people.map(row => row.userId)).size !== people.length || new Set(groups.map(row => row.id)).size !== groups.length) badResponse();
  return { ...scope(actor), people, groups, hasMorePeople: data.hasMorePeople, canLinkCases: data.canLinkCases };
}
export async function getEmployeeTask(actor: EmployeeTaskActor, id: string, params: URLSearchParams): Promise<TaskWorkspaceDetail> {
  const expectedId = uuid(id), input = queryInput(params, ["cursor"]), requestedCursor = cursor(input.cursor);
  const data = await call(actor, "get", expectedId, { cursor: requestedCursor });
  if (!Array.isArray(data.activity) || data.activity.length > 50) badResponse();
  const activity: TaskWorkspaceActivity[] = data.activity.map(value => {
    const row = object(value, badResponse);
    if (!["comment", "created", "assigned", "state"].includes(row.kind as string)) badResponse();
    return { id: responseId(row.id), author: person(row.author), body: responseText(row.body, 10_000), createdAt: responseDate(row.createdAt)!, kind: row.kind as TaskWorkspaceActivity["kind"] };
  });
  const nextActivityCursor = responseCursor(data.nextActivityCursor);
  if (new Set(activity.map(row => row.id)).size !== activity.length || nextActivityCursor && (!activity.length || nextActivityCursor === requestedCursor)) badResponse();
  return { ...scope(actor), task: task(data.task, expectedId), activity, nextActivityCursor };
}
export async function createEmployeeTask(actor: EmployeeTaskActor, value: unknown): Promise<TaskWorkspaceReceipt> {
  const input = parseEmployeeTaskCreate(value), data = await call(actor, "create", null, input);
  const result = receipt(data, actor, input.commandId);
  if (result.task.createdBy?.userId !== actor.userId.toLowerCase()) badResponse();
  return result;
}
export async function commandEmployeeTask(actor: EmployeeTaskActor, id: string, value: unknown): Promise<TaskWorkspaceReceipt> {
  const expectedId = uuid(id), input = parseEmployeeTaskCommand(value), data = await call(actor, "command", expectedId, input);
  return receipt(data, actor, input.commandId, expectedId);
}
