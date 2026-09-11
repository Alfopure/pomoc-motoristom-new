import "server-only";
import type { MotoristActor } from "./api-auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { MutationError } from "./mutation-error";
import { TASK_LINK_LIMIT, TASK_MESSAGE_LIMIT, type TaskMessage, type TaskMessageCursor, type TaskMessagePage, type WorkspaceTask } from "@/domain/task-workspace";
export type TaskWorkspaceActor = Pick<MotoristActor, "organizationId" | "profileId">;
export const TASK_WORKSPACE_ROLES = ["dispatcher", "senior_dispatcher", "manager", "admin"] as const;
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function taskId(value: unknown): string { if (typeof value !== "string" || !uuid.test(value)) throw new MutationError("Neplatné ID úlohy alebo prípadu.", 400); return value; }
export function taskResponse(body: unknown, status = 200) { return Response.json(body, { status, headers }); }
export function taskErrorResponse(error: unknown) { return taskResponse({ error: error instanceof MutationError ? error.message : "Úlohu sa nepodarilo spracovať." }, error instanceof MutationError ? error.status : 503); }
export async function readTaskBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text(); if (text.length > 70_000) throw new MutationError("Požiadavka je príliš veľká.", 413);
  let value: unknown; try { value = JSON.parse(text); } catch { throw new MutationError("Neplatný formát požiadavky.", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MutationError("Neplatný formát požiadavky.", 400);
  return value as Record<string, unknown>;
}
function revision(value: unknown) { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new MutationError("Chýba aktuálna verzia úlohy.", 400); return value; }
export function validateTaskInput(input: Record<string, unknown>, create = false): Record<string, unknown> {
  const result: Record<string, unknown> = create ? {} : { expectedRevision: revision(input.expectedRevision) };
  if (create || "title" in input) { if (typeof input.title !== "string" || !input.title.trim() || input.title.trim().length > 500) throw new MutationError("Úloha potrebuje názov (najviac 500 znakov).", 400); result.title = input.title.trim(); }
  if ("assignedTo" in input) result.assignedTo = input.assignedTo === null || input.assignedTo === "" || input.assignedTo === "unassigned" ? null : taskId(input.assignedTo);
  for (const key of ["dueAt", "reminderAt"]) { if (key in input) { const value = input[key]; if (value === null || value === "") result[key] = null; else if (typeof value === "string" && Number.isFinite(Date.parse(value))) result[key] = new Date(value).toISOString(); else throw new MutationError("Neplatný termín úlohy alebo pripomienky.", 400); } }
  for (const [key, values] of Object.entries({ priority: ["urgent", "high", "normal", "low"], kind: ["callback", "sms", "dispatch", "documents", "billing", "handover", "other"], status: ["open", "done", "overdue"] })) {
    if (key in input) { if (typeof input[key] !== "string" || !values.includes(input[key] as string)) throw new MutationError("Neplatné nastavenie úlohy.", 400); result[key] = input[key]; }
  }
  if ("caseIds" in input || create) {
    const caseIds = input.caseIds ?? [];
    if (!Array.isArray(caseIds) || caseIds.length > TASK_LINK_LIMIT || new Set(caseIds).size !== caseIds.length) throw new MutationError("Skontrolujte pripojené prípady.", 400);
    result.caseIds = caseIds.map(taskId);
  }
  if (input.note !== undefined) { if (typeof input.note !== "string" || input.note.length > 10_000) throw new MutationError("Poznámka k zmene je príliš dlhá.", 400); result.note = input.note.trim(); }
  if ("reminderChannels" in input) {
    if (!Array.isArray(input.reminderChannels) || !input.reminderChannels.length || input.reminderChannels.some(channel => channel !== "in_app" && channel !== "email")) throw new MutationError("Neplatné kanály pripomienky.", 400);
    result.reminderChannels = [...new Set(input.reminderChannels)];
  }
  return result;
}
async function workspaceRpc<T>(actor: TaskWorkspaceActor, action: string, id?: string, input: Record<string, unknown> = {}): Promise<T> {
  const client = await createSupabaseServerClient();
  const { data, error } = await client.rpc("motorist_task_workspace", { p_organization_id: actor.organizationId, p_actor_profile_id: actor.profileId, p_action: action, p_task_id: id ? taskId(id) : null, p_input: input });
  if (error) {
    const status = error.code === "42501" ? 403 : error.code === "P0002" ? 404 : error.code === "PT409" || error.code === "40001" || error.code === "23505" ? 409 : error.code === "22023" || error.code === "22P02" ? 400 : 503;
    const message = error.code === "55000" ? "Nové úlohy ešte nie sú aktivované. Vyžaduje sa kompatibilná databáza a overenie všetkých zapisujúcich verzií aplikácie." : status === 409 ? "Úloha sa medzičasom zmenila. Načítajte aktuálnu verziu." : status === 403 || status === 404 ? "Úloha nie je dostupná alebo nemáte oprávnenie." : status === 400 ? "Skontrolujte údaje úlohy a jej väzby." : "Úlohu sa nepodarilo spracovať. Skúste to znova.";
    throw new MutationError(message, status);
  }
  if ((action === "create" || action === "update") && data && typeof data === "object" && "id" in data && typeof data.id === "string") {
    try {
      const [{ createSupabaseAdminClient }, { deliverTaskAssignmentNotifications }] = await Promise.all([
        import("@/lib/supabase/admin"), import("./task-notifications"),
      ]);
      await deliverTaskAssignmentNotifications(createSupabaseAdminClient(), actor.organizationId, data.id);
    } catch { /* Task and bell are committed; the existing cron retries the durable outbox. */ }
  }
  return data as T;
}
export function loadTaskWorkspace(actor: TaskWorkspaceActor) { return workspaceRpc<WorkspaceTask[]>(actor, "list"); }
export function loadWorkspaceTask(actor: TaskWorkspaceActor, id: string) { return workspaceRpc<WorkspaceTask>(actor, "get", id); }
export function createWorkspaceTask(actor: TaskWorkspaceActor, input: Record<string, unknown>) { return workspaceRpc<WorkspaceTask>(actor, "create", undefined, validateTaskInput(input, true)); }
export function updateWorkspaceTask(actor: TaskWorkspaceActor, id: string, input: Record<string, unknown>) { return workspaceRpc<WorkspaceTask>(actor, "update", id, validateTaskInput(input)); }
export function deleteWorkspaceTask(actor: TaskWorkspaceActor, id: string, expectedRevision: unknown, note?: string) { return workspaceRpc<{ deleted: true }>(actor, "delete", id, validateTaskInput({ expectedRevision, note })); }
export function linkWorkspaceTask(actor: TaskWorkspaceActor, id: string, caseId: unknown, expectedRevision: unknown, unlink = false) { return workspaceRpc<WorkspaceTask>(actor, unlink ? "unlink" : "link", id, { caseId: taskId(caseId), expectedRevision: revision(expectedRevision) }); }
export function loadTaskMessages(actor: TaskWorkspaceActor, id: string, cursor?: TaskMessageCursor) {
  if (cursor && (!Number.isFinite(Date.parse(cursor.createdAt)) || !uuid.test(cursor.id))) throw new MutationError("Neplatná stránka správ.", 400);
  return workspaceRpc<TaskMessagePage>(actor, "messages", id, cursor ? { beforeCreatedAt: cursor.createdAt, beforeId: cursor.id } : {});
}
export function sendTaskMessage(actor: TaskWorkspaceActor, id: string, input: Record<string, unknown>) {
  if (typeof input.body !== "string" || !input.body.trim() || input.body.length > TASK_MESSAGE_LIMIT) throw new MutationError("Správa musí mať 1 až 10 000 znakov.", 400);
  return workspaceRpc<TaskMessage>(actor, "send_message", id, { body: input.body.trim(), clientMessageId: taskId(input.clientMessageId) });
}
