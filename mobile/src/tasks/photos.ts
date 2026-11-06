import type { TaskWorkspaceReceipt } from "../../../src/lib/mobile-task-workspace";
import { DraftNotSentError, draftId, draftKeys, draftObject, type DraftPort, type DraftWrite } from "../drafts/port";
import { MobileApiError } from "../lib/api";
import type { PickedFile } from "../work/attachments";
import type { UploadFiles } from "../field-work/uploads";
import type { EmployeeTasksApi, TaskPhotoPrepare } from "./api";

export type PendingTaskPhoto = {
  attachmentId: string; fileName: string; mimeType: "image/jpeg" | "image/png"; sizeBytes: number;
  taskId: string | null; expectedRevision: number | null; prepareCommandId: string; confirmCommandId: string;
  confirmRevision: number | null; phase: "selected" | "uploading" | "confirming";
};
export type TaskPhotoState = { photo: PendingTaskPhoto | null; status: "editing" | "saving" | "failed" | "uncertain"; error: string | null; missing: boolean };
type Options = { id: () => string; files?: UploadFiles; port?: (key: string) => DraftPort };
const empty = (): TaskPhotoState => ({ photo: null, status: "editing", error: null, missing: false });
const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const uncertain = (error: unknown) => !(error instanceof MobileApiError) || [0, 408, 429].includes(error.status) || error.status >= 500;
function parsePhoto(value: unknown): PendingTaskPhoto {
  const item = draftObject(value);
  draftKeys(item, ["attachmentId", "fileName", "mimeType", "sizeBytes", "taskId", "expectedRevision", "prepareCommandId", "confirmCommandId", "confirmRevision", "phase"]);
  if (![item.attachmentId, item.prepareCommandId, item.confirmCommandId].every(draftId) || typeof item.fileName !== "string" || !item.fileName.trim() || item.fileName.length > 200 || new TextEncoder().encode(item.fileName).length > 240 || /[\x00-\x1f\x7f/\\]/.test(item.fileName)
    || !["image/jpeg", "image/png"].includes(item.mimeType as string) || !positive(item.sizeBytes) || item.sizeBytes > 8 * 1024 * 1024
    || item.taskId !== null && !draftId(item.taskId) || item.expectedRevision !== null && !positive(item.expectedRevision)
    || item.confirmRevision !== null && !positive(item.confirmRevision) || !["selected", "uploading", "confirming"].includes(item.phase as string)) throw new Error("Invalid photo draft");
  return item as PendingTaskPhoto;
}
/** Only opaque ids and metadata enter the secure draft vault. Exact image bytes
 * stay in this account's cache, never a URL or a token. No automatic retry. */
export class TaskPhotos {
  private records: Record<string, TaskPhotoState> = {};
  private listeners = new Set<() => void>();
  private disposed = false;
  private ports = new Map<string, DraftPort>();
  private port(key: string) {
    if (!this.options.port) return undefined;
    let value = this.ports.get(key);
    if (!value) { value = this.options.port(key); this.ports.set(key, value); }
    return value;
  }
  private files: UploadFiles;
  constructor(private api: EmployeeTasksApi, readonly createKey: string, private options: Options) {
    const memory = new Map<string, Uint8Array>();
    this.files = options.files ?? { read: async id => memory.get(id)?.slice() ?? null, write: async (id, bytes) => { memory.set(id, bytes.slice()); },
      remove: async id => { memory.delete(id); }, keepOnly: async ids => { for (const id of memory.keys()) if (!ids.includes(id)) memory.delete(id); } };
    this.get(createKey);
  }
  snapshot = () => this.records;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get(key: string): TaskPhotoState {
    if (this.records[key]) return this.records[key];
    let state = empty();
    try {
      const loaded = this.port(key)?.load();
      if (loaded !== null && loaded !== undefined) {
        const item = draftObject(loaded); draftKeys(item, ["version", "key", "photo"]);
        if (item.version !== 1 || item.key !== key || !draftId(key)) throw new Error();
        const photo = item.photo === null ? null : parsePhoto(item.photo);
        state = { ...empty(), photo, status: photo?.phase === "selected" && photo.taskId === null ? "editing" : photo ? "uncertain" : "editing",
          error: photo && (photo.phase !== "selected" || photo.taskId !== null) ? "Nahrávanie čaká na overenie. Pokračujte s rovnakou fotografiou." : null };
      }
    } catch { this.port(key)?.reject(); state = { ...empty(), status: "failed", error: "Uloženú fotografiu sa nepodarilo overiť. Skontrolujte miestne koncepty v účte." }; }
    this.records = { ...this.records, [key]: state }; return state;
  }
  forTask(taskId: string) {
    this.get(taskId);
    return Object.entries(this.records).find(([, state]) => state.photo?.taskId === taskId)?.[0] ?? taskId;
  }
  private update(key: string, change: Partial<TaskPhotoState>) {
    if (this.disposed) return;
    this.records = { ...this.records, [key]: { ...this.get(key), ...change } }; this.listeners.forEach(listener => listener());
  }
  private payload(key: string, photo = this.get(key).photo) { return { version: 1, key, photo }; }
  async select(key: string, file: PickedFile): Promise<boolean> {
    const current = this.get(key);
    if (this.disposed || current.status === "saving" || current.photo?.taskId || !["image/jpeg", "image/png"].includes(file.mimeType)
      || !file.bytes.length || file.bytes.length > 8 * 1024 * 1024) return false;
    const previous = current.photo;
    const photo: PendingTaskPhoto = { attachmentId: this.options.id(), fileName: file.fileName, mimeType: file.mimeType as PendingTaskPhoto["mimeType"], sizeBytes: file.bytes.length,
      taskId: null, expectedRevision: null, prepareCommandId: this.options.id(), confirmCommandId: this.options.id(), confirmRevision: null, phase: "selected" };
    try {
      parsePhoto(photo);
      await this.files.write(photo.attachmentId, file.bytes);
      if (this.disposed) return false;
      this.port(key)?.changed(this.payload(key, photo));
      this.update(key, { photo, status: "editing", error: null, missing: false });
      if (previous) await this.files.remove(previous.attachmentId).catch(() => undefined);
      return true;
    } catch { this.update(key, { error: "Fotografiu sa nepodarilo pripraviť v telefóne. Skúste ju vybrať znova." }); return false; }
  }
  /** Move an image selected on the creation form under the confirmed task id
   * before network upload. A new form can never replace/discard that older image.
   * Target-first persistence makes an interrupted move recoverable without loss. */
  async releaseCreate(task: { id: string; revision: number }): Promise<boolean> {
    const source = this.get(this.createKey);
    if (!source.photo) return true;
    if (source.status === "saving" || this.disposed || task.id === this.createKey) return false;
    const bound = source.photo.taskId ?? task.id;
    if (bound !== task.id) return false;
    const photo = { ...source.photo, taskId: task.id, expectedRevision: source.photo.expectedRevision ?? task.revision };
    const target = this.get(task.id);
    if (target.photo && target.photo.attachmentId !== photo.attachmentId) {
      this.update(this.createKey, { status: "failed", error: "Pri úlohe už čaká iná fotografia. Najprv dokončite pôvodné nahrávanie." }); return false;
    }
    this.update(this.createKey, { status: "saving", error: null });
    try {
      if (!target.photo) {
        const port = this.port(task.id);
        if (port) { const write = await port.prepare(this.payload(task.id, photo)); if (!await write.finish(this.payload(task.id, photo))) throw new Error(); }
        this.update(task.id, { photo, status: photo.phase === "selected" ? "editing" : "uncertain", error: source.error, missing: source.missing });
      }
      const port = this.port(this.createKey);
      if (port) { const write = await port.prepare(this.payload(this.createKey, null)); if (!await write.finish(this.payload(this.createKey, null))) throw new Error(); }
      this.update(this.createKey, empty()); return true;
    } catch {
      this.update(this.createKey, { status: "failed", error: "Fotografia patrí už vytvorenej úlohe. Pred novým zadaním dokončite miestne uloženie a skúste znova." }); return false;
    }
  }
  async upload(key: string, task: { id: string; revision: number }): Promise<TaskWorkspaceReceipt | undefined> {
    if (this.disposed || this.get(key).status === "saving") return;
    if (key === this.createKey && task.id !== this.createKey) {
      if (!await this.releaseCreate(task)) return;
      return this.upload(task.id, task);
    }
    const api = this.api;
    if (!api.photoPrepare || !api.photoUpload || !api.photoConfirm) return;
    let photo = this.get(key).photo;
    if (!photo || photo.taskId !== null && photo.taskId !== task.id) return;
    this.update(key, { status: "saving", error: null });
    const bytes = photo.phase === "confirming" ? null : await this.files.read(photo.attachmentId).catch(() => null);
    if (this.disposed) return;
    if (photo.phase !== "confirming" && (!bytes || bytes.length !== photo.sizeBytes)) { this.update(key, { missing: true, status: "failed", error: "Fotografia už nie je v cache telefónu. Odstráňte miestny výber a pridajte ju znova." }); return; }
    if (photo.taskId === null) photo = { ...photo, taskId: task.id, expectedRevision: task.revision };
    this.update(key, { photo, status: "saving", error: null });
    const port = this.port(key);
    let write: DraftWrite | undefined, stage: "prepare" | "upload" | "confirm" = "prepare";
    const requireCurrent = () => { if (this.disposed || port && !port.current()) throw new DraftNotSentError("Prihlásenie alebo prístup k fotografii sa zmenil. Nová požiadavka sa neodoslala."); };
    const checkpoint = async () => {
      if (write) { const previous = write; write = undefined; if (!await previous.finish(this.payload(key, photo))) throw new Error("Miestne potvrdenie fotografie sa nepodarilo uložiť."); }
      requireCurrent();
      if (port) { try { write = await port.prepare(this.payload(key, photo)); } catch { throw new DraftNotSentError(); } if (!port.current() || this.disposed) throw new DraftNotSentError(); }
      requireCurrent();
    };
    try {
      if (photo.expectedRevision === null) { const latest = await api.detail(task.id); requireCurrent(); photo = { ...photo, expectedRevision: latest.task.revision }; this.update(key, { photo }); }
      await checkpoint(); requireCurrent();
      if (photo.phase === "confirming" && photo.confirmRevision === null) {
        const latest = await api.detail(task.id); requireCurrent();
        photo = { ...photo, confirmRevision: latest.task.revision }; this.update(key, { photo });
        await checkpoint(); requireCurrent();
      }
      if (photo.phase !== "confirming") {
        const input: TaskPhotoPrepare = { commandId: photo.prepareCommandId, expectedRevision: photo.expectedRevision!, attachmentId: photo.attachmentId,
          fileName: photo.fileName, mimeType: photo.mimeType, sizeBytes: photo.sizeBytes };
        requireCurrent();
        const grant = await api.photoPrepare(task.id, input); requireCurrent();
        if (port && !port.acceptsScope(grant.receipt)) throw new MobileApiError("Potvrdenie fotografie patrí inému účtu.", 502);
        photo = { ...photo, phase: "uploading", confirmRevision: photo.confirmRevision ?? grant.receipt.task.revision };
        this.update(key, { photo });
        await checkpoint(); requireCurrent();
        stage = "upload"; requireCurrent(); await api.photoUpload(grant, bytes!); requireCurrent();
        photo = { ...photo, phase: "confirming" }; this.update(key, { photo });
        await checkpoint(); requireCurrent();
      }
      stage = "confirm"; requireCurrent();
      const receipt = await api.photoConfirm(task.id, photo.attachmentId, { commandId: photo.confirmCommandId, expectedRevision: photo.confirmRevision! });
      requireCurrent();
      if (port && !port.acceptsScope(receipt)) throw new MobileApiError("Potvrdenie fotografie patrí inému účtu.", 502);
      if (write) { const saved = write; write = undefined; if (!await saved.finish(this.payload(key, null))) throw new Error("Local confirmation failed"); }
      await this.files.remove(photo.attachmentId).catch(() => undefined);
      this.update(key, { photo: null, status: "editing", error: null, missing: false });
      return receipt;
    } catch (failure) {
      // A known CAS refusal permits a fresh confirmation only after the user
      // explicitly retries; an unknown result keeps the original envelope frozen.
      if (failure instanceof MobileApiError && failure.status === 409 && stage !== "upload") {
        photo = stage === "prepare" ? { ...photo, phase: "selected", expectedRevision: null, prepareCommandId: this.options.id(), confirmCommandId: this.options.id(), confirmRevision: null }
          : { ...photo, phase: "confirming", confirmCommandId: this.options.id(), confirmRevision: null };
        this.update(key, { photo });
      }
      this.update(key, { status: failure instanceof DraftNotSentError ? "failed" : uncertain(failure) ? "uncertain" : "failed",
        error: failure instanceof Error ? failure.message : "Fotografia nie je potvrdená. Pokračujte v tom istom nahrávaní." });
    } finally {
      if (write) await write.finish(this.payload(key, photo)).catch(() => false);
    }
  }
  async discard(key: string) {
    const state = this.get(key);
    if (state.status === "saving" || this.disposed) return;
    try {
      const port = this.port(key);
      if (port) { const saved = await port.prepare(this.payload(key, null)); if (!await saved.finish(this.payload(key, null))) throw new Error(); }
      if (state.photo) await this.files.remove(state.photo.attachmentId).catch(() => undefined);
      this.update(key, empty());
    } catch { this.update(key, { error: "Miestny výber fotografie sa nepodarilo odstrániť. Skúste znova." }); }
  }
  read(key: string) { const photo = this.get(key).photo; return photo ? this.files.read(photo.attachmentId) : Promise.resolve(null); }
  dispose() { this.disposed = true; this.listeners.clear(); this.records = {}; }
}

export type TaskPhotoRemovalState = {
  pending: { commandId: string; expectedRevision: number } | null;
  status: "editing" | "saving" | "uncertain" | "conflict" | "saved"; error: string | null;
};
/** Unknown removal results replay the exact command. A definitive CAS refusal
 * exposes a separate explicit retry that reads the current task first. */
export class TaskPhotoRemoval {
  private state: TaskPhotoRemovalState = { pending: null, status: "editing", error: null };
  private listeners = new Set<() => void>();
  private disposed = false;
  constructor(private api: EmployeeTasksApi, private taskId: string, private photoId: string, private id: () => string) {}
  snapshot = () => this.state;
  subscribe = (notify: () => void) => { this.listeners.add(notify); return () => { this.listeners.delete(notify); }; };
  private update(change: Partial<TaskPhotoRemovalState>) { if (this.disposed) return; this.state = { ...this.state, ...change }; this.listeners.forEach(notify => notify()); }
  async remove(revision: number): Promise<boolean> {
    if (this.disposed || !this.api.photoRemove || this.state.status === "saving") return false;
    if (this.state.status === "saved") return true;
    const conflict = this.state.status === "conflict";
    let attempted = false;
    let input = this.state.pending;
    this.update({ status: "saving", error: null });
    try {
      if (conflict) {
        const fresh = await this.api.detail(this.taskId);
        if (this.disposed) return false;
        if (!Array.isArray(fresh.task.attachments)) throw new MobileApiError("Stav fotografie sa nepodarilo overiť. Obnovte údaje.", 502);
        if (!fresh.task.attachments.some(photo => photo.id === this.photoId)) { this.update({ status: "saved", pending: null }); return true; }
        input = { commandId: this.id(), expectedRevision: fresh.task.revision };
      }
      input ??= { commandId: this.id(), expectedRevision: revision };
      this.update({ pending: input });
      if (this.disposed) return false;
      attempted = true;
      await this.api.photoRemove(this.taskId, this.photoId, input);
      if (this.disposed) return false;
      this.update({ status: "saved", pending: null }); return true;
    } catch (failure) {
      this.update({ status: conflict && !attempted || failure instanceof MobileApiError && [404, 409].includes(failure.status) ? "conflict" : uncertain(failure) ? "uncertain" : "editing",
        ...(failure instanceof MobileApiError && failure.status >= 400 && failure.status < 500 && ![404, 409].includes(failure.status) ? { pending: null } : {}),
        error: failure instanceof Error ? failure.message : "Odstránenie fotografie nie je potvrdené. Overte rovnakú požiadavku." });
      return false;
    }
  }
  dispose() { this.disposed = true; this.listeners.clear(); }
}
