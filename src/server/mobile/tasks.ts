import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { MobileMyTasks, MobileMyTaskFilter, MobileCaseTasks, MobileTask, MobileTaskCapabilities, MobileTaskColleague, MobileTaskCreateInput, MobileTaskCreated, MobileTaskDetail, MobileTaskMessage, MobileTaskMessageInput, MobileTaskMessages, MobileTaskMessageSent, MobileTaskTransitioned, MobileTaskWorkflowInput } from "@/lib/mobile-api";
import { isHistoryTimestamp } from "@/lib/telephony/call-history-query";
import { isUuid as isUuidString } from "@/lib/telephony/uuid";
import { taskWorkflowState, taskWorkflowStates } from "@/domain/task-workflow";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/mutation-error";
import { humansOnly } from "@/server/profile-kind";
import { createWorkspaceTask, loadTaskMessages, loadWorkspaceTask, sendTaskMessage, taskId } from "@/server/tasks";
import { taskWorkflowEnabled, transitionWorkspaceTask, validateTaskWorkflowCommand } from "@/server/task-workflow";
import { taskWorkspaceSystemEnabled } from "@/server/task-system-gate";

type UserClient = SupabaseClient<Database>;
type TaskRow = Database["public"]["Tables"]["motorist_case_tasks"]["Row"];
type Cursor = { id: string; createdAt: string; scope: string };
type TaskQuery = { limit: number; cursor: Cursor | null };
type MyTaskQuery = TaskQuery & Pick<MobileMyTaskFilter, "view" | "category" | "q">;
type TaskDisplayRow = Pick<TaskRow, "id" | "title" | "status" | "priority" | "kind" | "revision" | "assigned_to" | "reviewer_profile_id" | "origin_locked" | "created_by" | "due_at" | "created_at" | "updated_at" | "workflow_state" | "review_submission" | "review_return_reason">;
type Names = Map<string, string>;
const priorities = ["urgent", "high", "normal", "low"] as const;
const kinds = ["callback", "sms", "dispatch", "documents", "billing", "handover", "other"] as const;
const statuses = ["open", "done", "overdue"] as const;
const roles = ["dispatcher", "senior_dispatcher", "manager", "admin"] as const;

function isUuid(value: unknown): value is string { return typeof value === "string" && isUuidString(value); }
function choice<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function invalid(message = "Skontrolujte údaje úlohy."): never { throw new MutationError(message, 400); }
function unavailable(message = "Údaje úloh sa nepodarilo overiť."): never { throw new MutationError(message, 503); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) unavailable();
  return value as Record<string, unknown>;
}
function form(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.length <= max && !value.includes("\0"); }
function revision(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647; }
function optionalText(value: unknown, max: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!text(value, max)) unavailable();
  return value;
}
function optionalId(value: unknown): string | null {
  if (value === undefined || value === null || value === "" || value === "unassigned") return null;
  if (!isUuid(value)) unavailable();
  return value;
}
function taskDueAt(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  // The established RPC serializes due_at with PostgreSQL's text format.
  if (typeof value !== "string" || value.length > 64 || !Number.isFinite(Date.parse(value))) unavailable();
  return new Date(value).toISOString();
}

export function parseMobileTaskCreate(value: unknown): MobileTaskCreateInput {
  const input = form(value, ["title", "assignedTo", "dueAt", "priority", "kind"]);
  if (!text(input.title, 500) || !input.title.trim()) invalid("Úloha potrebuje názov (najviac 500 znakov).");
  if (input.assignedTo !== undefined && input.assignedTo !== null && !isUuid(input.assignedTo)) invalid("Vyberte zodpovedného kolegu.");
  if (input.dueAt !== undefined && input.dueAt !== null && !isHistoryTimestamp(input.dueAt)) invalid("Zadajte platný termín.");
  if (input.priority !== undefined && !choice(input.priority, priorities)) invalid();
  if (input.kind !== undefined && !choice(input.kind, kinds)) invalid();
  return { title: input.title.trim(),
    ...(input.assignedTo !== undefined ? { assignedTo: input.assignedTo } : {}),
    ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.kind !== undefined ? { kind: input.kind } : {}) };
}
export function parseMobileTaskWorkflow(value: unknown): MobileTaskWorkflowInput {
  const input = form(value, ["action", "expectedRevision", "commandId", "reviewerProfileId", "comment"]);
  if (input.comment !== undefined && !text(input.comment, 10_000)) invalid();
  if (input.reviewerProfileId !== undefined && input.action !== "submit_review") invalid();
  return validateTaskWorkflowCommand(input);
}
export function parseMobileTaskMessage(value: unknown): MobileTaskMessageInput {
  const input = form(value, ["clientMessageId", "body"]);
  if (!isUuid(input.clientMessageId) || !text(input.body, 10_000) || !input.body.trim()) invalid("Správa musí mať 1 až 10 000 znakov.");
  return { clientMessageId: input.clientMessageId, body: input.body.trim() };
}

function parseParams(params: URLSearchParams, allowed: string[]) {
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) invalid("Neplatná stránka úloh.");
}
function decodeCursor(raw: string | null): Cursor | null {
  if (raw === null) return null;
  try {
    if (!raw || raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!value || value.v !== 1 || !isUuid(value.id) || !isHistoryTimestamp(value.createdAt) || typeof value.scope !== "string" || !/^[a-f0-9]{64}$/.test(value.scope)) throw new Error();
    return { id: value.id, createdAt: value.createdAt, scope: value.scope };
  } catch { invalid("Stránka už nie je platná. Obnovte zoznam."); }
}
function encodeCursor(cursor: Cursor) { return Buffer.from(JSON.stringify({ v: 1, ...cursor })).toString("base64url"); }
function scopeKey(actor: MotoristActor, resource: string, id: string) {
  return createHash("sha256").update(JSON.stringify(["mobile_task_v1", actor.organizationId, actor.profileId, resource, id])).digest("hex");
}
export function parseMobileTaskQuery(params: URLSearchParams): TaskQuery {
  parseParams(params, ["limit", "cursor"]);
  const limit = params.get("limit") ?? "25";
  if (!/^[1-9]\d?$/.test(limit) || Number(limit) > 25) invalid("Neplatná veľkosť stránky.");
  return { limit: Number(limit), cursor: decodeCursor(params.get("cursor")) };
}

export function parseMobileMyTaskQuery(params: URLSearchParams): MyTaskQuery {
  parseParams(params, ["view", "category", "q", "cursor", "limit"]);
  const view = params.get("view") ?? "assigned";
  const category = params.get("category") ?? "open";
  const rawQuery = params.get("q") ?? "";
  if (!choice(view, ["assigned", "review"] as const) || !choice(category, ["open", "all"] as const)) invalid("Neplatný filter úloh.");
  if (!text(rawQuery, 200)) invalid("Vyhľadávanie môže mať najviac 200 znakov.");
  // PostgREST converts every asterisk to a LIKE wildcard before SQL escaping.
  if (rawQuery.includes("*")) invalid("Vyhľadávanie nepodporuje hviezdičku. Zadajte inú časť názvu.");
  const paging = new URLSearchParams();
  for (const key of ["limit", "cursor"]) if (params.has(key)) paging.set(key, params.get(key)!);
  return { ...parseMobileTaskQuery(paging), view, category, q: rawQuery.trim() };
}

async function requireCase(actor: MotoristActor, id: string, client: UserClient) {
  taskId(id);
  const { data, error } = await client.from("motorist_cases").select("id").eq("organization_id", actor.organizationId).eq("id", id).maybeSingle();
  if (error) unavailable("Prípad sa nepodarilo overiť.");
  if (!data) throw new MutationError("Prípad nie je dostupný.", 404);
}
async function capabilities(actor: MotoristActor, client: UserClient): Promise<MobileTaskCapabilities> {
  // Settings are deliberately SELECT-only for service_role. This server-owned
  // config read grants no task access; task reads/RPCs keep the verified user.
  const [active, workflow] = await Promise.all([
    taskWorkspaceSystemEnabled(createSupabaseAdminClient(AbortSignal.timeout(8_000)), actor.organizationId),
    taskWorkflowEnabled(actor, client),
  ]);
  return { create: active, workflow: active && workflow, messages: active };
}
function eligible(client: UserClient, actor: MotoristActor) {
  return humansOnly(client.from("motorist_profiles").select("id,display_name")
    .eq("organization_id", actor.organizationId).eq("active", true).eq("access_status", "active")
    .not("user_id", "is", null).in("role", roles));
}
export async function listMobileTaskColleagues(actor: MotoristActor, client: UserClient): Promise<MobileTaskColleague[]> {
  const { data, error } = await eligible(client, actor).order("display_name").order("id").limit(201);
  if (error || !Array.isArray(data) || data.length > 200) unavailable("Kolegov sa nepodarilo načítať.");
  return data.map(row => {
    if (!isUuid(row.id) || !text(row.display_name, 200) || !row.display_name.trim()) unavailable();
    return { id: row.id, name: row.display_name };
  });
}
async function profileNames(actor: MotoristActor, ids: string[], client: UserClient): Promise<Names> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  if (unique.length > 50) unavailable();
  const { data, error } = await client.from("motorist_profiles").select("id,display_name")
    .eq("organization_id", actor.organizationId).in("id", unique).limit(unique.length + 1);
  if (error || !Array.isArray(data) || data.length > unique.length) unavailable("Mená kolegov sa nepodarilo načítať.");
  return new Map(data.map(row => {
    if (!isUuid(row.id) || !unique.includes(row.id) || !text(row.display_name, 200)) unavailable();
    return [row.id, row.display_name];
  }));
}
function fromRow(row: TaskDisplayRow) {
  return { id: row.id, title: row.title, status: row.status, priority: row.priority, kind: row.kind, revision: row.revision,
    assignedTo: row.assigned_to, reviewerProfileId: row.reviewer_profile_id, originLocked: row.origin_locked,
    createdBy: row.created_by, dueAt: row.due_at, createdAt: row.created_at, updatedAt: row.updated_at,
    workflowState: row.workflow_state, reviewSubmission: row.review_submission, reviewReturnReason: row.review_return_reason };
}
function taskPeople(value: unknown): string[] {
  const task = object(value);
  return [optionalId(task.assignedTo), optionalId(task.reviewerProfileId)].filter((id): id is string => id !== null);
}
function safeTask(value: unknown, actor: MotoristActor, names: Names): MobileTask {
  const task = object(value);
  const workflowState = task.workflowState;
  if (!isUuid(task.id) || !text(task.title, 500) || !task.title.trim() || !choice(task.status, statuses)
    || !choice(task.priority, priorities) || !choice(task.kind, kinds) || !revision(task.revision)
    || typeof task.originLocked !== "boolean" || !isHistoryTimestamp(task.createdAt) || !isHistoryTimestamp(task.updatedAt)
    || workflowState !== undefined && workflowState !== null && !choice(workflowState, taskWorkflowStates)) unavailable();
  const person = (id: string | null): MobileTaskColleague | null => id ? { id, name: names.get(id) ?? "Neznámy kolega" } : null;
  return { id: task.id, title: task.title, status: task.status, priority: task.priority, kind: task.kind,
    revision: task.revision, workflowState: taskWorkflowState({ status: task.status, workflowState: workflowState ?? undefined }), originLocked: task.originLocked,
    assignedTo: person(optionalId(task.assignedTo)), reviewer: person(optionalId(task.reviewerProfileId)), dueAt: taskDueAt(task.dueAt),
    createdAt: task.createdAt, updatedAt: task.updatedAt, createdByMe: task.createdBy === actor.profileId,
    reviewSubmission: optionalText(task.reviewSubmission, 10_000), reviewReturnReason: optionalText(task.reviewReturnReason, 10_000) };
}

export async function listMobileMyTasks(actor: MotoristActor, query: MyTaskQuery, client: UserClient): Promise<Pick<MobileMyTasks, "tasks" | "nextCursor" | "capabilities" | "selection">> {
  const selection = { view: query.view, category: query.category, q: query.q };
  const scope = scopeKey(actor, "my_tasks", JSON.stringify(selection));
  if (query.cursor && query.cursor.scope !== scope) invalid("Stránka patrí inému filtru alebo prihláseniu.");
  const ownerColumn = query.view === "assigned" ? "assigned_to" : "reviewer_profile_id";
  const page = () => {
    let read = client.from("motorist_case_tasks")
      .select("id,organization_id,title,status,priority,kind,revision,assigned_to,reviewer_profile_id,origin_locked,created_by,due_at,created_at,updated_at,workflow_state,review_submission,review_return_reason")
      .eq("organization_id", actor.organizationId).eq(ownerColumn, actor.profileId)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(query.limit + 1);
    if (query.category === "open") read = read.neq("status", "done");
    if (query.q) read = read.ilike("title", `%${query.q.replace(/[\\%_]/g, character => `\\${character}`)}%`);
    return read;
  };
  // Equal timestamps precede older timestamps; retain PostgreSQL microseconds.
  const pages = query.cursor ? await Promise.all([
    page().eq("created_at", query.cursor.createdAt).lt("id", query.cursor.id),
    page().lt("created_at", query.cursor.createdAt),
  ]) : [await page()];
  if (pages.some(result => result.error || !Array.isArray(result.data) || result.data.length > query.limit + 1)) unavailable("Vaše úlohy sa nepodarilo načítať.");
  const rows = pages.flatMap(result => result.data ?? []).slice(0, query.limit + 1);
  if (rows.some(row => row.organization_id !== actor.organizationId || row[ownerColumn] !== actor.profileId
    || !isUuid(row.id) || !isHistoryTimestamp(row.created_at) || query.category === "open" && row.status === "done")
    || new Set(rows.map(row => row.id)).size !== rows.length) unavailable();
  const selected = rows.slice(0, query.limit).map(fromRow);
  const [names, enabled] = await Promise.all([
    profileNames(actor, selected.flatMap(taskPeople), client), capabilities(actor, client),
  ]);
  const last = selected.at(-1);
  return {
    tasks: selected.map(task => safeTask(task, actor, names)), capabilities: enabled, selection,
    nextCursor: rows.length > query.limit && last ? encodeCursor({ id: last.id, createdAt: last.createdAt, scope }) : null,
  };
}

export async function listMobileCaseTasks(actor: MotoristActor, caseId: string, query: TaskQuery, client: UserClient): Promise<Pick<MobileCaseTasks, "caseId" | "tasks" | "nextCursor" | "capabilities">> {
  const scope = scopeKey(actor, "links", taskId(caseId));
  if (query.cursor && query.cursor.scope !== scope) invalid("Stránka patrí inému prípadu alebo prihláseniu.");
  await requireCase(actor, caseId, client);
  const page = () => client.from("motorist_task_case_links").select("task_id,created_at")
    .eq("organization_id", actor.organizationId).eq("case_id", caseId)
    .order("created_at", { ascending: false }).order("task_id", { ascending: false }).limit(query.limit + 1);
  const pages = query.cursor ? await Promise.all([
    page().eq("created_at", query.cursor.createdAt).lt("task_id", query.cursor.id), page().lt("created_at", query.cursor.createdAt),
  ]) : [await page()];
  if (pages.some(result => result.error || !Array.isArray(result.data))) unavailable("Väzby úloh sa nepodarilo načítať.");
  const links = pages.flatMap(result => result.data ?? []).slice(0, query.limit + 1);
  if (links.some(link => !isUuid(link.task_id) || !isHistoryTimestamp(link.created_at)) || new Set(links.map(link => link.task_id)).size !== links.length) unavailable();
  const selected = links.slice(0, query.limit);
  const rows = selected.length ? await client.from("motorist_case_tasks").select("*").eq("organization_id", actor.organizationId)
    .in("id", selected.map(link => link.task_id)).limit(query.limit + 1) : { data: [], error: null };
  if (rows.error || !Array.isArray(rows.data) || rows.data.length !== selected.length || new Set(rows.data.map(row => row.id)).size !== rows.data.length) unavailable("Zoznam úloh sa zmenil. Obnovte ho.");
  const byId = new Map(rows.data.map(row => [row.id, fromRow(row)]));
  if (selected.some(link => !byId.has(link.task_id))) unavailable();
  const [names, enabled] = await Promise.all([profileNames(actor, [...byId.values()].flatMap(taskPeople), client), capabilities(actor, client)]);
  const last = selected.at(-1);
  return { caseId, tasks: selected.map(link => safeTask(byId.get(link.task_id), actor, names)), capabilities: enabled,
    nextCursor: links.length > query.limit && last ? encodeCursor({ id: last.task_id, createdAt: last.created_at, scope }) : null };
}

export async function getMobileTask(actor: MotoristActor, id: string, client: UserClient): Promise<Pick<MobileTaskDetail, "task" | "linkedCases" | "capabilities">> {
  const task = await loadWorkspaceTask(actor, taskId(id), client);
  if (!task || task.id !== id || !Array.isArray(task.caseLinks) || task.caseLinks.length > 100) unavailable();
  const linkedCases = task.caseLinks.map(link => {
    if (!isUuid(link.caseId) || !text(link.caseNumber, 100) || !text(link.status, 80)) unavailable();
    return { id: link.caseId, caseNumber: link.caseNumber, status: link.status };
  });
  if (new Set(linkedCases.map(link => link.id)).size !== linkedCases.length) unavailable();
  const [names, enabled] = await Promise.all([profileNames(actor, taskPeople(task), client), capabilities(actor, client)]);
  return { task: safeTask(task, actor, names), linkedCases, capabilities: enabled };
}

export async function createMobileTask(actor: MotoristActor, caseId: string, value: MobileTaskCreateInput, client: UserClient): Promise<Pick<MobileTaskCreated, "caseId" | "taskId" | "refreshRequired">> {
  const input = parseMobileTaskCreate(value);
  await requireCase(actor, caseId, client);
  if (input.assignedTo) {
    const { data, error } = await eligible(client, actor).eq("id", input.assignedTo).maybeSingle();
    if (error) unavailable("Kolegu sa nepodarilo overiť.");
    if (!data) invalid("Vyberte aktívneho kolegu s prístupom do aplikácie.");
  }
  try {
    const task = await createWorkspaceTask(actor, { ...input, caseIds: [caseId] }, client);
    if (!task || !isUuid(task.id) || !revision(task.revision) || task.createdBy !== actor.profileId || !Array.isArray(task.caseIds)
      || task.caseIds.length !== 1 || task.caseIds[0] !== caseId || task.title !== input.title) unavailable();
    return { caseId, taskId: task.id, refreshRequired: true };
  } catch (error) {
    if (error instanceof MutationError && error.status < 500) throw error;
    throw new MutationError("Uloženie úlohy sa nepodarilo potvrdiť. Pred ďalším pokusom skontrolujte zoznam.", 503, "mobile_task_create_uncertain");
  }
}
export async function transitionMobileTask(actor: MotoristActor, id: string, value: MobileTaskWorkflowInput, client: UserClient): Promise<Pick<MobileTaskTransitioned, "taskId" | "commandId" | "committedRevision" | "currentRevision" | "refreshRequired">> {
  const input = parseMobileTaskWorkflow(value);
  taskId(id);
  try {
    // Eligibility is checked by SQL after exact receipt lookup. A current
    // reviewer pre-read would reject a previously committed valid command.
    const receipt = await transitionWorkspaceTask(actor, id, { ...input }, client);
    if (receipt.committedRevision <= input.expectedRevision) unavailable();
    return { taskId: id, commandId: input.commandId, committedRevision: receipt.committedRevision, currentRevision: receipt.task.revision, refreshRequired: true };
  } catch (error) {
    if (error instanceof MutationError && error.status < 500) throw error;
    throw new MutationError("Zmenu stavu sa nepodarilo potvrdiť. Overte tú istú požiadavku.", 503, "mobile_task_workflow_unconfirmed");
  }
}

function safeMessage(value: unknown, task: string): MobileTaskMessage {
  const message = object(value);
  if (!isUuid(message.id) || message.taskId !== task || !isUuid(message.authorProfileId) || !isUuid(message.clientMessageId)
    || !text(message.authorName, 200) || !text(message.body, 10_000) || !message.body.trim() || !isHistoryTimestamp(message.createdAt)) unavailable();
  return { id: message.id, taskId: task, authorProfileId: message.authorProfileId, authorName: message.authorName, body: message.body, createdAt: message.createdAt, clientMessageId: message.clientMessageId };
}
export async function listMobileTaskMessages(actor: MotoristActor, id: string, params: URLSearchParams, client: UserClient): Promise<Pick<MobileTaskMessages, "taskId" | "messages" | "nextCursor">> {
  taskId(id); parseParams(params, ["cursor"]);
  const cursor = decodeCursor(params.get("cursor")), scope = scopeKey(actor, "messages", id);
  if (cursor && cursor.scope !== scope) invalid("Stránka patrí inej úlohe alebo prihláseniu.");
  const page = await loadTaskMessages(actor, id, cursor ? { id: cursor.id, createdAt: cursor.createdAt } : undefined, client);
  if (!page || !Array.isArray(page.messages) || page.messages.length > 50 || page.nextCursor === undefined) unavailable();
  const messages = page.messages.map(message => safeMessage(message, id));
  if (new Set(messages.map(message => message.id)).size !== messages.length) unavailable();
  if (page.nextCursor && (!isUuid(page.nextCursor.id) || !isHistoryTimestamp(page.nextCursor.createdAt)
    || !messages.length || page.nextCursor.id !== messages[0].id || page.nextCursor.createdAt !== messages[0].createdAt
    || cursor && page.nextCursor.id === cursor.id && page.nextCursor.createdAt === cursor.createdAt)) unavailable();
  return { taskId: id, messages, nextCursor: page.nextCursor ? encodeCursor({ ...page.nextCursor, scope }) : null };
}
export async function sendMobileTaskMessage(actor: MotoristActor, id: string, value: MobileTaskMessageInput, client: UserClient): Promise<Pick<MobileTaskMessageSent, "taskId" | "message" | "refreshRequired">> {
  const input = parseMobileTaskMessage(value);
  taskId(id);
  try {
    const message = safeMessage(await sendTaskMessage(actor, id, input, client), id);
    if (message.authorProfileId !== actor.profileId || message.clientMessageId !== input.clientMessageId || message.body !== input.body) unavailable();
    return { taskId: id, message, refreshRequired: true };
  } catch (error) {
    if (error instanceof MutationError && error.status < 500) throw error;
    throw new MutationError("Správu sa nepodarilo potvrdiť. Overte tú istú správu znova.", 503, "mobile_task_message_unconfirmed");
  }
}
