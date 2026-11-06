import type { EmployeeTask, TaskWorkspaceActivity, TaskWorkspaceCommand, TaskWorkspaceCreate, TaskWorkspaceDetail, TaskWorkspaceDirectory, TaskWorkspacePage, TaskWorkspacePerson, TaskWorkspaceReceipt, TaskWorkspaceScope, TaskWorkspaceTarget, TaskWorkspaceView, TaskAttachment, TaskAttachmentPrepare, TaskAttachmentUpload, TaskAttachmentDownload } from "../../../src/lib/mobile-task-workspace";
import { MobileApiError, type MobileTransport } from "../lib/api";
import type { MobileConfig } from "../lib/config";
import { draftDate, draftId } from "../drafts/port";

export type TaskListQuery = { view: TaskWorkspaceView; category: "open" | "done" | "all"; q: string; cursor?: string | null; dueFilter?: "all" | "today" | "overdue" };
export type TaskPhoto = TaskAttachment;
export type TaskPhotoPrepare = TaskAttachmentPrepare;
export type TaskPhotoGrant = TaskAttachmentUpload;
export type TaskPhotoRead = TaskAttachmentDownload;
export type EmployeeTasksApi = {
  list(query: TaskListQuery, signal?: AbortSignal): Promise<TaskWorkspacePage>;
  directory(q?: string, signal?: AbortSignal): Promise<TaskWorkspaceDirectory>;
  detail(id: string, cursor?: string | null, signal?: AbortSignal): Promise<TaskWorkspaceDetail>;
  create(input: TaskWorkspaceCreate): Promise<TaskWorkspaceReceipt>;
  command(id: string, input: TaskWorkspaceCommand): Promise<TaskWorkspaceReceipt>;
  photoPrepare?(id: string, input: TaskPhotoPrepare): Promise<TaskPhotoGrant>;
  photoConfirm?(id: string, photoId: string, input: { commandId: string; expectedRevision: number }): Promise<TaskWorkspaceReceipt>;
  photoRemove?(id: string, photoId: string, input: { commandId: string; expectedRevision: number }): Promise<TaskWorkspaceReceipt>;
  photoRead?(id: string, photoId: string): Promise<TaskPhotoRead>;
  photoUpload?(grant: TaskPhotoGrant, bytes: Uint8Array): Promise<void>;
  subscribeAccessLoss(listener: () => void): () => void;
};
const invalid = () => new MobileApiError("Odpoveď úloh sa nepodarilo overiť. Obnovte údaje.", 502, "task_workspace_contract");
const inputError = (message = "Skontrolujte údaje úlohy.") => new MobileApiError(message, 400);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max && !value.includes("\0");
const nullableText = (value: unknown, max: number) => value === null || text(value, max);
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const optionalDate = (value: unknown) => value === null || draftDate(value);
function person(value: unknown): TaskWorkspacePerson | null {
  if (value === null) return null;
  const item = object(value);
  if (!draftId(item.userId) || !text(item.displayName, 200) || !item.displayName.trim()) throw invalid();
  return { userId: item.userId, displayName: item.displayName };
}
export function taskChecklist(value: unknown, allowIncomplete = false): { id: string; title: string; done: boolean }[] {
  if (!Array.isArray(value) || value.length > 50) throw inputError("Checklist môže mať najviac 50 bodov.");
  const ids = new Set<string>();
  return value.map(raw => {
    const item = object(raw);
    if (!draftId(item.id) || !text(item.title, 300) || !allowIncomplete && !item.title.trim() || ids.has(item.id)
      || item.done !== undefined && typeof item.done !== "boolean" || Object.keys(item).some(key => !["id", "title", "done"].includes(key))) throw inputError("Skontrolujte body checklistu.");
    ids.add(item.id); return { id: item.id, title: allowIncomplete ? item.title : item.title.trim(), done: item.done === true };
  });
}
export function taskSchedule(value: unknown, allowIncomplete = false): { frequency: "daily" | "weekly"; time: string; weekday?: number } {
  const item = object(value);
  if (!["daily", "weekly"].includes(item.frequency as string) || typeof item.time !== "string" || !(allowIncomplete ? /^[0-9:]{0,5}$/.test(item.time) : /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item.time))
    || Object.keys(item).some(key => !["frequency", "time", "weekday"].includes(key))
    || item.frequency === "weekly" && (!Number.isInteger(item.weekday) || (item.weekday as number) < 1 || (item.weekday as number) > 7)
    || item.frequency === "daily" && item.weekday !== undefined && item.weekday !== null) throw inputError("Skontrolujte čas a deň opakovania.");
  return { frequency: item.frequency as "daily" | "weekly", time: item.time, ...(item.frequency === "weekly" ? { weekday: item.weekday as number } : {}) };
}
export function taskPhoto(value: unknown): TaskPhoto {
  const item = object(value);
  if (!draftId(item.id) || !text(item.fileName, 200) || !item.fileName.trim() || !["image/jpeg", "image/png"].includes(item.mimeType as string)
    || !positive(item.sizeBytes) || item.sizeBytes > 8 * 1024 * 1024 || !draftDate(item.createdAt)
    || item.canRemove !== undefined && typeof item.canRemove !== "boolean") throw invalid();
  return item as TaskPhoto;
}
export function employeeTask(value: unknown): EmployeeTask {
  const item = object(value);
  if (!draftId(item.id) || !text(item.title, 500) || !item.title.trim() || !text(item.description, 10_000)
    || !["todo", "in_progress", "in_review", "done"].includes(item.state as string)
    || !["urgent", "high", "normal", "low"].includes(item.priority as string) || !optionalDate(item.dueAt)
    || !positive(item.revision) || !draftDate(item.createdAt) || !draftDate(item.updatedAt)
    || !nullableText(item.reviewSubmission, 10_000) || !nullableText(item.reviewReturnReason, 10_000)
    || !Array.isArray(item.caseLinks) || item.caseLinks.length > 100) throw invalid();
  if (item.checklist !== undefined) { try { taskChecklist(item.checklist); } catch { throw invalid(); } }
  if (item.attachments !== undefined && (!Array.isArray(item.attachments) || item.attachments.length > 10)) throw invalid();
  if (Array.isArray(item.attachments)) {
    const photos = item.attachments.map(taskPhoto); if (new Set(photos.map(photo => photo.id)).size !== photos.length) throw invalid();
  }
  if (item.recurrence !== undefined && item.recurrence !== null) {
    const recurrence = object(item.recurrence);
    if (!draftId(recurrence.id) || !positive(recurrence.revision) || typeof recurrence.timeZone !== "string" || !["active", "paused", "needs_attention"].includes(recurrence.state as string)
      || recurrence.nextAt !== undefined && !optionalDate(recurrence.nextAt)
      || recurrence.issue !== undefined && !["creator_inactive", "recipient_unavailable"].includes(recurrence.issue as string)) throw invalid();
    try { taskSchedule({ frequency: recurrence.frequency, time: recurrence.time, ...(recurrence.frequency === "weekly" ? { weekday: recurrence.weekday } : {}) });
      new Intl.DateTimeFormat("sk-SK", { timeZone: recurrence.timeZone }); } catch { throw invalid(); }
  }
  person(item.createdBy); person(item.assignee); person(item.reviewer);
  if (item.group !== null) {
    const group = object(item.group);
    if (!draftId(group.id) || !text(group.name, 200) || !group.name.trim()) throw invalid();
  }
  const permissions = object(item.permissions);
  for (const key of ["start", "complete", "reopen", "claim", "assign", "comment", "submitReview", "approve", "return"]) {
    if (typeof permissions[key] !== "boolean") throw invalid();
  }
  for (const key of ["editChecklist", "manageRecurrence", "attach"]) if (permissions[key] !== undefined && typeof permissions[key] !== "boolean") throw invalid();
  const ids = new Set<string>();
  for (const value of item.caseLinks) {
    const link = object(value);
    if (!draftId(link.id) || !text(link.number, 160) || ids.has(link.id)) throw invalid();
    ids.add(link.id);
  }
  return item as EmployeeTask;
}
function target(value: unknown): TaskWorkspaceTarget {
  const item = object(value);
  if (item.kind === "person" && draftId(item.userId) && Object.keys(item).every(key => ["kind", "userId"].includes(key))) return { kind: "person", userId: item.userId };
  if (item.kind === "group" && draftId(item.groupId) && Object.keys(item).every(key => ["kind", "groupId"].includes(key))) return { kind: "group", groupId: item.groupId };
  throw inputError("Vyberte kolegu alebo pobočku.");
}
export function taskCreateInput(value: unknown): TaskWorkspaceCreate {
  const item = object(value);
  const allowed = ["commandId", "title", "target", "description", "dueAt", "priority", "caseId", "checklist", "recurrence"];
  if (Object.keys(item).some(key => !allowed.includes(key)) || !draftId(item.commandId) || !text(item.title, 500) || !item.title.trim()
    || item.description !== undefined && !text(item.description, 10_000)
    || item.dueAt !== undefined && !optionalDate(item.dueAt)
    || item.priority !== undefined && !["urgent", "high", "normal", "low"].includes(item.priority as string)
    || item.caseId !== undefined && item.caseId !== null && !draftId(item.caseId)) throw inputError();
  return { ...item, target: target(item.target), title: item.title.trim(),
    ...(item.checklist === undefined ? {} : { checklist: taskChecklist(item.checklist) }),
    ...(item.recurrence === undefined ? {} : { recurrence: taskSchedule(item.recurrence) }) } as TaskWorkspaceCreate;
}
export function taskCommandInput(value: unknown): TaskWorkspaceCommand {
  const item = object(value);
  if (!draftId(item.commandId) || !positive(item.expectedRevision)) throw inputError();
  const action = item.action;
  const extras = action === "assign" ? ["target"] : action === "comment" ? ["body"] : action === "submit_review" ? ["reviewerUserId", "comment"] : action === "return" ? ["comment"] : action === "checklist" ? ["items"] : action === "recurrence" ? ["schedule", "expectedSeriesRevision"] : (action === "complete" || action === "approve") ? ["allowIncompleteChecklist"] : [];
  if (!["assign", "comment", "submit_review", "return", "claim", "start", "complete", "reopen", "approve", "checklist", "recurrence"].includes(action as string)
    || Object.keys(item).some(key => !["commandId", "expectedRevision", "action", ...extras].includes(key))) throw inputError();
  if (action === "checklist") taskChecklist(item.items);
  if (action === "recurrence" && item.expectedSeriesRevision !== undefined && !positive(item.expectedSeriesRevision)) throw inputError();
  if (action === "recurrence" && item.schedule !== null) taskSchedule(item.schedule);
  if ((action === "complete" || action === "approve") && item.allowIncompleteChecklist !== undefined && item.allowIncompleteChecklist !== true) throw inputError();
  if (action === "assign") target(item.target);
  if (action === "comment" && (!text(item.body, 10_000) || !item.body.trim())) throw inputError("Napíšte správu.");
  if ((action === "return" || action === "submit_review") && (!text(item.comment, 10_000) || !item.comment.trim())) throw inputError("Doplňte krátky komentár.");
  if (action === "submit_review" && !draftId(item.reviewerUserId)) throw inputError();
  return item as TaskWorkspaceCommand;
}

export function createEmployeeTasksApi(config: MobileConfig, getToken: () => Promise<string | null>, userId: string,
  organizationId?: string, transport: MobileTransport = fetch): EmployeeTasksApi {
  if (!draftId(userId) || organizationId !== undefined && !draftId(organizationId)) throw inputError();
  let organization = organizationId;
  const listeners = new Set<() => void>();
  const lost = () => { for (const notify of listeners) notify(); };
  function scope(value: unknown): TaskWorkspaceScope & Record<string, unknown> {
    const item = object(value);
    if (item.ok !== true || item.apiVersion !== 1 || item.environment !== config.environment || item.userId !== userId
      || !draftId(item.organizationId) || !draftDate(item.checkedAt) || organization && item.organizationId !== organization) {
      lost(); throw invalid();
    }
    organization = item.organizationId;
    return item as TaskWorkspaceScope & Record<string, unknown>;
  }
  async function request(path: string, method = "GET", input?: object, signal?: AbortSignal): Promise<unknown> {
    const token = await getToken();
    if (!token) { lost(); throw new MobileApiError("Prihláste sa znova.", 401); }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 12_000);
    try {
      const response = await transport(config.apiOrigin + "/api/mobile/v1/tasks/workspace" + path, {
        method, credentials: "omit", signal: controller.signal,
        headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": config.environment, Accept: "application/json",
          ...(organization ? { "X-PM-Expected-Organization": organization } : {}), ...(input ? { "Content-Type": "application/json" } : {}) },
        ...(input ? { body: JSON.stringify(input) } : {}),
      });
      const raw = await response.text();
      if (raw.length > 2 * 1024 * 1024) throw invalid();
      let body: unknown; try { body = JSON.parse(raw); } catch { throw invalid(); }
      if (!response.ok) {
        const error = object(body);
        const taskCommandDenied = response.status === 403 && (/^\/[^/]+\/photos(?:\/|$)/.test(path) || method === "POST" && path.endsWith("/commands"));
        if (response.status === 401 || response.status === 403 && !taskCommandDenied
          || error.code === "employee_access_revoked" || error.code === "expected_organization_mismatch") lost();
        throw new MobileApiError(text(error.error, 1000) ? error.error : "Úlohy sa nepodarilo načítať.", response.status,
          text(error.code, 100) ? error.code : undefined);
      }
      return body;
    } catch (error) {
      if (error instanceof MobileApiError || signal?.aborted) throw error;
      throw new MobileApiError("Spojenie sa prerušilo. Skontrolujte internet a skúste znova.", 0);
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  function cursor(value: unknown, previous?: string | null): string | null {
    if (value !== null && (!text(value, 4096) || !value || value === previous)) throw invalid();
    return value as string | null;
  }
  function receipt(value: unknown, commandId: string, taskId?: string): TaskWorkspaceReceipt {
    const item = scope(value), task = employeeTask(item.task);
    if (item.commandId !== commandId || !positive(item.committedRevision) || item.committedRevision > task.revision || taskId && task.id !== taskId) throw invalid();
    return { ...item, task } as TaskWorkspaceReceipt;
  }
  return {
    subscribeAccessLoss: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    list: async (query, signal) => {
      if (!["mine", "branch", "created", "review"].includes(query.view) || !["open", "done", "all"].includes(query.category) || !text(query.q, 200) || query.dueFilter !== undefined && !["all", "today", "overdue"].includes(query.dueFilter)) throw inputError();
      const params = new URLSearchParams({ view: query.view, category: query.category, q: query.q, limit: "50" });
      if (query.cursor) params.set("cursor", query.cursor);
      if (query.dueFilter) params.set("dueFilter", query.dueFilter);
      const item = scope(await request("?" + params, "GET", undefined, signal));
      if (item.timeZone !== undefined) { try { if (typeof item.timeZone !== "string") throw invalid(); new Intl.DateTimeFormat("sk-SK", { timeZone: item.timeZone }); } catch { throw invalid(); } }
      if (item.view !== query.view || query.dueFilter && query.dueFilter !== "all" && item.dueFilter !== query.dueFilter || !Array.isArray(item.tasks) || item.tasks.length > 50) throw invalid();
      const tasks = item.tasks.map(employeeTask);
      if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw invalid();
      return { ...item, tasks, nextCursor: cursor(item.nextCursor, query.cursor) } as TaskWorkspacePage;
    },
    directory: async (q = "", signal) => {
      if (!text(q, 200)) throw inputError();
      const item = scope(await request("/directory?" + new URLSearchParams({ q }), "GET", undefined, signal));
      if (!Array.isArray(item.people) || item.people.length > 200 || !Array.isArray(item.groups) || item.groups.length > 200
        || typeof item.hasMorePeople !== "boolean" || typeof item.canLinkCases !== "boolean") throw invalid();
      if (item.timeZone !== undefined) { try { if (typeof item.timeZone !== "string") throw invalid(); new Intl.DateTimeFormat("sk-SK", { timeZone: item.timeZone }); } catch { throw invalid(); } }
      const people = item.people.map(value => { const p = person(value); if (!p) throw invalid(); return p; });
      const groups = item.groups.map(value => { const g = object(value); if (!draftId(g.id) || !text(g.name, 200) || !g.name.trim() || typeof g.canManage !== "boolean") throw invalid(); return g; });
      if (new Set(people.map(p => p.userId)).size !== people.length || new Set(groups.map(g => g.id)).size !== groups.length) throw invalid();
      return { ...item, people, groups } as TaskWorkspaceDirectory;
    },
    detail: async (id, before, signal) => {
      if (!draftId(id)) throw inputError();
      const item = scope(await request("/" + id + (before ? "?" + new URLSearchParams({ cursor: before }) : ""), "GET", undefined, signal));
      const task = employeeTask(item.task);
      if (task.id !== id || !Array.isArray(item.activity) || item.activity.length > 100) throw invalid();
      const activity = item.activity.map(value => {
        const row = object(value); person(row.author);
        if (!draftId(row.id) || !text(row.body, 10_000) || !draftDate(row.createdAt) || !["comment", "created", "assigned", "state"].includes(row.kind as string)) throw invalid();
        return row as TaskWorkspaceActivity;
      });
      if (new Set(activity.map(row => row.id)).size !== activity.length) throw invalid();
      return { ...item, task, activity, nextActivityCursor: cursor(item.nextActivityCursor, before) } as TaskWorkspaceDetail;
    },
    photoPrepare: async (id, input) => {
      if (!draftId(id) || !draftId(input.commandId) || !draftId(input.attachmentId) || !positive(input.expectedRevision)
        || !text(input.fileName, 200) || !input.fileName.trim() || new TextEncoder().encode(input.fileName).length > 240 || /[\x00-\x1f\x7f/\\]/.test(input.fileName) || !["image/jpeg", "image/png"].includes(input.mimeType)
        || !positive(input.sizeBytes) || input.sizeBytes > 8 * 1024 * 1024) throw inputError();
      const item = scope(await request("/" + id + "/photos", "POST", input));
      const prepared = receipt(item.receipt, input.commandId, id), attachment = taskPhoto(item.attachment), upload = object(item.upload);
      if (attachment.id !== input.attachmentId || attachment.mimeType !== input.mimeType || attachment.sizeBytes !== input.sizeBytes
        || !text(upload.url, 8192) || !text(upload.token, 8192) || !text(upload.path, 1000)
        || upload.method !== "PUT" || upload.contentType !== input.mimeType) throw invalid();
      const url = new URL(upload.url);
      if (url.origin !== config.supabaseUrl || !url.pathname.startsWith("/storage/v1/object/upload/sign/") || url.username || url.password || url.hash) throw invalid();
      return { ...item, receipt: prepared, attachment, upload } as TaskPhotoGrant;
    },
    photoConfirm: async (id, photoId, input) => {
      if (![id, photoId, input.commandId].every(draftId) || !positive(input.expectedRevision)) throw inputError();
      const confirmed = receipt(await request("/" + id + "/photos/" + photoId + "/confirm", "POST", input), input.commandId, id);
      if (!confirmed.task.attachments?.some(photo => photo.id === photoId)) throw invalid();
      return confirmed;
    },
    photoRemove: async (id, photoId, input) => {
      if (![id, photoId, input.commandId].every(draftId) || !positive(input.expectedRevision)) throw inputError();
      const removed = receipt(await request("/" + id + "/photos/" + photoId, "DELETE", input), input.commandId, id);
      if (!Array.isArray(removed.task.attachments) || removed.task.attachments.some(photo => photo.id === photoId)) throw invalid();
      return removed;
    },
    photoRead: async (id, photoId) => {
      if (![id, photoId].every(draftId)) throw inputError();
      const item = scope(await request("/" + id + "/photos/" + photoId));
      if (!text(item.url, 8192) || !draftDate(item.expiresAt) || Date.parse(item.expiresAt) <= Date.now()) throw invalid();
      const url = new URL(item.url);
      if (url.origin !== config.supabaseUrl || !url.pathname.startsWith("/storage/v1/object/sign/") || url.username || url.password || url.hash) throw invalid();
      const attachment = taskPhoto(item.attachment); if (attachment.id !== photoId) throw invalid();
      return { ...item, attachment, url: item.url, expiresAt: item.expiresAt } as TaskPhotoRead;
    },
    photoUpload: async (grant, bytes) => {
      if (bytes.length !== grant.attachment.sizeBytes || bytes.length > 8 * 1024 * 1024) throw inputError();
      const url = new URL(grant.upload.url);
      if (url.origin !== config.supabaseUrl || !url.pathname.startsWith("/storage/v1/object/upload/sign/")) throw invalid();
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30_000);
      try {
        const response = await transport(url.toString(), { method: grant.upload.method ?? "PUT", credentials: "omit", signal: controller.signal,
          headers: { "Content-Type": grant.attachment.mimeType, "x-upsert": "false" }, body: bytes.slice().buffer });
        if (!response.ok) {
          const body = (await response.text()).slice(0, 4000);
          // A lost successful upload is retried at the same immutable path.
          // Confirmation still verifies the actual object on the server.
          if ((response.status === 400 || response.status === 409) && /already exists|duplicate/i.test(body)) return;
          throw new MobileApiError("Fotografiu sa nepodarilo nahrať. Pokračujte v tom istom nahrávaní.", response.status);
        }
      } finally { clearTimeout(timer); }
    },
    create: async input => { const checked = taskCreateInput(input); return receipt(await request("", "POST", checked), checked.commandId); },
    command: async (id, input) => { if (!draftId(id)) throw inputError(); const checked = taskCommandInput(input); return receipt(await request("/" + id + "/commands", "POST", checked), checked.commandId, id); },
  };
}
