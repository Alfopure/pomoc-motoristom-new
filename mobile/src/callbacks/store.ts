import type { MobileCallbackCounts, MobileCallbackRequest, MobileCallTarget } from "../../../src/lib/mobile-callbacks";
import { MOBILE_CALLBACK_NOTE_LIMIT } from "../../../src/lib/mobile-callbacks";
import { MobileApiError } from "../lib/api";
import type { CallbacksApi } from "./api";
import { dialDecision, type DialDecision } from "./model";

export type CallbackEditor = { id: string; status: "done" | "cancelled"; notes: string };
export type CallbackNotice = { id: string | null; message: string; tone: "error" | "info" };
export type CallbackQueueState = {
  counts: MobileCallbackCounts | null;
  open: MobileCallbackRequest[];
  resolved: MobileCallbackRequest[];
  nextCursor: string | null;
  checkedAt: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  moreError: string | null;
  pending: { id: string; action: "claim" | "resolve" | "call" } | null;
  editor: CallbackEditor | null;
  notice: CallbackNotice | null;
};
type TargetLookup = (number: string, signal?: AbortSignal) => Promise<MobileCallTarget["target"]>;
const empty: CallbackQueueState = { counts: null, open: [], resolved: [], nextCursor: null, checkedAt: null, loading: false, loadingMore: false,
  error: null, moreError: null, pending: null, editor: null, notice: null };
const message = (error: unknown, fallback: string) => error instanceof MobileApiError ? error.message : fallback;
/** No HTTP answer, or an answer we could not trust: the write may or may not be committed. */
const uncertain = (error: unknown) => !(error instanceof MobileApiError) || error.status === 0 || error.status >= 500;

/** Screen state for the callback queue. Reads are cancelled when hidden; a
 * write's late answer is ignored after hiding, and the next visit re-reads. */
export class CallbackQueueStore {
  private state: CallbackQueueState = empty;
  private listeners = new Set<() => void>();
  private generation = 0;
  private active = false;
  private disposed = false;
  private reading: AbortController | null = null;
  private more: AbortController | null = null;
  constructor(private api: CallbacksApi, private target: TargetLookup) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<CallbackQueueState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private live(generation: number) { return !this.disposed && this.active && generation === this.generation; }
  setActive(active: boolean) {
    if (this.disposed || active === this.active) return;
    this.active = active;
    if (!active) {
      this.generation += 1;
      this.reading?.abort(); this.more?.abort(); this.reading = this.more = null;
      // Settled server state is re-read on return; nothing local claims to be current.
      this.update({ ...empty, editor: this.state.editor });
    }
  }
  async refresh(): Promise<void> {
    if (!this.active || this.disposed) return;
    this.reading?.abort(); this.more?.abort(); this.more = null;
    const controller = new AbortController(), generation = this.generation;
    this.reading = controller;
    this.update({ loading: true, error: null, moreError: null, loadingMore: false });
    try {
      const page = await this.api.list(null, controller.signal);
      if (!this.live(generation) || this.reading !== controller) return;
      const current = this.state.editor, row = current ? page.open.find(item => item.id === current.id) : undefined;
      // A request beyond the first page is not known to be settled; keep its note.
      const editor = current && (row ? row.actions.resolve : page.nextCursor !== null) ? current : null;
      this.update({ counts: page.counts, open: page.open, resolved: page.resolved, nextCursor: page.nextCursor, checkedAt: page.checkedAt, editor,
        notice: current && !editor ? { id: current.id, message: "Požiadavka už nie je otvorená pre vás. Zoznam je obnovený.", tone: "info" } : this.state.notice });
    } catch (error) {
      if (!this.live(generation) || this.reading !== controller) return;
      this.update({ error: message(error, "Spätné volania sa nepodarilo načítať. Skúste znova.") });
    } finally {
      if (this.reading === controller) { this.reading = null; if (this.live(generation)) this.update({ loading: false }); }
    }
  }
  async loadMore(): Promise<void> {
    const cursor = this.state.nextCursor;
    if (!cursor || !this.active || this.reading || this.more) return;
    const controller = new AbortController(), generation = this.generation;
    this.more = controller;
    this.update({ loadingMore: true, moreError: null });
    try {
      const page = await this.api.list(cursor, controller.signal);
      if (!this.live(generation) || this.more !== controller) return;
      if (page.resetPage) { this.more = null; this.update({ loadingMore: false }); await this.refresh(); return; }
      const known = new Set(this.state.open.map(item => item.id));
      this.update({ open: [...this.state.open, ...page.open.filter(item => !known.has(item.id))], counts: page.counts, nextCursor: page.nextCursor });
    } catch (error) {
      if (!this.live(generation) || this.more !== controller) return;
      this.update({ moreError: message(error, "Ďalšie požiadavky sa nepodarilo načítať.") });
    } finally {
      if (this.more === controller) { this.more = null; if (this.live(generation)) this.update({ loadingMore: false }); }
    }
  }
  private find(id: string) { return this.state.open.find(item => item.id === id) ?? null; }
  private applied(request: MobileCallbackRequest) {
    const resolved = request.status === "done" || request.status === "cancelled";
    const counts = this.state.counts;
    const before = this.find(request.id);
    this.update({
      open: resolved ? this.state.open.filter(item => item.id !== request.id) : this.state.open.map(item => item.id === request.id ? request : item),
      resolved: resolved ? [request, ...this.state.resolved.filter(item => item.id !== request.id)] : this.state.resolved,
      counts: resolved && before && counts ? { ...counts, open: Math.max(0, counts.open - 1), [before.origin]: Math.max(0, counts[before.origin] - 1) } : counts,
    });
  }
  private async write(id: string, action: "claim" | "resolve", run: () => Promise<MobileCallbackRequest>, success: string): Promise<boolean> {
    if (!this.active || this.state.pending) return false;
    const generation = this.generation;
    this.update({ pending: { id, action }, notice: null });
    try {
      const request = await run();
      if (!this.live(generation)) return true;
      this.applied(request);
      this.update({ notice: { id, message: success, tone: "info" } });
      return true;
    } catch (error) {
      if (!this.live(generation)) return false;
      this.update({ notice: { id, tone: "error", message: uncertain(error)
        ? "Spojenie sa prerušilo. Výsledok overujeme obnovením zoznamu; akciu neopakujte naslepo."
        : message(error, "Akcia sa nepodarila.") } });
      return false;
    } finally {
      if (this.live(generation)) { this.update({ pending: null }); void this.refresh(); }
    }
  }
  claim(id: string) {
    const request = this.find(id);
    if (!request?.actions.claim) return Promise.resolve(false);
    return this.write(id, "claim", async () => (await this.api.claim(id)).request,
      request.actions.takeover ? "Požiadavku ste prevzali od kolegu." : "Požiadavku ste prevzali.");
  }
  openEditor(id: string, status: CallbackEditor["status"]) {
    if (this.state.pending || !this.find(id)?.actions.resolve) return;
    this.update({ editor: { id, status, notes: this.state.editor?.id === id ? this.state.editor.notes : "" }, notice: null });
  }
  editNotes(notes: string) { if (this.state.editor) this.update({ editor: { ...this.state.editor, notes: notes.slice(0, MOBILE_CALLBACK_NOTE_LIMIT) } }); }
  closeEditor() { if (!this.state.pending) this.update({ editor: null }); }
  async resolve(): Promise<boolean> {
    const editor = this.state.editor;
    if (!editor || !this.find(editor.id)?.actions.resolve) return false;
    const ok = await this.write(editor.id, "resolve", async () => (await this.api.resolve(editor.id, { status: editor.status, notes: editor.notes.trim() || null })).request,
      editor.status === "done" ? "Spätné volanie je vybavené." : "Požiadavka je zrušená.");
    if (ok && this.state.editor?.id === editor.id) this.update({ editor: null });
    return ok;
  }
  /** Directory check before ringing back; the call itself is started by the phone. */
  async prepareCall(id: string): Promise<Exclude<DialDecision, { kind: "blocked" }> | null> {
    const request = this.find(id);
    if (!this.active || this.state.pending || !request?.actions.call || !request.number) return null;
    const generation = this.generation;
    this.update({ pending: { id, action: "call" }, notice: null });
    try {
      const decision = dialDecision(await this.target(request.number));
      if (!this.live(generation)) return null;
      if (decision.kind === "blocked") { this.update({ notice: { id, message: decision.message, tone: "error" } }); return null; }
      return decision;
    } catch (error) {
      if (this.live(generation)) this.update({ notice: { id, message: message(error, "Číslo na spätné volanie sa nepodarilo overiť."), tone: "error" } });
      return null;
    } finally { if (this.live(generation)) this.update({ pending: null }); }
  }
  /** The phone reports its own errors; the queue only re-reads the claim/last call. */
  callStarted(id: string, error: string | null) {
    if (!this.active) return;
    this.update({ notice: error ? { id, message: error, tone: "error" } : { id, message: "Spätné volanie sa vytáča. Po rozhovore požiadavku uzavrite.", tone: "info" } });
    void this.refresh();
  }
  dismissNotice() { this.update({ notice: null }); }
  dispose() { this.setActive(false); this.disposed = true; this.listeners.clear(); }
}
