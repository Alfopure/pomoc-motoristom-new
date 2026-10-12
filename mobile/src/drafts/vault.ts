import type { StorageDriver } from "../lib/session-storage";
import { DraftNotSentError, draftDate, draftId, draftKeys, draftObject, type DraftPort } from "./port";

export type DraftKind = "case-create" | "case-edit" | "case-note" | "task-create" | "task-state" | "handoff" | "attachment";
export type DraftScope = { environment: "test" | "production"; projectUrl: string; userId: string; profileId: string; organizationId: string };
export type StoredDraft = { key: string; kind: DraftKind; resourceId: string | null; generation: string; updatedAt: string; payload: object };
export type VaultState = { ready: boolean; saving: boolean; busy: boolean; error: string | null; records: StoredDraft[]; durable: boolean };
type Options = { durable: boolean; uuid: () => string; current: () => boolean; revalidate: () => Promise<void> };
const kinds: DraftKind[] = ["case-create", "case-edit", "case-note", "task-create", "task-state", "handoff", "attachment"];
const ACCOUNT_LIMIT = 90_000;
const RECORD_LIMIT = 64_000;
const RECORD_COUNT = 32;
const forbidden = new Set(["access_token", "refresh_token", "authorization", "jwt", "url", "uri", "localUri", "fileUri", "bytes", "context", "timeline", "attachments"]);
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

function scopeParts(scope: DraftScope) {
  const url = new URL(scope.projectUrl);
  if (!["test", "production"].includes(scope.environment) || url.protocol !== "https:" || url.origin !== scope.projectUrl
    || !/^[a-z]{20}\.supabase\.co$/.test(url.hostname) || ![scope.userId, scope.profileId, scope.organizationId].every(draftId)) throw new Error("Invalid draft scope");
  return [scope.environment, url.hostname.split(".")[0], scope.userId.toLowerCase(), scope.profileId.toLowerCase(), scope.organizationId.toLowerCase()];
}

export function draftStorageKey(scope: DraftScope) { return "pm-dispatch-drafts." + scopeParts(scope).join("."); }
function sameScope(a: DraftScope, b: DraftScope) { return JSON.stringify(scopeParts(a)) === JSON.stringify(scopeParts(b)); }
function recordKey(kind: DraftKind, resourceId: string | null) {
  if (!kinds.includes(kind) || kind === "case-create" && resourceId !== null || kind !== "case-create" && !draftId(resourceId)) throw new Error("Invalid draft identity");
  return kind + (resourceId ? "." + resourceId.toLowerCase() : "");
}

function privatePayload(value: unknown, depth = 0): void {
  if (depth > 20) throw new Error("Draft nesting limit");
  if (value === null || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value === "string" && !value.includes("\0")) return;
  if (Array.isArray(value)) { if (value.length > 200) throw new Error("Draft array limit"); value.forEach(item => privatePayload(item, depth + 1)); return; }
  const object = draftObject(value);
  if (![Object.prototype, null].includes(Object.getPrototypeOf(object))) throw new Error("Invalid draft object");
  for (const [key, item] of Object.entries(object)) {
    if (forbidden.has(key) || ["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Private draft projection contains excluded data");
    privatePayload(item, depth + 1);
  }
}

function encode(scope: DraftScope, records: Map<string, StoredDraft>): string {
  if (records.size > RECORD_COUNT) throw new Error("Draft count limit");
  for (const record of records.values()) {
    privatePayload(record.payload);
    if (Array.from(JSON.stringify(record.payload)).length > RECORD_LIMIT) throw new Error("Draft record limit");
  }
  const json = JSON.stringify({ v: 1, scope, records: [...records.values()] });
  if (Array.from(json).length > ACCOUNT_LIMIT) throw new Error("Draft account limit");
  return json;
}

function decode(raw: string, scope: DraftScope): Map<string, StoredDraft> {
  if (Array.from(raw).length > ACCOUNT_LIMIT) throw new Error("Draft account limit");
  const value = draftObject(JSON.parse(raw));
  draftKeys(value, ["v", "scope", "records"]);
  if (value.v !== 1) throw new Error("Unknown draft version");
  const storedScope = draftObject(value.scope);
  draftKeys(storedScope, ["environment", "projectUrl", "userId", "profileId", "organizationId"]);
  if (!sameScope(storedScope as DraftScope, scope)) throw new Error("Foreign draft scope");
  if (!Array.isArray(value.records) || value.records.length > RECORD_COUNT) throw new Error("Invalid draft records");
  const records = new Map<string, StoredDraft>();
  for (const rawRecord of value.records) {
    const r = draftObject(rawRecord);
    draftKeys(r, ["key", "kind", "resourceId", "generation", "updatedAt", "payload"]);
    if (!kinds.includes(r.kind as DraftKind) || r.key !== recordKey(r.kind as DraftKind, r.resourceId as string | null)
      || !draftId(r.generation) || !draftDate(r.updatedAt) || records.has(r.key as string)) throw new Error("Invalid draft record");
    draftObject(r.payload);
    records.set(r.key as string, r as StoredDraft);
  }
  encode(scope, records);
  return records;
}

class AccountLedger {
  records = new Map<string, StoredDraft>();
  savedRecords = new Map<string, StoredDraft>();
  versions = new Map<string, string>();
  rejected = new Set<string>();
  recordErrors = new Map<string, string>();
  revision = 0;
  persisted = 0;
  ready = false;
  writing = false;
  error: string | null = null;
  listeners = new Set<() => void>();
  owners = 0;
  tickets = 0;
  preparing = 0;
  clearing = 0;
  epoch = 0;
  removing = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queued: Promise<unknown> = Promise.resolve();
  private loading: Promise<void> | null = null;
  constructor(readonly storage: StorageDriver, readonly scope: DraftScope, readonly key: string) {}
  notify() { for (const listener of this.listeners) listener(); }
  load() {
    if (this.ready) return Promise.resolve();
    if (this.loading) return this.loading;
    const epoch = this.epoch;
    this.loading = Promise.resolve().then(async () => {
      try {
        const raw = await this.storage.getItem(this.key);
        if (epoch !== this.epoch) return;
        this.records = raw === null ? new Map() : decode(raw, this.scope);
        this.savedRecords = new Map([...this.records].map(([key, record]) => [key, copy(record)]));
        this.versions = new Map([...this.records].map(([key, record]) => [key, record.generation]));
        this.ready = true; this.error = null;
      } catch { if (epoch === this.epoch) this.error = "Uložené koncepty sa nepodarilo načítať alebo overiť. Skúste ich načítať znova; nebudú sa automaticky prepisovať."; }
      finally { this.notify(); }
    }).finally(() => { this.loading = null; });
    return this.loading;
  }
  change() {
    this.revision++; this.notify();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush().catch(() => undefined); }, 300);
  }
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const operation = async () => {
      if (!this.ready) throw new DraftNotSentError("Uložené koncepty ešte nie sú overené. Požiadavka sa neodoslala.");
      this.writing = true; this.notify();
      try {
        if (this.persisted !== this.revision) {
          const revision = this.revision, records = new Map([...this.records].map(([key, record]) => [key, copy(record)])), value = encode(this.scope, records);
          await this.storage.setItem(this.key, value);
          this.persisted = revision;
          this.savedRecords = records;
        }
        this.error = null;
      } catch {
        this.error = "Koncepty sa nepodarilo uložiť v tomto zariadení. Skúste miestne uloženie znova. Potvrdené serverové zápisy zostávajú uložené.";
        throw new DraftNotSentError();
      } finally { this.writing = false; this.notify(); this.release(); }
    };
    const result = this.queued.then(operation, operation);
    this.queued = result.catch(() => undefined);
    return result;
  }
  clear(generation: () => string): Promise<void> {
    this.clearing++; this.epoch++;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    for (const key of this.versions.keys()) this.versions.set(key, generation());
    this.notify();
    const operation = async () => {
      try {
        await this.storage.removeItem(this.key);
        this.records.clear(); this.savedRecords.clear(); this.rejected.clear(); this.recordErrors.clear();
        this.ready = true; this.error = null;
        this.revision++; this.persisted = this.revision;
      } catch {
        this.error = "Uložené koncepty sa nepodarilo odstrániť. Ich odstránenie nie je potvrdené.";
        // A failed remove can already be visible to the native process. If we
        // have verified records, retry must publish them, not just clear error.
        if (this.ready) this.change();
        throw new DraftNotSentError(this.error);
      } finally { this.clearing--; this.notify(); this.release(); }
    };
    const result = this.queued.then(operation, operation);
    this.queued = result.catch(() => undefined);
    return result;
  }
  release() {
    if (!this.owners && !this.preparing && !this.tickets && !this.timer && !this.writing && !this.clearing && this.revision === this.persisted && !this.recordErrors.size) {
      if (ledgers.get(this.key) === this) ledgers.delete(this.key);
      this.records.clear(); this.savedRecords.clear(); this.versions.clear(); this.rejected.clear(); this.recordErrors.clear();
    }
  }
}

// Multiple owners of the same account share the complete-envelope write order.
const ledgers = new Map<string, AccountLedger>();

/** Await every ready in-process ledger for this authenticated account before
 * logout, including a prior organization whose screen has just closed. */
export async function flushAccountDrafts(scope: Pick<DraftScope, "environment" | "projectUrl" | "userId">) {
  const active = [...ledgers.values()].filter(ledger => ledger.ready && ledger.scope.environment === scope.environment
    && ledger.scope.projectUrl === scope.projectUrl && ledger.scope.userId.toLowerCase() === scope.userId.toLowerCase());
  await Promise.all(active.map(async ledger => {
    await ledger.flush();
    if (ledger.recordErrors.size) throw new DraftNotSentError("Niektoré koncepty sa nepodarilo uložiť. Pred odhlásením ich opravte alebo vedome zahoďte.");
  }));
}

export class DraftVault {
  private closed = false;
  private state: VaultState;
  private listeners = new Set<() => void>();
  private constructor(private ledger: AccountLedger, readonly scope: DraftScope, private options: Options) {
    ledger.owners++;
    this.state = this.view();
    ledger.listeners.add(this.changed);
  }
  static async open(storage: StorageDriver, scope: DraftScope, options: Options) {
    const key = draftStorageKey(scope);
    let ledger = ledgers.get(key);
    if (!ledger) { ledger = new AccountLedger(storage, copy(scope), key); ledgers.set(key, ledger); }
    const vault = new DraftVault(ledger, copy(scope), options);
    await ledger.load(); return vault;
  }
  private view(): VaultState { return { ready: this.ledger.ready, saving: this.ledger.writing || !!this.ledger.clearing || this.ledger.revision !== this.ledger.persisted,
    busy: !!this.ledger.preparing || !!this.ledger.tickets,
    error: this.ledger.error ?? this.ledger.recordErrors.values().next().value ?? null, records: copy([...this.ledger.records.values()]), durable: this.options.durable }; }
  private changed = () => { if (!this.closed) { this.state = this.view(); for (const listener of this.listeners) listener(); } };
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  current() { return !this.closed && this.options.current() && this.ledger.ready && !this.ledger.clearing; }
  async retry() { if (!this.ledger.ready) await this.ledger.load(); else await this.ledger.flush(); }
  async flush() { await this.ledger.flush(); }
  bind(kind: DraftKind, resourceId: string | null = null): DraftPort {
    if (!this.current()) throw new DraftNotSentError("Koncepty ešte nie sú bezpečne pripravené.");
    const key = recordKey(kind, resourceId), generation = this.options.uuid();
    if (this.ledger.removing.has(key)) throw new DraftNotSentError("Tento koncept sa práve odstraňuje.");
    if (!draftId(generation)) throw new Error("Invalid draft generation");
    const stored = this.ledger.records.get(key);
    this.ledger.versions.set(key, generation);
    const current = () => this.current() && !this.ledger.removing.has(key) && !this.ledger.rejected.has(key) && this.ledger.versions.get(key) === generation;
    let lastPayload = stored ? copy(stored.payload) : null;
    const stage = (payload: object, settle = false) => {
      if ((!settle && !current()) || this.ledger.versions.get(key) !== generation || this.ledger.rejected.has(key)) throw new DraftNotSentError("Tento koncept už patrí uzavretej obrazovke alebo zmenenému účtu. Požiadavka sa neodoslala.");
      privatePayload(payload);
      const next = copy(payload);
      const existing = this.ledger.records.get(key);
      if (existing?.generation === generation && JSON.stringify(existing.payload) === JSON.stringify(next)) {
        this.ledger.recordErrors.delete(key); return;
      }
      const record: StoredDraft = { key, kind, resourceId, generation, updatedAt: new Date().toISOString(), payload: next };
      const candidate = new Map(this.ledger.records); candidate.set(key, record); encode(this.scope, candidate);
      lastPayload = next; this.ledger.records = candidate; this.ledger.recordErrors.delete(key); this.ledger.change();
    };
    return {
      load: () => { if (!current()) throw new DraftNotSentError(); return copy(lastPayload); },
      current,
      settled: () => current() && !this.ledger.error && !this.ledger.recordErrors.has(key)
        && JSON.stringify(this.ledger.savedRecords.get(key)?.payload ?? null) === JSON.stringify(lastPayload),
      changed: payload => {
        if (!current()) return;
        try { stage(payload); } catch { this.ledger.recordErrors.set(key, "Koncept je príliš veľký alebo obsahuje údaje, ktoré sa nemôžu miestne uložiť. Požiadavka sa bez uloženia neodošle."); this.ledger.notify(); }
      },
      reject: () => { this.ledger.rejected.add(key); this.ledger.recordErrors.set(key, "Tento uložený koncept sa nepodarilo overiť. Najprv ho skontrolujte alebo vedome zahoďte."); this.ledger.notify(); },
      acceptsScope: value => {
        try { const v = draftObject(value); return v.ok === true && v.apiVersion === 1 && v.environment === this.scope.environment
          && v.profileId === this.scope.profileId && draftDate(v.checkedAt); } catch { return false; }
      },
      prepare: async payload => {
        if (!current()) throw new DraftNotSentError();
        this.ledger.preparing++; this.ledger.notify();
        try {
          try { await this.options.revalidate(); } catch (error) { throw new DraftNotSentError(error instanceof Error ? error.message : "Prístup sa nepodarilo overiť. Požiadavka sa neodoslala."); }
          if (!current()) throw new DraftNotSentError();
          try { stage(typeof payload === "function" ? payload() : payload); await this.ledger.flush(); } catch (error) { throw error instanceof DraftNotSentError ? error : new DraftNotSentError(); }
          if (!current()) throw new DraftNotSentError();
          this.ledger.tickets++;
          let finished = false;
          return { finish: async outcome => {
            if (finished) return false;
            finished = true;
            let staged = false;
            try {
              if (this.ledger.versions.get(key) !== generation || this.ledger.rejected.has(key)) return false;
              stage(outcome, true); staged = true; await this.ledger.flush(); return true;
            } catch {
              if (!staged && this.ledger.versions.get(key) === generation) {
                this.ledger.recordErrors.set(key, "Výsledok požiadavky sa nepodarilo miestne uložiť. Nový zápis je zablokovaný, kým sa uloženie nepotvrdí alebo koncept vedome nezahodíte.");
                this.ledger.notify();
              }
              return false;
            }
            finally { this.ledger.tickets--; this.ledger.notify(); this.ledger.release(); }
          } };
        } finally { this.ledger.preparing--; this.ledger.notify(); this.ledger.release(); }
      },
    };
  }
  async discard(key: string) {
    if (!this.current() || !this.ledger.records.has(key)) throw new DraftNotSentError();
    if (this.ledger.preparing || this.ledger.tickets) throw new DraftNotSentError("Najprv počkajte na dokončenie prebiehajúcej požiadavky. Koncept sa neodstránil.");
    if ([...this.ledger.recordErrors.keys()].some(other => other !== key)) throw new DraftNotSentError("Iný formulár má neuložené zmeny. Najprv ich opravte alebo vedome zahoďte všetky miestne koncepty. Tento koncept sa neodstránil.");
    const old = this.ledger.records.get(key)!;
    const epoch = this.ledger.epoch;
    const oldError = this.ledger.recordErrors.get(key);
    if (this.ledger.removing.has(key)) throw new DraftNotSentError();
    this.ledger.removing.add(key);
    const generation = this.options.uuid();
    this.ledger.versions.set(key, generation); this.ledger.rejected.delete(key); this.ledger.recordErrors.delete(key);
    this.ledger.records.delete(key); this.ledger.change();
    try { await this.ledger.flush(); }
    catch (error) { if (this.ledger.epoch === epoch) { this.ledger.records.set(key, { ...old, generation }); if (oldError) this.ledger.recordErrors.set(key, oldError); this.ledger.change(); } throw error; }
    finally { this.ledger.removing.delete(key); }
    return { resetSafe: !this.ledger.preparing && !this.ledger.tickets && !this.ledger.recordErrors.size };
  }
  async discardAll() {
    if (this.closed || !this.options.current()) throw new DraftNotSentError();
    await this.ledger.clear(this.options.uuid);
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.ledger.listeners.delete(this.changed); this.listeners.clear();
    this.ledger.owners--; void this.ledger.flush().catch(() => undefined).finally(() => this.ledger.release());
  }
}
