import type { MobileTowingAttachment, MobileTowingOrder } from "../../../src/lib/mobile-api";
import { draftDate, draftId, draftKeys, draftObject, draftText } from "../drafts/port";
import { MobileApiError } from "../lib/api";
import type { StorageDriver } from "../lib/session-storage";
import { workCommandsKey, type WorkCommandScope } from "./commands";

/** Towing photos and scans being uploaded in Moja práca. Before the first byte leaves
 * the phone, the upload's ids (attachment, command, expected revision, assignment) are
 * stored like a step and its exact bytes are kept in the app's caches, until the server
 * confirms the attachment. An upload cut off by a restart is then resumed with the same
 * ids – the server replays them and compares the bytes, so it never makes a second
 * attachment – or abandoned. Nothing is resent on its own. */
export type TowingUpload = {
  orderId: string; attachmentId: string; commandId: string; kind: MobileTowingAttachment["kind"]; expectedRevision: number; assignmentGeneration: number;
  fileName: string; mimeType: "image/jpeg" | "image/png" | "application/pdf"; sizeBytes: number; createdAt: string;
};
/** `missing`: the bytes are no longer on this phone (iOS may clear caches), so it can only be abandoned. */
export type PendingUpload = TowingUpload & { status: "waiting" | "sending" | "failed"; message: string | null; missing: boolean };
export type UploadsView = { ready: boolean; enabled: boolean; busy: boolean; error: string | null; uploads: readonly PendingUpload[] };
/** The bytes of each upload by attachment id; `keepOnly` removes bytes no stored upload refers to. */
export type UploadFiles = {
  read: (attachmentId: string) => Promise<Uint8Array | null>; write: (attachmentId: string, bytes: Uint8Array) => Promise<void>; remove: (attachmentId: string) => Promise<void>;
  keepOnly: (attachmentIds: string[]) => Promise<void>;
};
type Send = (upload: TowingUpload, bytes: Uint8Array) => Promise<unknown>;
const MAX_UPLOADS = 6, MAX_RECORD_BYTES = 20_000, MAX_FILE = 10 * 1024 * 1024;
const KEYS = ["orderId", "attachmentId", "commandId", "kind", "expectedRevision", "assignmentGeneration", "fileName", "mimeType", "sizeBytes", "createdAt"];
const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v < 2_147_483_647;
const check = (v: unknown) => { if (!v) throw new Error("Invalid towing upload record"); };

export function towingUploadsKey(scope: WorkCommandScope): string {
  return workCommandsKey(scope).replace("pm-work-commands-v1", "pm-towing-uploads-v1");
}
export function parseTowingUpload(value: unknown): TowingUpload {
  const v = draftObject(value); draftKeys(v, KEYS);
  check(draftId(v.orderId) && draftId(v.attachmentId) && draftId(v.commandId) && ["work", "handover", "scan"].includes(v.kind as string)
    && positive(v.expectedRevision) && positive(v.assignmentGeneration) && draftText(v.fileName, 240) && (v.fileName as string).length > 0
    && ["image/jpeg", "image/png", "application/pdf"].includes(v.mimeType as string) && positive(v.sizeBytes) && (v.sizeBytes as number) <= MAX_FILE && draftDate(v.createdAt));
  return Object.fromEntries(KEYS.map(key => [key, typeof v[key] === "string" && key.endsWith("Id") ? (v[key] as string).toLowerCase() : v[key]])) as TowingUpload;
}

export class TowingUploads {
  private view: UploadsView = { ready: false, enabled: true, busy: false, error: null, uploads: [] };
  private listeners = new Set<() => void>();
  private disposed = false;
  private active = true;
  private running = false;
  readonly key: string;
  private clock: () => number;
  constructor(private storage: StorageDriver, private files: UploadFiles, private scope: WorkCommandScope, private send: Send,
    private options: { current: () => boolean; clock?: () => number }) {
    this.key = towingUploadsKey(scope); this.clock = options.clock ?? Date.now;
  }
  snapshot = () => this.view;
  subscribe = (notify: () => void) => { this.listeners.add(notify); return () => { this.listeners.delete(notify); }; };
  /** One unfinished upload per order at a time, as the screen shows it. */
  forOrder(orderId: string) { return this.view.uploads.find(item => item.orderId === orderId.toLowerCase()); }
  setActive(active: boolean) { this.active = active; this.update({ enabled: active }); }
  private current() { return this.active && !this.disposed && this.options.current(); }
  private update(change: Partial<UploadsView>) {
    if (this.disposed) return;
    this.view = { ...this.view, ...change }; this.listeners.forEach(notify => notify());
  }
  private replace(record: PendingUpload) { this.update({ uploads: this.view.uploads.map(item => item.attachmentId === record.attachmentId ? record : item) }); }
  private async persist(records: readonly TowingUpload[]) {
    const json = JSON.stringify({ version: 1, scope: this.scope, uploads: records.map(record => Object.fromEntries(KEYS.map(key => [key, record[key as keyof TowingUpload]]))) });
    if (records.length > MAX_UPLOADS || json.length > MAX_RECORD_BYTES) throw new Error("Towing upload storage limit");
    await this.storage.setItem(this.key, json);
  }
  private async exclusive<T>(work: () => Promise<T>, fallback: T): Promise<T> {
    if (this.running || !this.current()) return fallback;
    this.running = true; this.update({ busy: true, error: null });
    try { return await work(); }
    finally { this.running = false; this.update({ busy: false }); }
  }
  async load(): Promise<void> {
    if (this.view.ready) return;
    await this.exclusive(async () => {
      try {
        const raw = await this.storage.getItem(this.key);
        if (!this.current()) return;
        let records: TowingUpload[] = [];
        if (raw !== null) {
          check(raw.length <= MAX_RECORD_BYTES);
          const v = draftObject(JSON.parse(raw)); draftKeys(v, ["version", "scope", "uploads"]);
          const s = draftObject(v.scope); draftKeys(s, ["environment", "apiOrigin", "projectUrl", "userId", "memberId"]);
          check(v.version === 1 && towingUploadsKey(s as WorkCommandScope) === this.key && Array.isArray(v.uploads) && v.uploads.length <= MAX_UPLOADS);
          records = (v.uploads as unknown[]).map(parseTowingUpload);
          check(new Set(records.map(item => item.attachmentId)).size === records.length && new Set(records.map(item => item.orderId)).size === records.length);
        }
        await this.files.keepOnly(records.map(record => record.attachmentId)).catch(() => undefined);
        const restored = await Promise.all(records.map(async record => {
          const bytes = await this.files.read(record.attachmentId).catch(() => null);
          return { ...record, status: "waiting" as const, message: null, missing: !bytes || bytes.length !== record.sizeBytes };
        }));
        if (this.current()) this.update({ ready: true, uploads: restored });
      } catch { if (this.current()) this.update({ error: "Rozpracované nahrávania príloh sa nepodarilo načítať. Skúste načítanie znova; nové prílohy sa zatiaľ nenahrajú." }); }
    }, undefined);
  }
  /** Stored (bytes, then ids) first, then sent; true once the server confirmed the attachment. */
  start(upload: Omit<TowingUpload, "createdAt">, bytes: Uint8Array): Promise<boolean> {
    return this.exclusive(async () => {
      if (!this.view.ready || this.forOrder(upload.orderId)) return false;
      let record: TowingUpload;
      try {
        record = parseTowingUpload({ ...upload, sizeBytes: bytes.length, createdAt: new Date(this.clock()).toISOString() });
        await this.files.write(record.attachmentId, bytes);
        await this.persist([...this.view.uploads, record]);
      } catch {
        await this.files.remove(upload.attachmentId.toLowerCase()).catch(() => undefined);
        this.update({ error: "Prílohu sa nepodarilo bezpečne uložiť v telefóne. Neodoslala sa. Skúste to znova." });
        return false;
      }
      const pending: PendingUpload = { ...record, status: "waiting", message: null, missing: false };
      this.update({ uploads: [...this.view.uploads, pending] });
      if (!this.current()) return false;
      return this.deliver(pending, bytes);
    }, false);
  }
  /** The same upload again, with the same ids and the same bytes. */
  resume(attachmentId: string): Promise<boolean> {
    return this.exclusive(async () => {
      const record = this.view.uploads.find(item => item.attachmentId === attachmentId);
      if (!this.view.ready || !record) return false;
      const bytes = await this.files.read(record.attachmentId).catch(() => null);
      if (!bytes || bytes.length !== record.sizeBytes) {
        this.replace({ ...record, missing: true, status: "failed", message: "Súbor sa v telefóne už nenachádza. Nahrávanie zahoďte a prílohu pridajte znova." });
        return false;
      }
      return this.deliver(record, bytes);
    }, false);
  }
  private async deliver(record: PendingUpload, bytes: Uint8Array): Promise<boolean> {
    this.replace({ ...record, status: "sending", message: null });
    try {
      await this.send(toUpload(record), bytes);
    } catch (failure) {
      this.replace({ ...record, status: this.current() ? "failed" : "waiting", message: failure instanceof MobileApiError ? failure.message
        : "Spojenie sa prerušilo. Príloha sa mohla nahrať; pokračujte v tom istom nahrávaní." });
      return false;
    }
    if (!await this.forget(record.attachmentId)) {
      this.replace({ ...record, status: "failed", message: "Príloha je nahratá, ale miestny záznam sa nepodarilo uzavrieť. Pokračujte v tom istom nahrávaní." });
      return false;
    }
    return true;
  }
  private async forget(attachmentId: string): Promise<boolean> {
    const remaining = this.view.uploads.filter(item => item.attachmentId !== attachmentId);
    try { await this.persist(remaining); } catch { return false; }
    await this.files.remove(attachmentId).catch(() => undefined);
    this.update({ uploads: remaining });
    return true;
  }
  /** Gives up the local copy; a pending attachment on the server is abandoned by its own step first. */
  discard(attachmentId: string): Promise<boolean> {
    return this.exclusive(async () => {
      if (!this.view.uploads.some(item => item.attachmentId === attachmentId)) return false;
      if (await this.forget(attachmentId)) return true;
      this.update({ error: "Miestny záznam nahrávania sa nepodarilo uzavrieť. Skúste to znova." });
      return false;
    }, false);
  }
  /** The server already shows the attachment ready: the local copy is no longer needed. */
  settle(order: Pick<MobileTowingOrder, "id" | "attachments">): Promise<void> {
    const record = this.forOrder(order.id);
    if (!record || record.status === "sending" || !order.attachments.some(item => item.id === record.attachmentId && item.status === "ready")) return Promise.resolve();
    return this.exclusive(async () => { await this.forget(record.attachmentId); }, undefined);
  }
  dispose() { this.disposed = true; this.listeners.clear(); }
}
function toUpload(record: PendingUpload): TowingUpload {
  return Object.fromEntries(KEYS.map(key => [key, record[key as keyof TowingUpload]])) as TowingUpload;
}
