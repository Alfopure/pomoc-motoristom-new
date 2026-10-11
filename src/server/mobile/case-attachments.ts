import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { compareCaseRevisions } from "@/data/case-detail";
import { MOBILE_CASE_ATTACHMENT_MAX_BYTES, type MobileCaseAttachment, type MobileCaseAttachmentInput, type MobileCaseAttachmentAdded, type MobileCaseAttachments, type MobileCaseAttachmentDownload, type MobileScope } from "@/lib/mobile-api";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import { getSupabasePublicEnv } from "@/lib/supabase/env";
import { isHistoryTimestamp } from "@/lib/telephony/call-history-query";
import { isUuid } from "@/lib/telephony/uuid";
import type { MotoristActor } from "@/server/api-auth";
import { caseMutationIdentity, commitAtomicCaseSave, readCaseMutationResult } from "@/server/case-atomic-save";
import { MutationError } from "@/server/mutation-error";

type Admin = SupabaseClient<Database>;
type Upload = { command: MobileCaseAttachmentInput; bytes: Uint8Array; mimeType: string };
const BUCKET = "motorist-case-attachments", SOURCE = "mobile_case_attachment_v1", MAX_ATTACHMENTS = 200;
const unconfirmed = () => new MutationError("Výsledok prílohy sa nepodarilo potvrdiť. Overte tú istú požiadavku.", 503, "CASE_ATTACHMENT_UNCONFIRMED");
const mismatch = () => new MutationError("Uložený súbor nezodpovedá pôvodnej požiadavke. Zachovajte pôvodnú prílohu na overenie.", 422, "CASE_ATTACHMENT_STORAGE_MISMATCH");
function invalid(message = "Neplatná príloha."): never { throw new MutationError(message, 400); }
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function parseCommand(value: unknown): MobileCaseAttachmentInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const body = object(value);
  if (Object.keys(body).some(key => !["mutationId", "expectedUpdatedAt", "fileName", "category", "note"].includes(key))) invalid();
  if (body.expectedUpdatedAt === undefined) throw new MutationError("Chýba revízia prípadu.", 428, "CASE_REVISION_REQUIRED");
  if (!isHistoryTimestamp(body.expectedUpdatedAt) || typeof body.mutationId !== "string" || !isUuid(body.mutationId)) invalid();
  if (typeof body.fileName !== "string" || !body.fileName.trim() || body.fileName !== body.fileName.trim() || Buffer.byteLength(body.fileName, "utf8") > 240
    || /[\x00-\x1f\x7f/\\]/.test(body.fileName) || body.fileName === "." || body.fileName === ".." || Buffer.from(body.fileName, "utf8").toString("utf8") !== body.fileName) invalid("Neplatný názov súboru (najviac 240 UTF-8 bajtov).");
  if (body.category !== "photo" && body.category !== "document") invalid();
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 2000 || body.note.includes("\0"))) invalid("Poznámka môže mať najviac 2 000 znakov.");
  const command = { mutationId: body.mutationId, expectedUpdatedAt: body.expectedUpdatedAt, fileName: body.fileName, category: body.category,
    ...(body.note !== undefined ? { note: body.note } : {}) } as MobileCaseAttachmentInput;
  caseMutationIdentity({ ...command }); // Retain the shared strict command UUID contract.
  return command;
}
function validateUpload(input: Upload): Upload {
  const command = parseCommand(input.command), { bytes, mimeType } = input;
  if (!(bytes instanceof Uint8Array) || !bytes.length) invalid("Súbor je prázdny.");
  if (bytes.length > MOBILE_CASE_ATTACHMENT_MAX_BYTES) throw new MutationError("Príloha môže mať najviac 3 MiB.", 413);
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const png = Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const pdf = Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-";
  if (!(mimeType === "image/jpeg" && jpeg || mimeType === "image/png" && png || mimeType === "application/pdf" && pdf)) invalid("Povolené sú iba súbory JPEG, PNG a PDF so zodpovedajúcim obsahom.");
  return { command, bytes, mimeType };
}
export async function readMobileCaseAttachment(request: Request): Promise<Upload> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) invalid("Očakáva sa formulár s prílohou.");
  const reader = request.body?.getReader(); if (!reader) invalid();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MOBILE_CASE_ATTACHMENT_MAX_BYTES + 64_000) { await reader.cancel(); throw new MutationError("Formulár prílohy je príliš veľký.", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let form: FormData;
  try { form = await new Response(Buffer.concat(chunks), { headers: { "Content-Type": contentType } }).formData(); }
  catch { return invalid("Neplatný formulár prílohy."); }
  if ([...form.keys()].length !== 2 || form.getAll("file").length !== 1 || form.getAll("command").length !== 1) invalid();
  const file = form.get("file"), commandText = form.get("command");
  if (!file || typeof file === "string" || file.name !== "attachment.bin" || typeof commandText !== "string" || Buffer.byteLength(commandText, "utf8") > 16_000) invalid();
  let command: unknown;
  try { command = JSON.parse(commandText); } catch { return invalid("Neplatná požiadavka prílohy."); }
  return validateUpload({ command: parseCommand(command), bytes: new Uint8Array(await file.arrayBuffer()), mimeType: file.type });
}
function rawAttachments(value: unknown): unknown[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw unconfirmed();
  if (value.length > MAX_ATTACHMENTS) throw new MutationError("Prípad má príliš veľa príloh pre mobilné zobrazenie. Otvorte webovú aplikáciu.", 409, "CASE_ATTACHMENTS_LIMIT");
  return value;
}
function safePath(actor: MotoristActor, caseId: string, item: Record<string, unknown>): item is Record<string, unknown> & { storagePath: string } {
  const path = item.storagePath;
  return (item.storageBucket == null || item.storageBucket === BUCKET) && typeof path === "string"
    && path.startsWith(`${actor.organizationId}/cases/${caseId}/`) && path.length <= 1024
    && !/[\\%\x00-\x20\x7f?#]/.test(path) && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}
function publicAttachment(actor: MotoristActor, caseId: string, raw: unknown): MobileCaseAttachment {
  const item = object(raw);
  if (typeof item.id !== "string" || !isUuid(item.id) || typeof item.fileName !== "string" || !item.fileName || typeof item.category !== "string" || !["photo", "video", "document"].includes(item.category)) throw unconfirmed();
  return { id: item.id, fileName: item.fileName, category: item.category as MobileCaseAttachment["category"], mimeType: typeof item.mimeType === "string" ? item.mimeType : null,
    sizeBytes: typeof item.sizeBytes === "number" && Number.isSafeInteger(item.sizeBytes) && item.sizeBytes >= 0 ? item.sizeBytes : null,
    note: typeof item.note === "string" ? item.note : null, createdAt: typeof item.createdAt === "string" && isHistoryTimestamp(item.createdAt) ? item.createdAt : null,
    downloadable: safePath(actor, caseId, item) };
}
function context(signal?: AbortSignal, injected?: Admin) {
  const deadline = AbortSignal.timeout(20_000), abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  return { admin: injected ?? createSupabaseAdminClient(abort), abort };
}
async function readCase(admin: Admin, actor: MotoristActor, caseId: string, signal: AbortSignal) {
  if (!isUuid(caseId)) invalid("Neplatný prípad.");
  const { data, error } = await admin.from("motorist_cases").select("id,organization_id,updated_at,attachments_metadata").eq("organization_id", actor.organizationId).eq("id", caseId).abortSignal(signal).maybeSingle();
  if (error) throw unconfirmed();
  if (!data) throw new MutationError("Prípad sa nenašiel.", 404);
  if (!isHistoryTimestamp(data.updated_at)) throw unconfirmed();
  return data;
}
export async function listMobileCaseAttachments(actor: MotoristActor, caseId: string, signal?: AbortSignal, injected?: Admin): Promise<Omit<MobileCaseAttachments, keyof MobileScope>> {
  const { admin, abort } = context(signal, injected), row = await readCase(admin, actor, caseId, abort);
  return { caseId, caseRevision: row.updated_at, attachments: rawAttachments(row.attachments_metadata).map(item => publicAttachment(actor, caseId, item)) };
}
export async function downloadMobileCaseAttachment(actor: MotoristActor, caseId: string, attachmentId: string, signal?: AbortSignal, injected?: Admin): Promise<Omit<MobileCaseAttachmentDownload, keyof MobileScope>> {
  if (!isUuid(attachmentId)) invalid();
  const { admin, abort } = context(signal, injected), row = await readCase(admin, actor, caseId, abort);
  const matches = rawAttachments(row.attachments_metadata).filter(raw => object(raw).id === attachmentId);
  const item = object(matches[0]);
  if (matches.length !== 1 || !safePath(actor, caseId, item)) throw new MutationError("Súbor sa nenašiel.", 404);
  const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(item.storagePath, 300);
  if (error || !data?.signedUrl) throw unconfirmed();
  const expectedOrigin = getSupabasePublicEnv()?.url;
  let url: URL;
  try { url = new URL(data.signedUrl); } catch { throw unconfirmed(); }
  if (!expectedOrigin || url.protocol !== "https:" || url.origin !== new URL(expectedOrigin).origin || url.username || url.password
    || decodeURIComponent(url.pathname) !== `/storage/v1/object/sign/${BUCKET}/${item.storagePath}` || !url.searchParams.get("token")) throw unconfirmed();
  return { caseId, attachmentId, url: url.href, expiresAt: new Date(Date.now() + 300_000).toISOString() };
}
async function verifyStored(admin: Admin, path: string, metadata: Record<string, unknown>, mimeType: string, bytes: Uint8Array, signal: AbortSignal) {
  const storage = admin.storage.from(BUCKET), info = await storage.info(path);
  if (info.error) throw unconfirmed();
  const data = object(info.data), custom = object(data.metadata);
  if (data.name !== path || data.bucketId !== BUCKET || data.contentType !== mimeType || data.size !== bytes.length
    || Object.entries(metadata).some(([key, value]) => custom[key] !== value)) throw mismatch();
  const downloaded = await storage.download(path, {}, { signal }).asStream();
  if (downloaded.error || !downloaded.data) throw unconfirmed();
  const reader = downloaded.data.getReader(), digest = createHash("sha256"); let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > MOBILE_CASE_ATTACHMENT_MAX_BYTES || length > bytes.length) { await reader.cancel(); throw mismatch(); }
      digest.update(value);
    }
  } finally { reader.releaseLock(); }
  if (length !== bytes.length || digest.digest("hex") !== metadata.contentSha256) throw mismatch();
}
export async function addMobileCaseAttachment(actor: MotoristActor, caseId: string, raw: Upload, signal?: AbortSignal, injected?: Admin): Promise<Omit<MobileCaseAttachmentAdded, keyof MobileScope>> {
  if (!isUuid(caseId)) invalid("Neplatný prípad.");
  const { command, bytes, mimeType } = validateUpload(raw), { admin, abort } = context(signal, injected);
  const contentSha256 = hash(bytes);
  const identity = caseMutationIdentity({ ...command, source: SOURCE, organizationId: actor.organizationId, actorId: actor.profileId, caseId, mimeType, contentSha256, byteLength: bytes.length })!;
  const path = `${actor.organizationId}/cases/${caseId}/mobile/${actor.profileId}/${command.mutationId}`;
  const expected = { id: command.mutationId, category: command.category, fileName: command.fileName, mimeType, sizeBytes: bytes.length, note: command.note ?? null, storageBucket: BUCKET, storagePath: path };
  function confirmed(row: unknown): Omit<MobileCaseAttachmentAdded, keyof MobileScope> {
    const saved = object(row), items = Array.isArray(saved.attachments_metadata) ? saved.attachments_metadata.filter(item => object(item).id === command.mutationId) : [];
    if (saved.id !== caseId || saved.organization_id !== actor.organizationId || !isHistoryTimestamp(saved.updated_at)
      || compareCaseRevisions(saved.updated_at, command.expectedUpdatedAt) <= 0 || items.length !== 1
      || Object.entries(expected).some(([key, value]) => object(items[0])[key] !== value) || !isHistoryTimestamp(object(items[0]).createdAt)) throw unconfirmed();
    return { caseId, mutationId: command.mutationId, attachment: publicAttachment(actor, caseId, items[0]), committedRevision: saved.updated_at, refreshRequired: true };
  }
  try {
    const receipt = await readCaseMutationResult(admin, actor.organizationId, actor.profileId, caseId, identity);
    if (receipt) return confirmed(receipt);
    const row = await readCase(admin, actor, caseId, abort), existing = rawAttachments(row.attachments_metadata);
    const changedRevision = compareCaseRevisions(row.updated_at, command.expectedUpdatedAt) !== 0;
    const existingId = existing.some(item => object(item).id === command.mutationId);
    if (changedRevision || existingId) {
      // An identical request may have committed after our first receipt lookup.
      // Its atomic receipt must win over the newer case snapshot.
      const concurrentReceipt = await readCaseMutationResult(admin, actor.organizationId, actor.profileId, caseId, identity);
      if (concurrentReceipt) return confirmed(concurrentReceipt);
      if (changedRevision) throw new MutationError("Prípad medzitým zmenil iný používateľ. Načítajte aktuálny stav.", 409, "CASE_REVISION_CONFLICT");
      throw new MutationError("Identita prílohy už existuje bez zodpovedajúceho potvrdenia.", 422, "CASE_MUTATION_MISMATCH");
    }
    if (existing.length >= MAX_ATTACHMENTS) throw new MutationError("Prípad už má 200 príloh. Použite webovú aplikáciu.", 409, "CASE_ATTACHMENTS_LIMIT");
    const metadata = { source: SOURCE, commandFingerprint: identity.fingerprint, contentSha256, byteLength: bytes.length };
    const storage = admin.storage.from(BUCKET), result = await storage.upload(path, bytes, { contentType: mimeType, upsert: false, metadata });
    if (result.error && !("statusCode" in result.error && String(result.error.statusCode) === "409")) throw unconfirmed();
    // Even a matching byte stream is insufficient: the object must belong to the
    // exact immutable command. Never overwrite or delete an ambiguous upload.
    await verifyStored(admin, path, metadata, mimeType, bytes, abort);
    const saved = await commitAtomicCaseSave(admin, { organizationId: actor.organizationId, actorId: actor.profileId, caseId,
      expectedUpdatedAt: command.expectedUpdatedAt, identity, related: [], fieldLabels: { attachments_metadata: "prílohy" },
      casePatch: { attachments_metadata: [...existing, { ...expected, createdAt: new Date().toISOString() }] } });
    return confirmed(saved);
  } catch (error) {
    if (error instanceof MutationError && error.status < 500) throw error;
    throw unconfirmed();
  }
}
