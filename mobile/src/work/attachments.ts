import type { MobileCaseAttachmentAdded, MobileCaseAttachmentInput, MobileCaseAttachments } from "../../../src/lib/mobile-api";
import type { WorkApi } from "./api";
import { MobileApiError } from "../lib/api";
import { DraftNotSentError, type DraftPort, type DraftWrite } from "../drafts/port";
import { cloneDraft } from "./draft-codecs";
import { attachmentCommand, attachmentReceipt, attachmentSelection, restoreAttachment } from "./attachment-codecs";
export const MAX_BYTES = 3 * 1024 * 1024;
export type PickedFile = { bytes: Uint8Array; mimeType: "image/jpeg" | "image/png" | "application/pdf"; fileName: string; category: "photo" | "document" };
export type UploadPayload = { bytes: Uint8Array; contentType: string; mimeType: string; sizeBytes: number };
export function validateFile(bytes: Uint8Array, mime?: string): PickedFile["mimeType"] {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error("Príloha musí mať najviac 3 MiB.");
  const actual = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
    : [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n) ? "image/png"
      : [37, 80, 68, 70, 45].every((n, i) => bytes[i] === n) ? "application/pdf" : null;
  if (!actual || mime && actual !== mime) throw new Error("Vyberte platný JPEG, PNG alebo PDF súbor."); return actual;
}
export function photoSize(width: number, height: number, maximum = 2048) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new Error("Rozmery fotografie sa nepodarilo overiť.");
  const scale = Math.min(1, maximum / Math.max(width, height)); return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}
export function multipart(command: MobileCaseAttachmentInput, bytes: Uint8Array, mimeType: string, boundary: string): UploadPayload {
  validateFile(bytes, mimeType);
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(boundary)) throw new Error("Neplatná požiadavka prílohy.");
  const encoder = new TextEncoder();
  const head = encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="command"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(command)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="attachment.bin"\r\nContent-Type: ${mimeType}\r\n\r\n`);
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`), result = new Uint8Array(head.length + bytes.length + tail.length);
  result.set(head); result.set(bytes, head.length); result.set(tail, head.length + bytes.length);
  return { bytes: result, contentType: "multipart/form-data; boundary=" + boundary, mimeType, sizeBytes: bytes.length };
}
export type AttachmentState = { selected: Omit<PickedFile, "bytes"> & { sizeBytes: number } | null; note: string; status: "editing" | "saving" | "uncertain" | "saved"; error: string | null; receipt: MobileCaseAttachmentAdded | null; coldMissingFile: boolean; reviewAfter: number; reviewedList: boolean };
async function finish(write: DraftWrite | undefined, value: object) { try { return write ? await write.finish(value) : true; } catch { return false; } }
export class AttachmentDraft {
  private state: AttachmentState = { selected: null, note: "", status: "editing", error: null, receipt: null, coldMissingFile: false, reviewAfter: 0, reviewedList: false };
  private file: PickedFile | null = null;
  private pending: MobileCaseAttachmentInput | null = null;
  private payload: UploadPayload | null = null;
  private disposed = false;
  private rejected = false;
  private listeners = new Set<() => void>();
  constructor(private api: Pick<WorkApi, "upload">, private caseId: string, private uuid: () => string, private port?: DraftPort) {
    const value = port?.load();
    if (port && value !== null) {
      try {
        const restored = restoreAttachment(value, caseId, port); this.pending = restored.pending;
        this.state = { ...this.state, selected: restored.selected, note: restored.note, status: restored.status, receipt: restored.receipt,
          coldMissingFile: !!restored.selected && restored.status !== "saved", reviewAfter: Date.now(),
          error: restored.status === "uncertain" ? "Príloha už môže byť uložená. Súbor po reštarte nie je k dispozícii; najprv skontrolujte čerstvý zoznam príloh." : null };
      } catch { this.rejected = true; port.reject(); this.state.error = "Uložený koncept prílohy sa nepodarilo overiť."; }
    }
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  exportDraft() { return cloneDraft({ version: 1, caseId: this.caseId, selected: this.state.selected, note: this.state.note, status: this.state.status, pending: this.pending, receipt: this.state.receipt }); }
  private update(change: Partial<AttachmentState>, persist = true) { if (this.disposed) return; this.state = { ...this.state, ...change }; if (persist && !this.rejected) this.port?.changed(this.exportDraft()); for (const notify of this.listeners) notify(); }
  select(file: PickedFile) {
    if (this.disposed || this.rejected || this.state.status !== "editing") return;
    try {
      validateFile(file.bytes, file.mimeType);
      const selected = attachmentSelection({ fileName: file.fileName, mimeType: file.mimeType, category: file.category, sizeBytes: file.bytes.length });
      this.file = { ...file, bytes: file.bytes.slice() }; this.update({ selected, coldMissingFile: false, error: null });
    } catch (error) { this.update({ error: error instanceof Error ? error.message : "Súbor sa nepodarilo pripraviť." }); }
  }
  editNote(note: string) { if (!this.rejected && this.state.status === "editing") this.update({ note }); }
  reviewList(list: MobileCaseAttachments, requestedAt: number) {
    if (!this.disposed && !this.rejected && this.state.status === "uncertain" && this.state.coldMissingFile && requestedAt > this.state.reviewAfter && list.caseId === this.caseId && this.port?.current() && this.port.acceptsScope(list)) this.update({ reviewedList: true }, false);
  }
  allowNewSelection() {
    if (this.disposed || this.rejected || this.state.status !== "uncertain" || !this.state.coldMissingFile || !this.state.reviewedList) return;
    this.pending = null; this.payload = null; this.file = null;
    this.update({ status: "editing", selected: null, coldMissingFile: false, reviewedList: false, error: null });
  }
  async save(revision: string) {
    if (this.disposed || this.rejected || this.state.status !== "editing" || !this.file) return;
    try {
      if (this.state.note.length > 2000 || this.state.note.includes("\0")) throw new Error("Poznámka má najviac 2000 znakov.");
      const mutationId = this.uuid();
      const command: MobileCaseAttachmentInput = { mutationId, expectedUpdatedAt: revision, fileName: this.file.fileName, category: this.file.category, ...(this.state.note ? { note: this.state.note } : {}) };
      this.pending = Object.freeze(this.port ? attachmentCommand(command, this.state.selected!, this.state.note) : command);
      this.payload = multipart(command, this.file.bytes, this.file.mimeType, "linka-" + mutationId);
    } catch (error) { this.pending = null; this.update({ error: error instanceof Error ? error.message : "Požiadavku sa nepodarilo pripraviť." }); return; }
    return this.run(false);
  }
  async reconcile() { if (!this.disposed && !this.rejected && this.state.status === "uncertain" && !this.state.coldMissingFile) return this.run(true); }
  private async run(reconciling: boolean) {
    if (!this.pending || !this.payload || !this.state.selected) return;
    const pending = this.pending, payload = this.payload, selected = this.state.selected;
    this.update({ status: "saving", error: null }, false);
    const original = this.exportDraft(); let write: DraftWrite | undefined;
    try {
      if (this.port) {
        try { write = await this.port.prepare(original); } catch (error) { throw error instanceof DraftNotSentError ? error : new DraftNotSentError(); }
        if (this.disposed || !this.port.current()) throw new DraftNotSentError();
      }
      const result = await this.api.upload(this.caseId, { ...pending }, { ...payload, bytes: payload.bytes.slice() });
      const receipt = this.port ? attachmentReceipt(result, this.caseId, pending, selected, this.port) : result;
      const persisted = await finish(write, { ...original, status: "saved", receipt });
      if (this.disposed) return;
      this.file = null; this.payload = null; this.update({ status: "saved", receipt, coldMissingFile: false,
        error: persisted ? null : "Príloha je potvrdená, ale miestne uloženie potvrdenia zlyhalo. Pred ďalším zápisom opravte uloženie konceptov." }, false); return receipt;
    } catch (error) {
      const uncertain = reconciling || !(error instanceof DraftNotSentError) && (!(error instanceof MobileApiError) || [0, 408, 429].includes(error.status) || error.status >= 500);
      await finish(write, { ...original, status: uncertain ? "uncertain" : "editing", pending: uncertain ? pending : null, receipt: null });
      if (this.disposed) return;
      if (!uncertain) { this.pending = null; this.payload = null; }
      this.update({ status: uncertain ? "uncertain" : "editing", error: uncertain ? "Príloha už môže byť uložená. Overte tú istú požiadavku; súbor aj údaje zostali zachované." : (error as Error).message }, !write);
    }
  }
  reset() {
    if (this.disposed || this.rejected || this.state.status !== "saved" || this.port && !this.port.settled()) return false;
    this.pending = null; this.update({ selected: null, note: "", status: "editing", error: null, receipt: null, coldMissingFile: false, reviewedList: false }); return true;
  }
  dispose() { this.disposed = true; this.file = null; this.payload = null; this.listeners.clear(); }
}
