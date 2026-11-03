import type { MobileCaseAttachment, MobileCaseAttachmentAdded, MobileCaseAttachmentDownload, MobileCaseAttachmentInput, MobileCaseAttachments, MobileCaseTasks, MobileMyTaskFilter, MobileMyTasks, MobileScope, MobileTask, MobileTaskCapabilities, MobileTaskColleague, MobileTaskColleagues, MobileTaskCreated, MobileTaskCreateInput, MobileTaskDetail, MobileTaskMessage, MobileTaskMessageInput, MobileTaskMessages, MobileTaskMessageSent, MobileTaskTransitioned, MobileTaskWorkflowInput } from "../../../src/lib/mobile-api";
import { MobileApiError, type MobileTransport } from "../lib/api";
import type { UploadPayload } from "./attachments";
import type { MobileConfig } from "../lib/config";

const invalid = () => new MobileApiError("Odpoveď sa nepodarilo overiť. Obnovte údaje.", 502);
const text = (v: unknown): v is string => typeof v === "string";
const nullable = (v: unknown): v is string | null => v === null || text(v);
const id = (v: unknown): v is string => text(v) && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(v);
const date = (v: unknown): v is string => text(v) && Number.isFinite(Date.parse(v));
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== "object" || Array.isArray(v)) throw invalid(); return v as Record<string, unknown>; }
function array<T extends { id: string }>(value: unknown, max: number, parse: (v: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) throw invalid();
  const result = value.map(parse); if (new Set(result.map(v => v.id)).size !== result.length) throw invalid(); return result;
}
function colleague(value: unknown): MobileTaskColleague {
  const v = object(value); if (!id(v.id) || !text(v.name) || !v.name.trim()) throw invalid(); return { id: v.id, name: v.name };
}
function capabilities(value: unknown): MobileTaskCapabilities {
  const v = object(value); if (typeof v.create !== "boolean" || typeof v.workflow !== "boolean" || typeof v.messages !== "boolean") throw invalid();
  return { create: v.create, workflow: v.workflow, messages: v.messages };
}
function task(value: unknown): MobileTask {
  const v = object(value);
  if (!id(v.id) || !text(v.title) || !v.title.trim() || !["open", "done", "overdue"].includes(v.status as string)
    || !["urgent", "high", "normal", "low"].includes(v.priority as string) || !["callback", "sms", "dispatch", "documents", "billing", "handover", "other"].includes(v.kind as string)
    || !integer(v.revision) || !["todo", "in_progress", "in_review", "done"].includes(v.workflowState as string) || typeof v.originLocked !== "boolean"
    || !(v.dueAt === null || date(v.dueAt)) || !date(v.createdAt) || !date(v.updatedAt) || typeof v.createdByMe !== "boolean" || !nullable(v.reviewSubmission) || !nullable(v.reviewReturnReason)) throw invalid();
  return { id: v.id, title: v.title, status: v.status as MobileTask["status"], priority: v.priority as MobileTask["priority"], kind: v.kind as MobileTask["kind"], revision: v.revision,
    workflowState: v.workflowState as MobileTask["workflowState"], originLocked: v.originLocked, assignedTo: v.assignedTo === null ? null : colleague(v.assignedTo), reviewer: v.reviewer === null ? null : colleague(v.reviewer),
    dueAt: v.dueAt, createdAt: v.createdAt, updatedAt: v.updatedAt, createdByMe: v.createdByMe, reviewSubmission: v.reviewSubmission, reviewReturnReason: v.reviewReturnReason };
}
function message(value: unknown, taskId: string): MobileTaskMessage {
  const v = object(value); if (!id(v.id) || v.taskId !== taskId || !id(v.authorProfileId) || !text(v.authorName) || !text(v.body) || !v.body.trim() || v.body.length > 10_000 || !date(v.createdAt) || !id(v.clientMessageId)) throw invalid();
  return { id: v.id, taskId, authorProfileId: v.authorProfileId, authorName: v.authorName, body: v.body, createdAt: v.createdAt, clientMessageId: v.clientMessageId };
}
function attachment(value: unknown): MobileCaseAttachment {
  const v = object(value);
  if (!id(v.id) || !text(v.fileName) || !v.fileName || !["photo", "video", "document"].includes(v.category as string) || !nullable(v.mimeType)
    || !(v.sizeBytes === null || typeof v.sizeBytes === "number" && Number.isSafeInteger(v.sizeBytes) && v.sizeBytes >= 0) || !nullable(v.note)
    || !(v.createdAt === null || date(v.createdAt)) || typeof v.downloadable !== "boolean") throw invalid();
  return { id: v.id, fileName: v.fileName, category: v.category as MobileCaseAttachment["category"], mimeType: v.mimeType, sizeBytes: v.sizeBytes, note: v.note, createdAt: v.createdAt, downloadable: v.downloadable };
}
function pathId(value: string) { if (!id(value)) throw new MobileApiError("Záznam sa nenašiel.", 404); return value; }
function cursor(value: unknown, previous?: string | null) { if (!nullable(value) || value === "" || value !== null && value === previous) throw invalid(); return value; }
// Database revisions retain microseconds; Date.parse alone would accept
// an equal or older receipt within the same millisecond.
function compareRevision(left: string, right: string) {
  const milliseconds = Date.parse(left) - Date.parse(right);
  const micros = (value: string) => Number((value.match(/\.(\d+)/)?.[1] ?? "").padEnd(6, "0").slice(3, 6));
  return milliseconds || micros(left) - micros(right);
}
const nativeTransport = async (): Promise<MobileTransport> => {
  try { return (await import("expo/fetch")).fetch as MobileTransport; }
  catch { throw new MobileApiError("Prikladanie súborov v tejto zostave nie je dostupné. Použite aktuálne Expo Go alebo novú natívnu zostavu.", 400, "mobile_upload_unavailable"); }
};

export function createWorkApi(config: MobileConfig, profileId: string, getToken: () => Promise<string | null>, transport: MobileTransport = fetch, uploadTransport: () => Promise<MobileTransport> = nativeTransport, expectedOrganization?: string) {
  function scope(value: Record<string, unknown>): MobileScope {
    if (value.ok !== true || value.apiVersion !== 1 || value.environment !== config.environment || value.profileId !== profileId || !date(value.checkedAt)) throw invalid();
    return { ok: true, apiVersion: 1, environment: config.environment, profileId, checkedAt: value.checkedAt };
  }
  async function request(path: string, input?: unknown, signal?: AbortSignal, binary?: { bytes: Uint8Array; contentType: string }) {
    const token = await getToken(); if (!token) throw new MobileApiError("Prihláste sa do aplikácie.", 401);
    const controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted) abort(); signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, binary ? 60_000 : 20_000);
    try {
      const send = binary ? await uploadTransport() : transport;
      const response = await send(config.apiOrigin + "/api/mobile/v1/" + path, { method: input === undefined && !binary ? "GET" : "POST", credentials: "omit", signal: controller.signal,
        headers: { Authorization: "Bearer " + token, "X-PM-App-Environment": config.environment, Accept: "application/json", ...(expectedOrganization ? { "X-PM-Expected-Organization": expectedOrganization } : {}), ...(binary ? { "Content-Type": binary.contentType } : input === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(binary ? { body: binary.bytes as BodyInit } : input === undefined ? {} : { body: JSON.stringify(input) }) });
      let value: unknown; try { value = await response.json(); } catch { throw invalid(); }
      const body = object(value);
      if (!response.ok) throw new MobileApiError(text(body.error) ? body.error : "Požiadavku sa nepodarilo dokončiť.", response.status, text(body.code) ? body.code : undefined);
      scope(body); return body;
    } catch (error) {
      if (error instanceof MobileApiError || signal?.aborted) throw error;
      throw new MobileApiError("Spojenie sa prerušilo. Výsledok overte pred ďalším zápisom.", 0);
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  const casePath = (caseId: string) => "cases/" + pathId(caseId);
  const taskPath = (taskId: string) => "tasks/" + pathId(taskId);
  return {
    attachments: async (caseId: string, signal?: AbortSignal): Promise<MobileCaseAttachments> => {
      const body = await request(casePath(caseId) + "/attachments", undefined, signal);
      if (body.caseId !== caseId || !date(body.caseRevision)) throw invalid();
      return { ...scope(body), caseId, caseRevision: body.caseRevision, attachments: array(body.attachments, 200, attachment) };
    },
    upload: async (caseId: string, command: MobileCaseAttachmentInput, payload: UploadPayload): Promise<MobileCaseAttachmentAdded> => {
      const body = await request(casePath(caseId) + "/attachments", undefined, undefined, payload), item = attachment(body.attachment);
      if (body.caseId !== caseId || body.mutationId !== command.mutationId || item.id !== command.mutationId || item.fileName !== command.fileName || item.category !== command.category || item.mimeType !== payload.mimeType || item.sizeBytes !== payload.sizeBytes
        || (item.note ?? "") !== (command.note ?? "") || !date(body.committedRevision) || compareRevision(body.committedRevision, command.expectedUpdatedAt) <= 0 || body.refreshRequired !== true) throw invalid();
      return { ...scope(body), caseId, mutationId: command.mutationId, attachment: item, committedRevision: body.committedRevision, refreshRequired: true };
    },
    download: async (caseId: string, attachmentId: string): Promise<MobileCaseAttachmentDownload> => {
      const body = await request(casePath(caseId) + "/attachments/" + pathId(attachmentId) + "/download");
      if (body.caseId !== caseId || body.attachmentId !== attachmentId || !text(body.url) || !date(body.expiresAt) || Date.parse(body.expiresAt) <= Date.now()) throw invalid();
      let url: URL; try { url = new URL(body.url); } catch { throw invalid(); }
      let segments: string[];
      try { segments = url.pathname.split("/").map(segment => decodeURIComponent(segment)); } catch { throw invalid(); }
      if (segments.slice(0, 6).join("/") !== "/storage/v1/object/sign/motorist-case-attachments" || !id(segments[6]) || segments[7] !== "cases" || segments[8] !== caseId || segments.length < 10
        || url.href !== body.url || segments.slice(6).some(segment => !segment || segment === "." || segment === ".." || /[%/\\\x00-\x20\x7f?#]/.test(segment))) throw invalid();
      if (url.protocol !== "https:" || url.origin !== config.supabaseUrl || url.username || url.password || url.hash || !url.pathname.startsWith("/storage/v1/object/sign/") || !url.searchParams.get("token")) throw invalid();
      return { ...scope(body), caseId, attachmentId, url: body.url, expiresAt: body.expiresAt };
    },
    tasks: async (caseId: string, after?: string | null, signal?: AbortSignal): Promise<MobileCaseTasks & { requestedAt: number }> => {
      const requestedAt = Date.now(), params = new URLSearchParams({ limit: "25" }); if (after) params.set("cursor", after);
      const body = await request(casePath(caseId) + "/tasks?" + params, undefined, signal); if (body.caseId !== caseId) throw invalid();
      return { ...scope(body), caseId, tasks: array(body.tasks, 25, task), nextCursor: cursor(body.nextCursor, after), capabilities: capabilities(body.capabilities), requestedAt };
    },
    myTasks: async (filter: MobileMyTaskFilter = { view: "assigned", category: "open", q: "" }, signal?: AbortSignal): Promise<MobileMyTasks> => {
      if (!["assigned", "review"].includes(filter.view) || !["open", "all"].includes(filter.category) || !text(filter.q) || filter.q.length > 200 || /[\0*]/.test(filter.q)
        || !(filter.cursor == null || text(filter.cursor) && filter.cursor.length > 0)) throw new MobileApiError("Skontrolujte filter úloh. Hľadajte najviac 200 znakmi bez hviezdičky.", 400);
      const selection = { view: filter.view, category: filter.category, q: filter.q.trim() };
      const params = new URLSearchParams({ ...selection, limit: "25" });
      if (filter.cursor) params.set("cursor", filter.cursor);
      const body = await request("tasks?" + params, undefined, signal), echoed = object(body.selection);
      if (echoed.view !== selection.view || echoed.category !== selection.category || echoed.q !== selection.q) throw invalid();
      const tasks = array(body.tasks, 25, task);
      if (tasks.some(item => (selection.view === "assigned" ? item.assignedTo?.id : item.reviewer?.id) !== profileId || selection.category === "open" && item.status === "done")) throw invalid();
      return { ...scope(body), tasks, nextCursor: cursor(body.nextCursor, filter.cursor), capabilities: capabilities(body.capabilities), selection };
    },
    task: async (taskId: string, signal?: AbortSignal): Promise<MobileTaskDetail> => {
      const body = await request(taskPath(taskId), undefined, signal), item = task(body.task); if (item.id !== taskId) throw invalid();
      const linkedCases = array(body.linkedCases, 100, value => { const v = object(value); if (!id(v.id) || !text(v.caseNumber) || !text(v.status)) throw invalid(); return { id: v.id, caseNumber: v.caseNumber, status: v.status }; });
      return { ...scope(body), task: item, linkedCases, capabilities: capabilities(body.capabilities) };
    },
    colleagues: async (signal?: AbortSignal): Promise<MobileTaskColleagues> => { const body = await request("tasks/colleagues", undefined, signal); return { ...scope(body), colleagues: array(body.colleagues, 200, colleague) }; },
    createTask: async (caseId: string, input: MobileTaskCreateInput): Promise<MobileTaskCreated> => {
      const body = await request(casePath(caseId) + "/tasks", input); if (body.caseId !== caseId || !id(body.taskId) || body.refreshRequired !== true) throw invalid();
      return { ...scope(body), caseId, taskId: body.taskId, refreshRequired: true };
    },
    transition: async (taskId: string, input: MobileTaskWorkflowInput): Promise<MobileTaskTransitioned> => {
      const body = await request(taskPath(taskId) + "/workflow", input);
      if (body.taskId !== taskId || body.commandId !== input.commandId || !integer(body.committedRevision) || body.committedRevision <= input.expectedRevision || !integer(body.currentRevision) || body.currentRevision < body.committedRevision || body.refreshRequired !== true) throw invalid();
      return { ...scope(body), taskId, commandId: input.commandId, committedRevision: body.committedRevision, currentRevision: body.currentRevision, refreshRequired: true };
    },
    messages: async (taskId: string, after?: string | null, signal?: AbortSignal): Promise<MobileTaskMessages> => {
      const params = new URLSearchParams(); if (after) params.set("cursor", after);
      const body = await request(taskPath(taskId) + "/messages?" + params, undefined, signal); if (body.taskId !== taskId) throw invalid();
      return { ...scope(body), taskId, messages: array(body.messages, 50, v => message(v, taskId)), nextCursor: cursor(body.nextCursor, after) };
    },
    sendMessage: async (taskId: string, input: MobileTaskMessageInput): Promise<MobileTaskMessageSent> => {
      const body = await request(taskPath(taskId) + "/messages", input), item = message(body.message, taskId);
      if (body.taskId !== taskId || item.authorProfileId !== profileId || item.clientMessageId !== input.clientMessageId || item.body !== input.body || body.refreshRequired !== true) throw invalid();
      return { ...scope(body), taskId, message: item, refreshRequired: true };
    },
  };
}
export type WorkApi = ReturnType<typeof createWorkApi>;
