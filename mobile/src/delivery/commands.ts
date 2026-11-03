import type { MobileDelivery, MobileDeliveryAction, MobileDeliveryCommand } from "../../../src/lib/mobile-api";
import { draftDate, draftId, draftKeys, draftObject } from "../drafts/port";
import { MobileApiError } from "../lib/api";
import type { StorageDriver } from "../lib/session-storage";
import type { DeliveryApi } from "./api";
import { isOpen, nextStep } from "./model";

export type DeliveryCommandScope = { environment: "test" | "production"; apiOrigin: string; projectUrl: string; userId: string; memberId: string };
type Intent = { deliveryId: string; command: MobileDeliveryCommand; createdAt: string };
export type PendingDeliveryCommand = Intent & { status: "sending" | "uncertain" | "rejected" | "confirmed"; message: string | null; failure: unknown; reviewed: boolean };
export type DeliveryCommandsView = { ready: boolean; enabled: boolean; busy: boolean; error: string | null; pending: readonly PendingDeliveryCommand[] };
type Options = { current: () => boolean; uuid: () => string; clock?: () => number };
const MAX_RECORDS = 16, MAX_BYTES = 100_000;
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v < 2_147_483_647;
const check = (v: unknown) => { if (!v) throw new Error("Invalid delivery command record"); };

export function deliveryCommandsKey(scope: DeliveryCommandScope): string {
  const targets = scope.environment === "test" ? ["https://test.dispecing.linkapomoci.sk", "nzpnqdstvkfncflgqlny"]
    : scope.environment === "production" ? ["https://dispecing.linkapomoci.sk", "ifpaeegaesdmljfkdvcn"] : [];
  check(scope.apiOrigin === targets[0] && scope.projectUrl === "https://" + targets[1] + ".supabase.co" && draftId(scope.userId) && draftId(scope.memberId));
  return ["pm-delivery-commands-v1", scope.environment, targets[1], scope.userId.toLowerCase(), scope.memberId.toLowerCase()].join(".");
}

function parseIntent(value: unknown): Intent {
  const v = draftObject(value); draftKeys(v, ["deliveryId", "command", "createdAt"]);
  check(draftId(v.deliveryId) && draftDate(v.createdAt));
  const c = draftObject(v.command); draftKeys(c, ["commandId", "action", "expectedRevision", "publishedVersion"], ["comment", "eta"]);
  check(draftId(c.commandId) && integer(c.expectedRevision) && integer(c.publishedVersion)
    && ["accept", "reject", "en_route", "arrived", "complete", "update", "blocked"].includes(c.action as string));
  check(c.comment === undefined || typeof c.comment === "string" && c.comment.length <= 1000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(c.comment));
  check(!["reject", "blocked"].includes(c.action as string) || typeof c.comment === "string" && c.comment.trim().length > 0);
  check(c.eta === undefined || c.eta === null || draftDate(c.eta));
  return copy(v) as Intent;
}

/** Only the immutable intent is kept, without tokens, customer cards or locations.
 * A restored intent is never sent automatically. The person retries it explicitly. */
export class DeliveryCommands {
  private view: DeliveryCommandsView = { ready: false, enabled: true, busy: false, error: null, pending: [] };
  private listeners = new Set<() => void>();
  private disposed = false;
  private active = true;
  private running = false;
  readonly key: string;
  private clock: () => number;
  constructor(private storage: StorageDriver, private scope: DeliveryCommandScope, private api: Pick<DeliveryApi, "command" | "read">, private options: Options) {
    this.key = deliveryCommandsKey(scope); this.clock = options.clock ?? Date.now;
  }
  snapshot = () => this.view;
  subscribe = (notify: () => void) => { this.listeners.add(notify); return () => { this.listeners.delete(notify); }; };
  private current() { return this.active && !this.disposed && this.options.current(); }
  setActive(active: boolean) { this.active = active; this.update({ enabled: active }); }
  private update(change: Partial<DeliveryCommandsView>) {
    if (this.disposed) return;
    this.view = { ...this.view, ...change }; this.listeners.forEach(notify => notify());
  }
  private replace(record: PendingDeliveryCommand) { this.update({ pending: this.view.pending.map(item => item.deliveryId === record.deliveryId ? record : item) }); }
  private async persist(records: readonly Intent[]) {
    const json = JSON.stringify({ version: 1, scope: this.scope, records: records.map(({ deliveryId, command, createdAt }) => ({ deliveryId, command, createdAt })) });
    if (records.length > MAX_RECORDS || new TextEncoder().encode(json).length > MAX_BYTES) throw new Error("Delivery command storage limit");
    await this.storage.setItem(this.key, json);
  }
  private async exclusive(work: () => Promise<MobileDelivery | null>): Promise<MobileDelivery | null> {
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
        let records: Intent[] = [];
        if (raw !== null) {
          check(raw.length <= MAX_BYTES);
          const v = draftObject(JSON.parse(raw)); draftKeys(v, ["version", "scope", "records"]);
          const s = draftObject(v.scope); draftKeys(s, ["environment", "apiOrigin", "projectUrl", "userId", "memberId"]);
          check(v.version === 1 && deliveryCommandsKey(s as DeliveryCommandScope) === this.key && Array.isArray(v.records) && v.records.length <= MAX_RECORDS);
          records = (v.records as unknown[]).map(parseIntent);
          check(new Set(records.map(item => item.deliveryId)).size === records.length && new Set(records.map(item => item.command.commandId)).size === records.length);
        }
        this.update({ ready: true, pending: records.map(item => ({ ...item, status: "uncertain", message: null, failure: null, reviewed: false })) });
      } catch { if (this.current()) this.update({ error: "Uložené nepotvrdené kroky sa nepodarilo načítať. Skúste načítanie znova; nové kroky sa zatiaľ neodošlú." }); }
      return null;
    });
  }
  start(delivery: MobileDelivery, action: MobileDeliveryAction, extra: { comment?: string; eta?: string | null } = {}) {
    return this.exclusive(async () => {
      if (!this.view.ready || this.view.pending.some(item => item.deliveryId === delivery.id) || !isOpen(delivery, this.clock())) return null;
      if (action !== nextStep(delivery, this.clock())?.action && !(action === "reject" && delivery.status === "offered")
        && !(action === "blocked" && delivery.status !== "offered") && !(action === "update" && ["accepted", "en_route"].includes(delivery.status))) return null;
      let intent: Intent;
      try {
        intent = parseIntent({ deliveryId: delivery.id, createdAt: new Date(this.clock()).toISOString(),
          command: { commandId: this.options.uuid(), action, expectedRevision: delivery.revision, publishedVersion: delivery.publishedVersion, ...extra } });
        await this.persist([...this.view.pending, intent]);
      } catch { this.update({ error: "Krok sa nepodarilo bezpečne uložiť v telefóne. Neodoslal sa. Skúste to znova." }); return null; }
      const record: PendingDeliveryCommand = { ...intent, status: "uncertain", message: null, failure: null, reviewed: false };
      this.update({ pending: [...this.view.pending, record] });
      if (!this.current()) return null;
      return this.send(record);
    });
  }
  retry(deliveryId: string) {
    return this.exclusive(async () => {
      const record = this.view.pending.find(item => item.deliveryId === deliveryId);
      return this.view.ready && record ? this.send(record) : null;
    });
  }
  private async send(record: PendingDeliveryCommand): Promise<MobileDelivery | null> {
    this.replace({ ...record, status: "sending", message: null, reviewed: false });
    try {
      const next = await this.api.command(record.deliveryId, copy(record.command));
      if (!this.current()) { this.replace({ ...record, status: "uncertain", reviewed: false }); return null; }
      const remaining = this.view.pending.filter(item => item.deliveryId !== record.deliveryId);
      try { await this.persist(remaining); }
      catch {
        this.replace({ ...record, status: "confirmed", failure: null, reviewed: false, message: "Server krok potvrdil, ale miestny záznam sa nepodarilo uzavrieť. Overte tú istú požiadavku znova." });
        return this.current() ? next : null;
      }
      this.update({ pending: remaining }); return this.current() ? next : null;
    } catch (failure) {
      if (!this.current()) { this.replace({ ...record, status: "uncertain", reviewed: false }); return null; }
      // Only an explicit refusal permits dismissing the intent after a fresh read.
      // A timeout, malformed reply or 5xx can arrive after the step was committed.
      const rejected = failure instanceof MobileApiError && [400, 404, 409, 422].includes(failure.status);
      this.replace({ ...record, status: rejected ? "rejected" : "uncertain", failure, reviewed: false,
        message: failure instanceof MobileApiError ? failure.message : "Spojenie sa prerušilo. Výsledok kroku zatiaľ nie je potvrdený." });
      return null;
    }
  }
  review(deliveryId: string) {
    return this.exclusive(async () => {
      const record = this.view.pending.find(item => item.deliveryId === deliveryId);
      if (!record || record.status !== "rejected") return null;
      this.replace({ ...record, reviewed: false });
      try {
        const next = await this.api.read(deliveryId);
        if (!this.current()) return null;
        this.replace({ ...record, reviewed: true, failure: null }); return next;
      } catch (failure) {
        if (this.current() && failure instanceof MobileApiError && failure.status === 404) {
          this.replace({ ...record, reviewed: true, message: "Pristavenie už nie je dostupné. Miestne upozornenie môžete uzavrieť; zápisy na serveri sa tým nezrušia." });
        } else if (this.current()) this.update({ error: "Aktuálny stav sa nepodarilo overiť. Upozornenie zostáva zachované." });
        return null;
      }
    });
  }
  /** Called only after showing a fresh server state, or its explicit 404. Never
   * discards an uncertain transport result in order to create another command ID. */
  dismiss(deliveryId: string) {
    return this.exclusive(async () => {
      const record = this.view.pending.find(item => item.deliveryId === deliveryId);
      if (!record || record.status !== "rejected" || !record.reviewed) return null;
      const remaining = this.view.pending.filter(item => item.deliveryId !== deliveryId);
      try { await this.persist(remaining); if (this.current()) this.update({ pending: remaining }); }
      catch { this.update({ error: "Miestny záznam sa nepodarilo uzavrieť. Skúste to znova." }); }
      return null;
    });
  }
  dispose() { this.disposed = true; this.listeners.clear(); }
}
