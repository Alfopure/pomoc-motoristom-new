import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { TASK_PHOTO_MAX_BYTES, type TaskAttachment, type TaskAttachmentCommand, type TaskAttachmentDownload, type TaskAttachmentPrepare, type TaskAttachmentUpload, type TaskWorkspaceReceipt } from "@/lib/mobile-task-workspace";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabasePublicEnv } from "@/lib/supabase/env";
import { isUuid } from "@/lib/telephony/uuid";
import { MutationError } from "@/server/mutation-error";
import { callEmployeeTask, employeeTaskAttachment, employeeTaskReceipt, employeeTaskScope, type EmployeeTaskActor } from "./employee-tasks";

const BUCKET = "motorist-task-photos", URL_SECONDS = 60;
type ObjectRow = Record<string, unknown>;
type StoredAttachment = TaskAttachment & { bucket: string; path: string; status?: string };
const unconfirmed = () => new MutationError("Fotografiu sa nepodarilo overiť. Zachovajte pôvodnú požiadavku a skúste znova.", 503, "task_photo_unconfirmed");
const invalid = () => new MutationError("Skontrolujte údaje fotografie.", 400);
const mismatch = () => new MutationError("Fotografia sa nezhoduje s nahrávaním. Zahoďte tento výber a pridajte fotografiu znova.", 422, "task_photo_storage_mismatch");
function object(value: unknown, failure = invalid): ObjectRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure();
  return value as ObjectRow;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !isUuid(value)) throw invalid();
  return value.toLowerCase();
}
function taskId(value: unknown) { return identifier(value); }
function command(value: unknown, allowed: readonly string[]): TaskAttachmentCommand & ObjectRow {
  const row = object(value);
  if (Object.keys(row).some(key => !["commandId", "expectedRevision", ...allowed].includes(key))
    || !Number.isSafeInteger(row.expectedRevision) || (row.expectedRevision as number) < 1 || (row.expectedRevision as number) > 2_147_483_647) throw invalid();
  return { ...row, commandId: identifier(row.commandId), expectedRevision: row.expectedRevision as number };
}
export function parseTaskAttachmentPrepare(value: unknown): TaskAttachmentPrepare {
  const input = command(value, ["attachmentId", "fileName", "mimeType", "sizeBytes"]);
  if (typeof input.fileName !== "string" || !input.fileName.trim() || input.fileName.length > 200 || input.fileName !== input.fileName.trim() || Buffer.byteLength(input.fileName, "utf8") > 240
    || /[\x00-\x1f\x7f/\\]/.test(input.fileName) || input.fileName === "." || input.fileName === ".."
    || !["image/jpeg", "image/png"].includes(input.mimeType as string) || !Number.isSafeInteger(input.sizeBytes) || (input.sizeBytes as number) < 1 || (input.sizeBytes as number) > TASK_PHOTO_MAX_BYTES) throw invalid();
  return { commandId: input.commandId, expectedRevision: input.expectedRevision, attachmentId: identifier(input.attachmentId), fileName: input.fileName,
    mimeType: input.mimeType as TaskAttachment["mimeType"], sizeBytes: input.sizeBytes as number };
}
function internalAttachment(actor: EmployeeTaskActor, id: string, attachmentId: string, value: unknown): StoredAttachment {
  const row = object(value, unconfirmed), attachment = employeeTaskAttachment(row);
  if (attachment.id !== attachmentId || row.bucket !== BUCKET || typeof row.path !== "string" || row.path.length > 512
    || !row.path.startsWith(`${actor.organizationId}/${id}/${attachmentId}`) || !new RegExp(`^${actor.organizationId}/${id}/${attachmentId}\\.(?:jpg|jpeg|png)$`).test(row.path)) throw unconfirmed();
  return { ...attachment, bucket: BUCKET, path: row.path, ...(typeof row.status === "string" ? { status: row.status } : {}) };
}
function storageUrl(value: unknown, path: string, kind: "sign" | "upload/sign"): string {
  const origin = getSupabasePublicEnv()?.url;
  let url: URL;
  try { url = new URL(value as string); } catch { throw unconfirmed(); }
  if (!origin || url.protocol !== "https:" || url.origin !== new URL(origin).origin || url.username || url.password
    || decodeURIComponent(url.pathname) !== `/storage/v1/object/${kind}/${BUCKET}/${path}` || !url.searchParams.get("token")) throw unconfirmed();
  return url.href;
}
const admin = (signal?: AbortSignal) => createSupabaseAdminClient(signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000)) as unknown as SupabaseClient;
async function readAttachment(actor: EmployeeTaskActor, id: string, attachmentId: string): Promise<StoredAttachment> {
  const data = await callEmployeeTask(actor, "attachment", id, { attachmentId });
  return internalAttachment(actor, id, attachmentId, data.attachment);
}
export async function prepareTaskAttachment(actor: EmployeeTaskActor, id: string, value: unknown): Promise<TaskAttachmentUpload> {
  id = taskId(id);
  const input = parseTaskAttachmentPrepare(value);
  const data = await callEmployeeTask(actor, "command", id, { ...input, action: "attachment_prepare" });
  const receipt = employeeTaskReceipt(data, actor, input.commandId, id);
  // Replays still return their original receipt, but may not renew a token for a
  // removed, ready or expired upload. The locked grant reserves a cleanup horizon
  // before Storage can issue its fixed two-hour token.
  const grant = await callEmployeeTask(actor, "attachment_upload", id, { attachmentId: input.attachmentId });
  const attachment = internalAttachment(actor, id, input.attachmentId, grant.attachmentUpload);
  if (attachment.status !== "pending") throw unconfirmed();
  if (attachment.fileName !== input.fileName || attachment.mimeType !== input.mimeType || attachment.sizeBytes !== input.sizeBytes) throw unconfirmed();
  const signed = await admin().storage.from(BUCKET).createSignedUploadUrl(attachment.path, { upsert: false });
  if (signed.error || !signed.data || signed.data.path !== attachment.path || typeof signed.data.token !== "string" || !signed.data.token) throw unconfirmed();
  return { ...employeeTaskScope(actor), receipt, attachment: employeeTaskAttachment(attachment), upload: {
    url: storageUrl(signed.data.signedUrl, attachment.path, "upload/sign"), token: signed.data.token, path: attachment.path, method: "PUT", contentType: attachment.mimeType,
  } };
}
export async function downloadTaskAttachment(actor: EmployeeTaskActor, id: string, attachmentId: string): Promise<TaskAttachmentDownload> {
  id = taskId(id); attachmentId = identifier(attachmentId);
  const attachment = await readAttachment(actor, id, attachmentId);
  if (attachment.status !== "ready") throw new MutationError("Fotografia ešte nie je uložená.", 409);
  const signed = await admin().storage.from(BUCKET).createSignedUrl(attachment.path, URL_SECONDS);
  if (signed.error || !signed.data?.signedUrl) throw unconfirmed();
  return { ...employeeTaskScope(actor), attachment: employeeTaskAttachment(attachment), url: storageUrl(signed.data.signedUrl, attachment.path, "sign"), expiresAt: new Date(Date.now() + URL_SECONDS * 1000).toISOString() };
}
/** Signed uploads are untrusted until both provider metadata and actual bytes match.
 * Paths are immutable, signed without upsert, and the bucket caps object size. */
export async function confirmTaskAttachment(actor: EmployeeTaskActor, id: string, attachmentId: string, value: unknown): Promise<TaskWorkspaceReceipt> {
  id = taskId(id); attachmentId = identifier(attachmentId);
  const input = command(value, []), attachment = await readAttachment(actor, id, attachmentId), store = admin().storage.from(BUCKET);
  const info = await store.info(attachment.path);
  if (info.error || !info.data) throw unconfirmed();
  const metadata = info.data as unknown as ObjectRow;
  if (metadata.name !== attachment.path || metadata.bucketId !== BUCKET || metadata.contentType !== attachment.mimeType || metadata.size !== attachment.sizeBytes) throw mismatch();
  const downloaded = await store.download(attachment.path).asStream();
  if (downloaded.error || !downloaded.data) throw unconfirmed();
  const reader = downloaded.data.getReader(); let size = 0, prefix = new Uint8Array();
  try {
    while (true) {
      const { done, value: bytes } = await reader.read(); if (done) break;
      size += bytes.byteLength;
      if (size > TASK_PHOTO_MAX_BYTES || size > attachment.sizeBytes) { await reader.cancel(); throw mismatch(); }
      if (prefix.length < 8) { const next = new Uint8Array(Math.min(8, prefix.length + bytes.length)); next.set(prefix); next.set(bytes.subarray(0, 8 - prefix.length), prefix.length); prefix = next; }
    }
  } finally { reader.releaseLock(); }
  const jpeg = prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255;
  const png = Buffer.from(prefix).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (size !== attachment.sizeBytes || !(attachment.mimeType === "image/jpeg" && jpeg || attachment.mimeType === "image/png" && png)) throw mismatch();
  const data = await callEmployeeTask(actor, "command", id, { ...input, action: "attachment_finish", attachmentId });
  return employeeTaskReceipt(data, actor, input.commandId, id);
}
export async function removeTaskAttachment(actor: EmployeeTaskActor, id: string, attachmentId: string, value: unknown): Promise<TaskWorkspaceReceipt> {
  id = taskId(id); attachmentId = identifier(attachmentId);
  const input = command(value, []), data = await callEmployeeTask(actor, "command", id, { ...input, action: "attachment_remove", attachmentId });
  const receipt = employeeTaskReceipt(data, actor, input.commandId, id);
  const attachment = internalAttachment(actor, id, attachmentId, data.attachmentUpload);
  // Metadata is already hidden. A provider failure is retried by bounded cleanup.
  await admin().storage.from(BUCKET).remove([attachment.path]).catch(() => undefined);
  return receipt;
}
