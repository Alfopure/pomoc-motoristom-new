import type { MobileBranchCommand, MobileOperationCommand, MobileTowingCommand } from "../../../src/lib/mobile-api";
import { draftDate, draftId, draftKeys, draftObject } from "../drafts/port";
import { MobileApiError } from "../lib/api";
import type { StorageDriver } from "../lib/session-storage";

/** Steps of Moja práca and Pobočka, kept like the delivery steps: only the immutable
 * intent (target, command id, expected revision, payload) is stored on the phone
 * before sending; an uncertain answer is retried with the same command id, which the
 * server replays. A restored intent is never sent automatically. */
export type WorkTarget = { kind: "operation" | "towing" | "branch"; id: string };
export type WorkCommand = MobileOperationCommand | MobileTowingCommand | MobileBranchCommand;
export type WorkIntent = { target: WorkTarget; command: WorkCommand; label: string; createdAt: string };
export type PendingWork = WorkIntent & { status: "sending" | "uncertain" | "rejected" | "confirmed"; message: string | null };
export type WorkCommandsView = { ready: boolean; enabled: boolean; busy: boolean; error: string | null; pending: readonly PendingWork[] };
export type WorkCommandScope = { environment: "test" | "production"; apiOrigin: string; projectUrl: string; userId: string; memberId: string };
type Options = { current: () => boolean; clock?: () => number };
const MAX_RECORDS = 16, MAX_BYTES = 100_000;
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v < 2_147_483_647;
const check = (v: unknown) => { if (!v) throw new Error("Invalid work command record"); };
export const targetKey = (target: WorkTarget) => target.kind + ":" + target.id;

export function workCommandsKey(scope: WorkCommandScope): string {
  const targets = scope.environment === "test" ? ["https://test.dispecing.linkapomoci.sk", "nzpnqdstvkfncflgqlny"]
    : scope.environment === "production" ? ["https://dispecing.linkapomoci.sk", "ifpaeegaesdmljfkdvcn"] : [];
  check(scope.apiOrigin === targets[0] && scope.projectUrl === "https://" + targets[1] + ".supabase.co" && draftId(scope.userId) && draftId(scope.memberId));
  return ["pm-work-commands-v1", scope.environment, targets[1], scope.userId.toLowerCase(), scope.memberId.toLowerCase()].join(".");
}

export function parseWorkIntent(value: unknown): WorkIntent {
  const v = draftObject(value); draftKeys(v, ["target", "command", "label", "createdAt"]);
  const t = draftObject(v.target); draftKeys(t, ["kind", "id"]);
  check(["operation", "towing", "branch"].includes(t.kind as string) && draftId(t.id) && draftDate(v.createdAt) && typeof v.label === "string" && v.label.length <= 100);
  const c = draftObject(v.command);
  check(draftId(c.commandId) && positive(c.expectedRevision) && draftObject(c.payload));
  if (t.kind === "operation") {
    draftKeys(c, ["commandId", "action", "expectedRevision", "payload"]);
    check(["accept", "start", "arrive", "collect", "complete", "evidence"].includes(c.action as string));
  } else if (t.kind === "towing") {
    draftKeys(c, ["commandId", "type", "expectedRevision", "assignmentGeneration", "payload"]);
    check(["start", "update_order", "submit", "abandon_attachment"].includes(c.type as string) && positive(c.assignmentGeneration));
  } else {
    draftKeys(c, ["commandId", "action", "requestId", "expectedRevision", "payload"]);
    check(["claim", "release", "materialize", "operate", "reopen"].includes(c.action as string) && c.requestId === t.id);
  }
  return copy(v) as WorkIntent;
}

export class WorkCommands {
  private view: WorkCommandsView = { ready: false, enabled: true, busy: false, error: null, pending: [] };
  private listeners = new Set<() => void>();
  private disposed = false;
  private active = true;
  private running = false;
  readonly key: string;
  private clock: () => number;
  constructor(private storage: StorageDriver, private scope: WorkCommandScope, private send: (intent: WorkIntent) => Promise<unknown>, private options: Options) {
    this.key = workCommandsKey(scope); this.clock = options.clock ?? Date.now;
  }
  snapshot = () => this.view;
  subscribe = (notify: () => void) => { this.listeners.add(notify); return () => { this.listeners.delete(notify); }; };
  pendingFor(target: WorkTarget) { return this.view.pending.find(item => targetKey(item.target) === targetKey(target)); }
  private current() { return this.active && !this.disposed && this.options.current(); }
  setActive(active: boolean) { this.active = active; this.update({ enabled: active }); }
  private update(change: Partial<WorkCommandsView>) {
    if (this.disposed) return;
    this.view = { ...this.view, ...change }; this.listeners.forEach(notify => notify());
  }
  private replace(record: PendingWork) { this.update({ pending: this.view.pending.map(item => targetKey(item.target) === targetKey(record.target) ? record : item) }); }
  private async persist(records: readonly WorkIntent[]) {
    const json = JSON.stringify({ version: 1, scope: this.scope, records: records.map(({ target, command, label, createdAt }) => ({ target, command, label, createdAt })) });
    if (records.length > MAX_RECORDS || new TextEncoder().encode(json).length > MAX_BYTES) throw new Error("Work command storage limit");
    await this.storage.setItem(this.key, json);
  }
  private async exclusive<T>(work: () => Promise<T | null>): Promise<T | null> {
    if (this.running || !this.current()) return null;
    this.running = true; this.update({ busy: true, error: null });
    try { return await work(); }
    finally { this.running = false; this.update({ busy: false }); }
  }
  async load(): Promise<void> {
    if (this.view.ready) return;
    await this.exclusive(async () => {
      try {
        const raw = await this.storage.getItem(this.key);
        if (!this.current()) return null;
        let records: WorkIntent[] = [];
        if (raw !== null) {
          check(raw.length <= MAX_BYTES);
          const v = draftObject(JSON.parse(raw)); draftKeys(v, ["version", "scope", "records"]);
          const s = draftObject(v.scope); draftKeys(s, ["environment", "apiOrigin", "projectUrl", "userId", "memberId"]);
          check(v.version === 1 && workCommandsKey(s as WorkCommandScope) === this.key && Array.isArray(v.records) && v.records.length <= MAX_RECORDS);
          records = (v.records as unknown[]).map(parseWorkIntent);
          check(new Set(records.map(item => targetKey(item.target))).size === records.length && new Set(records.map(item => item.command.commandId)).size === records.length);
        }
        this.update({ ready: true, pending: records.map(item => ({ ...item, status: "uncertain", message: null })) });
      } catch { if (this.current()) this.update({ error: "Uložené nepotvrdené kroky sa nepodarilo načítať. Skúste načítanie znova; nové kroky sa zatiaľ neodošlú." }); }
      return null;
    });
  }
  /** Stored first, then sent; null when it could not be sent or its result is not confirmed. */
  start<T>(target: WorkTarget, command: WorkCommand, label: string): Promise<T | null> {
    return this.exclusive(async () => {
      if (!this.view.ready || this.pendingFor(target)) return null;
      let intent: WorkIntent;
      try {
        intent = parseWorkIntent({ target, command, label, createdAt: new Date(this.clock()).toISOString() });
        await this.persist([...this.view.pending, intent]);
      } catch { this.update({ error: "Krok sa nepodarilo bezpečne uložiť v telefóne. Neodoslal sa. Skúste to znova." }); return null; }
      const record: PendingWork = { ...intent, status: "uncertain", message: null };
      this.update({ pending: [...this.view.pending, record] });
      if (!this.current()) return null;
      return this.deliver<T>(record);
    });
  }
  /** The same command again: the server answers with the first result if it was kept. */
  retry<T>(target: WorkTarget): Promise<T | null> {
    return this.exclusive(async () => {
      const record = this.pendingFor(target);
      return this.view.ready && record ? this.deliver<T>(record) : null;
    });
  }
  private async deliver<T>(record: PendingWork): Promise<T | null> {
    this.replace({ ...record, status: "sending", message: null });
    try {
      const result = await this.send(copy({ target: record.target, command: record.command, label: record.label, createdAt: record.createdAt }));
      if (!this.current()) { this.replace({ ...record, status: "uncertain" }); return null; }
      const remaining = this.view.pending.filter(item => targetKey(item.target) !== targetKey(record.target));
      try { await this.persist(remaining); }
      catch {
        this.replace({ ...record, status: "confirmed", message: "Server krok potvrdil, ale miestny záznam sa nepodarilo uzavrieť. Overte ten istý krok znova." });
        return this.current() ? result as T : null;
      }
      this.update({ pending: remaining }); return this.current() ? result as T : null;
    } catch (failure) {
      if (!this.current()) { this.replace({ ...record, status: "uncertain" }); return null; }
      // Only an explicit refusal lets the person close the intent after a fresh read.
      const rejected = failure instanceof MobileApiError && [400, 403, 404, 409, 422].includes(failure.status);
      this.replace({ ...record, status: rejected ? "rejected" : "uncertain",
        message: failure instanceof MobileApiError ? failure.message : "Spojenie sa prerušilo. Výsledok kroku zatiaľ nie je potvrdený." });
      return null;
    }
  }
  /** Only a refused step, after the screen has read the current state. */
  dismiss(target: WorkTarget) {
    return this.exclusive(async () => {
      const record = this.pendingFor(target);
      if (!record || record.status !== "rejected") return null;
      const remaining = this.view.pending.filter(item => targetKey(item.target) !== targetKey(target));
      try { await this.persist(remaining); if (this.current()) this.update({ pending: remaining }); }
      catch { this.update({ error: "Miestny záznam sa nepodarilo uzavrieť. Skúste to znova." }); }
      return null;
    });
  }
  dispose() { this.disposed = true; this.listeners.clear(); }
}
