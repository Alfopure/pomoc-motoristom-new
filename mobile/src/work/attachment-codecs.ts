import type { MobileCaseAttachmentAdded, MobileCaseAttachmentInput } from "../../../src/lib/mobile-api";
import { draftDate, draftId, draftKeys, draftObject, draftText, type DraftPort } from "../drafts/port";
import { cloneDraft, scopeKeys, validateDraftScope } from "./draft-codecs";
import type { AttachmentState } from "./attachments";
const check = (condition: unknown) => { if (!condition) throw new Error("Invalid attachment marker"); };
export function attachmentSelection(value: unknown): NonNullable<AttachmentState["selected"]> {
  const v = draftObject(value); draftKeys(v, ["fileName", "mimeType", "category", "sizeBytes"]);
  check(draftText(v.fileName, 240) && !!v.fileName && v.fileName.trim() === v.fileName && new TextEncoder().encode(v.fileName).length <= 240 && !/[\x00-\x1f\x7f/\\]/.test(v.fileName));
  check(["image/jpeg", "image/png", "application/pdf"].includes(v.mimeType as string) && ["photo", "document"].includes(v.category as string));
  check(typeof v.sizeBytes === "number" && Number.isSafeInteger(v.sizeBytes) && v.sizeBytes > 0 && v.sizeBytes <= 3 * 1024 * 1024);
  return cloneDraft(v) as NonNullable<AttachmentState["selected"]>;
}
export function attachmentCommand(value: unknown, selected: NonNullable<AttachmentState["selected"]>, note: string): MobileCaseAttachmentInput {
  const v = draftObject(value); draftKeys(v, ["mutationId", "expectedUpdatedAt", "fileName", "category"], ["note"]);
  check(draftId(v.mutationId) && draftDate(v.expectedUpdatedAt) && v.fileName === selected.fileName && v.category === selected.category && (v.note === undefined || draftText(v.note, 2000)) && (v.note ?? "") === note);
  return cloneDraft(v) as MobileCaseAttachmentInput;
}
function newer(left: string, right: string) {
  const micros = (value: string) => Number((value.match(/\.(\d+)/)?.[1] ?? "").padEnd(6, "0").slice(3, 6));
  return (Date.parse(left) - Date.parse(right) || micros(left) - micros(right)) > 0;
}
export function attachmentReceipt(value: unknown, caseId: string, command: MobileCaseAttachmentInput, selected: NonNullable<AttachmentState["selected"]>, port: DraftPort): MobileCaseAttachmentAdded {
  const v = draftObject(value); draftKeys(v, [...scopeKeys, "caseId", "mutationId", "attachment", "committedRevision", "refreshRequired"]);
  validateDraftScope(v); check(port.acceptsScope(v) && v.caseId === caseId && v.mutationId === command.mutationId && draftDate(v.committedRevision) && newer(v.committedRevision, command.expectedUpdatedAt) && v.refreshRequired === true);
  const item = draftObject(v.attachment); draftKeys(item, ["id", "fileName", "category", "mimeType", "sizeBytes", "note", "createdAt", "downloadable"]);
  check(item.id === command.mutationId && item.fileName === command.fileName && item.category === command.category && item.mimeType === selected.mimeType && item.sizeBytes === selected.sizeBytes && item.note === (command.note ?? null));
  check((item.createdAt === null || draftDate(item.createdAt)) && typeof item.downloadable === "boolean");
  return cloneDraft(v) as MobileCaseAttachmentAdded;
}
export function restoreAttachment(value: unknown, caseId: string, port: DraftPort) {
  const v = draftObject(value); draftKeys(v, ["version", "caseId", "selected", "note", "status", "pending", "receipt"]);
  check(v.version === 1 && v.caseId === caseId && draftText(v.note, 2000) && ["editing", "saving", "uncertain", "saved"].includes(v.status as string));
  const selected = v.selected === null ? null : attachmentSelection(v.selected);
  check(v.status === "editing" ? v.pending === null : selected !== null && v.pending !== null);
  const pending = v.pending === null ? null : attachmentCommand(v.pending, selected!, v.note as string);
  check((v.status === "saved") === (v.receipt !== null));
  const receipt = v.receipt === null ? null : attachmentReceipt(v.receipt, caseId, pending!, selected!, port);
  return { selected, note: v.note as string, status: (v.status === "saving" ? "uncertain" : v.status) as AttachmentState["status"], pending, receipt };
}
