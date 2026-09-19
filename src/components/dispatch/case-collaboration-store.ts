import { CASE_ACL_LEASE_MS, CASE_REVALIDATE_MS, type CaseLiveSnapshot, type CaseEditorPresence } from "@/domain/case-collaboration";
import { compareCaseRevisions } from "@/data/case-detail";
import type { DispatchCase, DispatchNotification } from "@/domain/types";

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type CaseCollaborationState = {
  cases: DispatchCase[]; notifications: DispatchNotification[]; editors: CaseEditorPresence[];
  available: boolean | null; hidden: boolean; denied: boolean; stale: boolean; connected: boolean;
  error: string; authorizedUntil: number;
};
/** One instance per authenticated console. Broadcasts are hints, never trusted data. */
export class CaseCollaborationStore {
  private state: CaseCollaborationState;
  private listeners = new Set<() => void>();
  private versions: Record<string, number> = {};
  private deletedIds = new Set<string>();
  private localEpoch = 0;
  private localChanges = new Map<string, number>();
  private generation = 0;
  private controller: AbortController | null = null;
  private pending: Promise<void> | null = null;
  private again = false;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private leaseTimer: ReturnType<typeof setTimeout> | undefined;
  private invalidateTimer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  constructor(initial: DispatchCase[] = [], private fetcher: Fetcher = (url, init) => fetch(url, init), private now: () => number = Date.now) {
    this.state = { cases: initial, notifications: [], editors: [], available: null, hidden: true, denied: false, stale: true, connected: false, error: "", authorizedUntil: 0 };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<CaseCollaborationState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()); }
  setConnected = (connected: boolean) => { this.update({ connected, stale: !connected || this.state.hidden }); if (connected) this.invalidate(); };
  start = () => { this.running = true; void this.refresh(); };
  stop = () => { this.running = false; this.revoke(); };
  revoke = () => {
    this.generation++; this.controller?.abort(); this.controller = null; this.pending = null; this.again = false;
    clearTimeout(this.refreshTimer); clearTimeout(this.leaseTimer); clearTimeout(this.invalidateTimer);
    this.versions = {};
    this.deletedIds.clear(); this.localChanges.clear();
    this.update({ cases: [], notifications: [], editors: [], hidden: true, denied: true, stale: true, connected: false, authorizedUntil: 0 });
  };
  /** Expiry hides existing editors without destroying local draft state. */
  checkLease = () => {
    if (this.state.available !== false && this.now() >= this.state.authorizedUntil) this.update({ hidden: true, stale: true, editors: [] });
  };
  resume = () => { this.checkLease(); void this.refresh(); };
  invalidate = () => {
    if (!this.running || this.state.denied || this.invalidateTimer) return;
    this.invalidateTimer = setTimeout(() => { this.invalidateTimer = undefined; void this.refresh(); }, 500);
  };
  /** Local saves do not get overwritten by an older response already in flight. */
  acceptCases = (cases: DispatchCase[]) => {
    if (this.state.denied) return;
    const local = new Map(cases.filter(item => !this.deletedIds.has(item.id)).map(item => [item.id, item]));
    const merged = this.state.cases.map(item => {
      const incoming = local.get(item.id); local.delete(item.id);
      if (incoming && compareCaseRevisions(incoming.updatedAt, item.updatedAt) > 0) this.localChanges.set(item.id, ++this.localEpoch);
      return incoming && compareCaseRevisions(incoming.updatedAt, item.updatedAt) >= 0 ? incoming : item;
    });
    for (const id of local.keys()) this.localChanges.set(id, ++this.localEpoch);
    const next = [...merged, ...local.values()];
    if (next.length !== this.state.cases.length || next.some((item, index) => item !== this.state.cases[index])) this.update({ cases: next });
  };
  refresh = (): Promise<void> => {
    if (this.pending) { this.again = true; return this.pending; }
    const generation = this.generation;
    const operation = this.read(generation);
    this.pending = operation;
    void operation.finally(() => {
      if (this.pending !== operation) return;
      this.pending = null;
      if (this.again && this.running) { this.again = false; this.invalidate(); }
    });
    return operation;
  };
  private async read(generation: number) {
    const controller = new AbortController(); this.controller = controller;
    const started = this.now();
    const epoch = this.localEpoch;
    clearTimeout(this.refreshTimer);
    try {
      const response = await this.fetcher("/api/cases/live", { method: "POST", cache: "no-store", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ versions: this.versions }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]) });
      if (generation !== this.generation) return;
      if (response.status === 401 || response.status === 403) { this.revoke(); return; }
      if (!response.ok) throw new Error("Aktualizácie sú dočasne nedostupné.");
      const snapshot = await response.json() as CaseLiveSnapshot;
      if (generation !== this.generation || controller.signal.aborted) return;
      // Compatibility before the additive migration. Never downgrade after activation.
      if (!snapshot.available) {
        if (this.state.available === true) throw new Error("Aktualizácie sú dočasne nedostupné.");
        this.update({ available: false, hidden: false, stale: false }); return;
      }
      const changes = new Map(snapshot.changes.map(item => [item.id, item]));
      const allowed = new Set(snapshot.ids);
      for (const item of this.state.cases) if (!allowed.has(item.id) && (this.localChanges.get(item.id) ?? 0) <= epoch) this.deletedIds.add(item.id);
      const cases = this.state.cases.filter(item => allowed.has(item.id) || (this.localChanges.get(item.id) ?? 0) > epoch).map(item => {
        const incoming = changes.get(item.id); changes.delete(item.id);
        return incoming && compareCaseRevisions(incoming.updatedAt, item.updatedAt) >= 0 ? { ...item, ...incoming, tasks: item.tasks } : item;
      });
      for (const item of changes.values()) cases.push({ ...item, tasks: [] });
      this.versions = snapshot.versions;
      const authorizedUntil = started + CASE_ACL_LEASE_MS;
      this.update({ cases, notifications: snapshot.notifications, editors: snapshot.editors, available: true,
        authorizedUntil, hidden: this.now() >= authorizedUntil, denied: false, stale: !this.state.connected, error: "" });
      clearTimeout(this.leaseTimer);
      this.leaseTimer = setTimeout(this.checkLease, Math.max(0, authorizedUntil - this.now()));
      if (snapshot.more) this.again = true;
    } catch {
      if (generation === this.generation && !controller.signal.aborted) { this.checkLease(); this.update({ stale: true, error: "Spojenie sa obnovuje. Zobrazujú sa posledné overené údaje." }); }
    } finally {
      if (generation === this.generation && this.running && !this.state.denied) this.refreshTimer = setTimeout(() => void this.refresh(), CASE_REVALIDATE_MS);
      if (this.controller === controller) this.controller = null;
    }
  }
}
