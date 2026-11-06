import "server-only";
import type {
  EmployeeTask, TaskWorkspaceActivity, TaskWorkspaceCommand, TaskWorkspaceCreate,
  TaskWorkspaceDetail, TaskWorkspaceDirectory, TaskWorkspacePage, TaskWorkspacePerson,
  TaskWorkspaceReceipt, TaskWorkspaceScope, TaskWorkspaceTarget, TaskWorkspaceView,
  TaskChecklistItem, TaskRecurrenceSchedule, TaskRecurrence, TaskAttachment,
} from "@/lib/mobile-task-workspace";
import { TASK_PHOTO_MAX_BYTES } from "@/lib/mobile-task-workspace";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/telephony/uuid";
import { MutationError } from "@/server/mutation-error";
import { mobileEnvironment, verifyMobileUser } from "./auth";
import { queueWorkPush } from "./push-outbox";

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
function checklist(value: unknown, failure = badInput, allowDefaultDone = true): TaskChecklistItem[] {
  if (!Array.isArray(value) || value.length > 50) failure();
  const items = (value as unknown[]).map(item => {
    const row = object(item, failure);
    if (Object.keys(row).some(key => !["id", "title", "done"].includes(key)) || typeof row.id !== "string" || !isUuid(row.id)
      || typeof row.title !== "string" || !row.title.trim() || row.title.length > 300 || row.title.includes("\0") || (row.done === undefined ? !allowDefaultDone : typeof row.done !== "boolean")) failure();
    return { id: (row.id as string).toLowerCase(), title: (row.title as string).trim(), done: row.done === true };
  });
  if (new Set(items.map(item => item.id)).size !== items.length) failure();
  return items;
}
function schedule(value: unknown, failure = badInput): TaskRecurrenceSchedule {
  const row = object(value, failure);
  if (Object.keys(row).some(key => !["frequency", "time", "weekday"].includes(key)) || !["daily", "weekly"].includes(row.frequency as string)
    || typeof row.time !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(row.time)
    || row.frequency === "weekly" && (!Number.isInteger(row.weekday) || (row.weekday as number) < 1 || (row.weekday as number) > 7)
    || row.frequency === "daily" && row.weekday !== undefined && row.weekday !== null) failure();
  return { frequency: row.frequency as TaskRecurrenceSchedule["frequency"], time: row.time as string,
    ...(row.frequency === "weekly" ? { weekday: row.weekday as number } : {}) };
}
function responseTimeZone(value: unknown): string {
  if (typeof value !== "string" || value.length > 100) badResponse();
  try { new Intl.DateTimeFormat("en", { timeZone: value }).format(); } catch { badResponse(); }
  return value;
}
function recurrence(value: unknown): TaskRecurrence | null {
  if (value === null) return null;
  const row = object(value, badResponse);
  const parsed = schedule({ frequency: row.frequency, time: row.time, weekday: row.weekday }, badResponse);
  if (!["active", "paused", "needs_attention"].includes(row.state as string) || !Number.isSafeInteger(row.revision) || (row.revision as number) < 1 || (row.revision as number) > 2_147_483_647) badResponse();
  if (row.issue !== undefined && row.issue !== null && !["creator_inactive", "recipient_unavailable"].includes(row.issue as string)) badResponse();
  return { ...parsed, id: responseId(row.id), revision: row.revision as number, weekday: parsed.weekday ?? null, timeZone: responseTimeZone(row.timeZone), state: row.state as TaskRecurrence["state"],
    ...(row.nextAt === undefined ? {} : { nextAt: responseDate(row.nextAt, true) }),
    ...(row.issue === undefined || row.issue === null ? {} : { issue: row.issue as TaskRecurrence["issue"] }) };
}
export function employeeTaskAttachment(value: unknown): TaskAttachment {
  const row = object(value, badResponse);
  if (!["image/jpeg", "image/png"].includes(row.mimeType as string) || !Number.isSafeInteger(row.sizeBytes) || (row.sizeBytes as number) < 1 || (row.sizeBytes as number) > TASK_PHOTO_MAX_BYTES
    || row.canRemove !== undefined && typeof row.canRemove !== "boolean") badResponse();
  return { id: responseId(row.id), fileName: responseText(row.fileName, 240, true), mimeType: row.mimeType as TaskAttachment["mimeType"], sizeBytes: row.sizeBytes as number,
    createdAt: responseDate(row.createdAt)!, ...(row.canRemove === undefined ? {} : { canRemove: row.canRemove as boolean }) };
}
export function parseEmployeeTaskList(params: URLSearchParams) {
  const input = queryInput(params, ["view", "category", "q", "cursor", "limit", "dueFilter"]);
  const view = input.view ?? "mine", category = input.category ?? "open";
  if (!views.includes(view as TaskWorkspaceView) || !["open", "done", "all"].includes(category as string)) badInput("Neplatný výber úloh.");
  if (input.dueFilter !== undefined && !["all", "today", "overdue"].includes(input.dueFilter as string)) badInput("Neplatný výber termínu.");
  const limit = input.limit === undefined ? 25 : Number(input.limit);
  if (input.limit !== undefined && !/^[1-9]\d?$/.test(input.limit as string) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) badInput("Neplatný počet úloh.");
  return { view: view as TaskWorkspaceView, category: category as "open" | "done" | "all", q: input.q === undefined ? "" : text(input.q, 200), cursor: cursor(input.cursor), limit,
    ...(input.dueFilter === undefined ? {} : { dueFilter: input.dueFilter as "all" | "today" | "overdue" }) };
}
export function parseEmployeeTaskCreate(value: unknown): TaskWorkspaceCreate {
  const input = object(value);
  keys(input, ["commandId", "title", "target", "description", "dueAt", "priority", "caseId", "checklist", "recurrence"]);
  const priority = input.priority ?? "normal";
  if (!priorities.includes(priority as EmployeeTask["priority"])) badInput();
  return {
    commandId: uuid(input.commandId), title: text(input.title, 500, true), target: target(input.target),
    ...(input.description === undefined ? {} : { description: text(input.description, 10_000) }),
    ...(input.dueAt === undefined ? {} : { dueAt: dueDate(input.dueAt) }),
    priority: priority as EmployeeTask["priority"],
    ...(input.caseId === undefined ? {} : { caseId: input.caseId === null ? null : uuid(input.caseId) }),
    ...(input.checklist === undefined ? {} : { checklist: checklist(input.checklist) }),
    ...(input.recurrence === undefined ? {} : { recurrence: schedule(input.recurrence) }),
  };
}
export function parseEmployeeTaskCommand(value: unknown): TaskWorkspaceCommand {
  const input = object(value);
  const base = { commandId: uuid(input.commandId), expectedRevision: input.expectedRevision as number };
  if (!Number.isSafeInteger(base.expectedRevision) || base.expectedRevision < 1 || base.expectedRevision > 2_147_483_647) badInput("Chýba aktuálna verzia úlohy.");
  const common = ["commandId", "expectedRevision", "action"];
  if (input.action === "checklist") { keys(input, [...common, "items"]); return { ...base, action: "checklist", items: checklist(input.items) }; }
  if (input.action === "recurrence") {
    keys(input, [...common, "schedule", "expectedSeriesRevision"]);
    if (input.expectedSeriesRevision !== undefined && (!Number.isSafeInteger(input.expectedSeriesRevision) || (input.expectedSeriesRevision as number) < 1 || (input.expectedSeriesRevision as number) > 2_147_483_647)) badInput("Chýba aktuálna verzia opakovania.");
    return { ...base, action: "recurrence", schedule: input.schedule === null ? null : schedule(input.schedule),
      ...(input.expectedSeriesRevision === undefined ? {} : { expectedSeriesRevision: input.expectedSeriesRevision as number }) };
  }
  if (input.action === "complete" || input.action === "approve") {
    keys(input, [...common, "allowIncompleteChecklist"]);
    if (input.allowIncompleteChecklist !== undefined && typeof input.allowIncompleteChecklist !== "boolean") badInput();
    return { ...base, action: input.action, ...(input.allowIncompleteChecklist === undefined ? {} : { allowIncompleteChecklist: input.allowIncompleteChecklist as boolean }) };
  }
  if (input.action === "assign") { keys(input, [...common, "target"]); return { ...base, action: "assign", target: target(input.target) }; }
  if (input.action === "comment") { keys(input, [...common, "body"]); return { ...base, action: "comment", body: text(input.body, 10_000, true) }; }
  if (input.action === "submit_review") {
    keys(input, [...common, "reviewerUserId", "comment"]);
    return { ...base, action: "submit_review", reviewerUserId: uuid(input.reviewerUserId), comment: text(input.comment, 10_000, true) };
  }
  if (input.action === "return") { keys(input, [...common, "comment"]); return { ...base, action: "return", comment: text(input.comment, 10_000, true) }; }
  if (["claim", "start", "reopen"].includes(input.action as string)) {
    keys(input, common); return { ...base, action: input.action as "claim" | "start" | "reopen" };
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
export function employeeTaskScope(actor: EmployeeTaskActor): TaskWorkspaceScope {
  return { ok: true, apiVersion: 1, environment: mobileEnvironment(), userId: actor.userId, organizationId: actor.organizationId, checkedAt: new Date().toISOString() };
}
function rpcError(error: RpcError): never {
  if (error.code === "22023" && error.message === "Task recurrence recipient inactive") {
    throw new MutationError("Príjemca série už nie je dostupný. Vytvorte novú opakovanú úlohu s platným príjemcom.", 400, "task_recurrence_recipient_inactive");
  }
  if (error.code === "22023" && error.message === "Task recurrence owner inactive") {
    throw new MutationError("Autor série už nemá prístup. Vytvorte novú opakovanú úlohu.", 400, "task_recurrence_owner_inactive");
  }
  if (error.code === "42501" && error.message === "Employee task access denied") {
    throw new MutationError("Prístup k úlohám bol odobratý. Obnovte oprávnenia pred pokračovaním.", 403, "employee_access_revoked");
  }
  if (error.code === "42501") throw new MutationError("Úloha nie je dostupná alebo nemáte oprávnenie.", 403);
  if (error.code === "P0002") throw new MutationError("Úloha už nie je dostupná.", 404);
  if (["PT409", "23505", "40001"].includes(error.code ?? "")) throw new MutationError("Úloha sa medzitým zmenila. Obnovte ju a overte pôvodnú požiadavku.", 409, "task_workspace_conflict");
  if (["22023", "22P02", "22007", "22008", "23514"].includes(error.code ?? "")) throw new MutationError("Skontrolujte údaje úlohy, kolegu a pobočku.", 400);
  throw new MutationError("Úlohy momentálne nie sú dostupné.", 503, error.code === "55000" ? "task_workspace_disabled" : "task_workspace_unavailable");
}
export async function callEmployeeTask(actor: EmployeeTaskActor, action: string, id: string | null, input: object): Promise<Input> {
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
    permissions: { ...Object.fromEntries(permissionKeys.map(key => [key, permissions[key]])),
      ...Object.fromEntries(["editChecklist", "manageRecurrence", "attach"].filter(key => permissions[key] !== undefined).map(key => {
        if (typeof permissions[key] !== "boolean") badResponse();
        return [key, permissions[key]];
      })) } as EmployeeTask["permissions"],
    ...(row.checklist === undefined ? {} : { checklist: checklist(row.checklist, badResponse, false) }),
    ...(row.recurrence === undefined ? {} : { recurrence: recurrence(row.recurrence) }),
    ...(row.attachments === undefined ? {} : { attachments: (() => {
      if (!Array.isArray(row.attachments) || row.attachments.length > 10) badResponse();
      const attachments = row.attachments.map(employeeTaskAttachment);
      if (new Set(attachments.map(item => item.id)).size !== attachments.length) badResponse();
      return attachments;
    })() }),
  };
}
export function employeeTaskReceipt(data: Input, actor: EmployeeTaskActor, commandId: string, expectedTaskId?: string): TaskWorkspaceReceipt {
  if (responseId(data.commandId) !== commandId || !Number.isSafeInteger(data.committedRevision) || (data.committedRevision as number) < 1) badResponse();
  const result = task(data.task, expectedTaskId);
  if ((data.committedRevision as number) > result.revision) badResponse();
  return { ...employeeTaskScope(actor), commandId, committedRevision: data.committedRevision as number, task: result };
}
export async function listEmployeeTasks(actor: EmployeeTaskActor, params: URLSearchParams): Promise<TaskWorkspacePage> {
  const input = parseEmployeeTaskList(params), data = await callEmployeeTask(actor, "list", null, input);
  if (data.view !== input.view || !Array.isArray(data.tasks) || data.tasks.length > input.limit) badResponse();
  const tasks = data.tasks.map(value => task(value)), nextCursor = responseCursor(data.nextCursor);
  if (new Set(tasks.map(row => row.id)).size !== tasks.length || nextCursor && (!tasks.length || nextCursor === input.cursor)) badResponse();
  if (data.dueFilter !== undefined && data.dueFilter !== (input.dueFilter ?? "all") || input.dueFilter && input.dueFilter !== "all" && data.dueFilter !== input.dueFilter) badResponse();
  return { ...employeeTaskScope(actor), view: input.view, tasks, nextCursor,
    ...(data.dueFilter === undefined ? {} : { dueFilter: data.dueFilter as TaskWorkspacePage["dueFilter"] }),
    ...(data.timeZone === undefined ? {} : { timeZone: responseTimeZone(data.timeZone) }) };
}
export async function directoryEmployeeTasks(actor: EmployeeTaskActor, params: URLSearchParams): Promise<TaskWorkspaceDirectory> {
  const input = queryInput(params, ["q"]), q = input.q === undefined ? "" : text(input.q, 200);
  const data = await callEmployeeTask(actor, "directory", null, { q });
  if (!Array.isArray(data.people) || data.people.length > 100 || !Array.isArray(data.groups) || data.groups.length > 500
    || typeof data.hasMorePeople !== "boolean" || typeof data.canLinkCases !== "boolean") badResponse();
  const people = data.people.map(value => person(value) ?? badResponse());
  const groups = data.groups.map(value => { const row = object(value, badResponse); if (typeof row.canManage !== "boolean") badResponse(); return { id: responseId(row.id), name: responseText(row.name, 200, true), canManage: row.canManage }; });
  if (new Set(people.map(row => row.userId)).size !== people.length || new Set(groups.map(row => row.id)).size !== groups.length) badResponse();
  return { ...employeeTaskScope(actor), people, groups, hasMorePeople: data.hasMorePeople, canLinkCases: data.canLinkCases, ...(data.timeZone === undefined ? {} : { timeZone: responseTimeZone(data.timeZone) }) };
}
export async function getEmployeeTask(actor: EmployeeTaskActor, id: string, params: URLSearchParams): Promise<TaskWorkspaceDetail> {
  const expectedId = uuid(id), input = queryInput(params, ["cursor"]), requestedCursor = cursor(input.cursor);
  const data = await callEmployeeTask(actor, "get", expectedId, { cursor: requestedCursor });
  if (!Array.isArray(data.activity) || data.activity.length > 50) badResponse();
  const activity: TaskWorkspaceActivity[] = data.activity.map(value => {
    const row = object(value, badResponse);
    if (!["comment", "created", "assigned", "state"].includes(row.kind as string)) badResponse();
    return { id: responseId(row.id), author: person(row.author), body: responseText(row.body, 10_000), createdAt: responseDate(row.createdAt)!, kind: row.kind as TaskWorkspaceActivity["kind"] };
  });
  const nextActivityCursor = responseCursor(data.nextActivityCursor);
  if (new Set(activity.map(row => row.id)).size !== activity.length || nextActivityCursor && (!activity.length || nextActivityCursor === requestedCursor)) badResponse();
  return { ...employeeTaskScope(actor), task: task(data.task, expectedId), activity, nextActivityCursor };
}
export async function createEmployeeTask(actor: EmployeeTaskActor, value: unknown): Promise<TaskWorkspaceReceipt> {
  const input = parseEmployeeTaskCreate(value), data = await callEmployeeTask(actor, "create", null, input);
  const result = employeeTaskReceipt(data, actor, input.commandId);
  if (result.task.createdBy?.userId !== actor.userId.toLowerCase()) badResponse();
  queueWorkPush(actor.organizationId);
  return result;
}
export async function commandEmployeeTask(actor: EmployeeTaskActor, id: string, value: unknown): Promise<TaskWorkspaceReceipt> {
  const expectedId = uuid(id), input = parseEmployeeTaskCommand(value), data = await callEmployeeTask(actor, "command", expectedId, input);
  const result = employeeTaskReceipt(data, actor, input.commandId, expectedId);
  queueWorkPush(actor.organizationId);
  return result;
}
