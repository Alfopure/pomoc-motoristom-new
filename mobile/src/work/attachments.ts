import type { MobileCaseAttachmentAdded, MobileCaseAttachmentInput } from "../../../src/lib/mobile-api";
import type { WorkApi } from "./api";
import { MobileApiError } from "../lib/api";
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
export type AttachmentState = { selected: Omit<PickedFile, "bytes"> & { sizeBytes: number } | null; note: string; status: "editing" | "saving" | "uncertain" | "saved"; error: string | null; receipt: MobileCaseAttachmentAdded | null };
export class AttachmentDraft {
  private state: AttachmentState = { selected: null, note: "", status: "editing", error: null, receipt: null };
  private file: PickedFile | null = null;
  private pending: { command: MobileCaseAttachmentInput; payload: UploadPayload } | null = null;
  private disposed = false;
  private listeners = new Set<() => void>();
  constructor(private api: Pick<WorkApi, "upload">, private caseId: string, private uuid: () => string) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(change: Partial<AttachmentState>) { if (this.disposed) return; this.state = { ...this.state, ...change }; for (const notify of this.listeners) notify(); }
  select(file: PickedFile) {
    if (this.disposed || this.state.status !== "editing") return;
    try {
      validateFile(file.bytes, file.mimeType);
      if (!file.fileName || file.fileName.trim() !== file.fileName || new TextEncoder().encode(file.fileName).length > 240 || /[\x00-\x1f\x7f/\\]/.test(file.fileName)) throw new Error("Názov súboru nie je podporovaný (najviac 240 bajtov, bez lomiek).");
      this.file = { ...file, bytes: file.bytes.slice() }; this.update({ selected: { fileName: file.fileName, mimeType: file.mimeType, category: file.category, sizeBytes: file.bytes.length }, error: null });
    } catch (error) { this.update({ error: error instanceof Error ? error.message : "Súbor sa nepodarilo pripraviť." }); }
  }
  editNote(note: string) { if (this.state.status === "editing") this.update({ note }); }
  async save(revision: string) {
    if (this.disposed || this.state.status !== "editing" || !this.file) return;
    try {
      if (this.state.note.length > 2000 || this.state.note.includes("\0")) throw new Error("Poznámka má najviac 2000 znakov.");
      const mutationId = this.uuid();
      const command: MobileCaseAttachmentInput = Object.freeze({ mutationId, expectedUpdatedAt: revision, fileName: this.file.fileName, category: this.file.category, ...(this.state.note ? { note: this.state.note } : {}) });
      this.pending = { command, payload: multipart(command, this.file.bytes, this.file.mimeType, "linka-" + mutationId) };
    } catch (error) { this.update({ error: error instanceof Error ? error.message : "Požiadavku sa nepodarilo pripraviť." }); return; }
    return this.run(false);
  }
  async reconcile() { if (!this.disposed && this.state.status === "uncertain") return this.run(true); }
  private async run(reconciling: boolean) {
    if (!this.pending) return;
    this.update({ status: "saving", error: null });
    try {
      const receipt = await this.api.upload(this.caseId, { ...this.pending.command }, { ...this.pending.payload, bytes: this.pending.payload.bytes.slice() });
      if (this.disposed) return; this.file = null; this.pending = null; this.update({ status: "saved", receipt }); return receipt;
    } catch (error) {
      const uncertain = reconciling || !(error instanceof MobileApiError) || [0, 408, 429].includes(error.status) || error.status >= 500;
      if (!uncertain) this.pending = null;
      this.update({ status: uncertain ? "uncertain" : "editing", error: uncertain ? "Príloha už môže byť uložená. Overte tú istú požiadavku; súbor aj údaje zostali zachované." : (error as MobileApiError).message });
    }
  }
  reset() { if (this.state.status === "saved") this.update({ selected: null, note: "", status: "editing", error: null, receipt: null }); }
  dispose() { this.disposed = true; this.file = null; this.pending = null; this.listeners.clear(); }
}
