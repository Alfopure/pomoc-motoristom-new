import type { MobileCallOutcome, MobileCallWrapUp } from "../../../src/lib/mobile-call-wrap-up";
import { MOBILE_CALL_NOTE_LIMIT } from "../../../src/lib/mobile-call-wrap-up";
import { MobileApiError } from "../lib/api";
import type { CallWrapUpApi } from "./wrap-up-api";

/** One dispatcher intent. `sent` marks a command whose answer may be lost:
 * repeating it keeps its identity, while any edit becomes a new command. */
export type OutcomeEditor = { outcome: MobileCallOutcome | null; note: string; callbackMinutes: number | null; mutationId: string; sent: boolean };
export type WrapUpNotice = { message: string; tone: "info" | "error" };
export type WrapUpState = {
  data: MobileCallWrapUp | null;
  loading: boolean;
  error: string | null;
  editor: OutcomeEditor | null;
  saving: boolean;
  linking: string | null;
  notice: WrapUpNotice | null;
};
const empty: WrapUpState = { data: null, loading: false, error: null, editor: null, saving: false, linking: null, notice: null };
const message = (error: unknown, fallback: string) => error instanceof MobileApiError ? error.message : fallback;
const uncertain = (error: unknown) => !(error instanceof MobileApiError) || error.status === 0 || error.status >= 500;

export class WrapUpStore {
  private state: WrapUpState = empty;
  private listeners = new Set<() => void>();
  private active = false;
  private disposed = false;
  private generation = 0;
  private reading: AbortController | null = null;
  // Writes outlive a hidden screen; a returning screen must not start a second one meanwhile.
  private writing = false;
  private onLinked: () => void = () => {};
  constructor(private api: CallWrapUpApi, private callId: string, private uuid: () => string) {}
  /** The screen re-reads the call card after a link attempt; it supplies the current reader. */
  setLinkedListener(listener: () => void) { this.onLinked = listener; }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<WrapUpState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  private live(generation: number) { return !this.disposed && this.active && generation === this.generation; }
  setActive(active: boolean) {
    if (this.disposed || active === this.active) return;
    this.active = active;
    if (!active) {
      this.generation += 1; this.reading?.abort(); this.reading = null;
      // A typed outcome survives hiding; server state is read again on return.
      this.update({ ...empty, editor: this.state.editor });
    }
  }
  async refresh(): Promise<void> {
    if (!this.active || this.disposed) return;
    this.reading?.abort();
    const controller = new AbortController(), generation = this.generation;
    this.reading = controller;
    this.update({ loading: true, error: null });
    try {
      const data = await this.api.read(this.callId, controller.signal);
      if (this.live(generation) && this.reading === controller) this.update({ data });
    } catch (error) {
      if (this.live(generation) && this.reading === controller) this.update({ error: message(error, "Údaje po hovore sa nepodarilo načítať.") });
    } finally {
      if (this.reading === controller) { this.reading = null; if (this.live(generation)) this.update({ loading: false }); }
    }
  }
  openEditor() {
    if (this.state.saving || this.state.editor) return;
    const current = this.state.data?.outcome;
    this.update({ notice: null, editor: { outcome: current?.value ?? null, note: current?.note ?? "", callbackMinutes: current?.value === "callback" ? current.callbackMinutes ?? 30 : null, mutationId: this.uuid(), sent: false } });
  }
  private edit(patch: Partial<OutcomeEditor>) {
    const editor = this.state.editor;
    if (!editor || this.state.saving) return;
    this.update({ editor: { ...editor, ...patch, ...(editor.sent ? { mutationId: this.uuid(), sent: false } : {}) } });
  }
  choose(outcome: MobileCallOutcome) { this.edit({ outcome, callbackMinutes: outcome === "callback" ? this.state.editor?.callbackMinutes ?? 30 : null }); }
  editNote(note: string) { this.edit({ note: note.slice(0, MOBILE_CALL_NOTE_LIMIT) }); }
  chooseMinutes(callbackMinutes: number) { if (this.state.editor?.outcome === "callback") this.edit({ callbackMinutes }); }
  closeEditor() { if (!this.state.saving) this.update({ editor: null }); }
  /** A callback the server could not schedule is not offered as saveable. */
  canSave(): boolean {
    const editor = this.state.editor, data = this.state.data;
    return Boolean(editor?.outcome && data && !this.state.saving && (editor.outcome !== "callback" || editor.callbackMinutes && data.callbackScheduling !== "unavailable"));
  }
  async save(): Promise<boolean> {
    const editor = this.state.editor;
    if (!this.active || this.writing || !editor?.outcome || !this.canSave()) return false;
    const generation = this.generation;
    this.writing = true;
    this.update({ saving: true, notice: null, editor: { ...editor, sent: true } });
    try {
      const result = await this.api.saveOutcome(this.callId, { mutationId: editor.mutationId, outcome: editor.outcome, note: editor.note.trim() || null,
        callbackMinutes: editor.outcome === "callback" ? editor.callbackMinutes : null });
      if (!this.live(generation)) return true;
      this.update({ editor: null, notice: { tone: "info", message: result.replayed ? "Tento výsledok už bol uložený." : editor.outcome === "callback"
        ? "Výsledok je uložený a spätné volanie naplánované." : "Výsledok hovoru je uložený." } });
      return true;
    } catch (error) {
      if (!this.live(generation)) return false;
      this.update({ notice: { tone: "error", message: uncertain(error)
        ? "Spojenie sa prerušilo. Výsledok overujeme obnovením; opätovné uloženie rovnakého výsledku sa nezapíše dvakrát."
        : message(error, "Výsledok hovoru sa nepodarilo uložiť.") } });
      return false;
    } finally {
      this.writing = false;
      if (this.live(generation)) { this.update({ saving: false }); void this.refresh(); }
    }
  }
  async link(caseId: string): Promise<boolean> {
    const data = this.state.data;
    if (!this.active || this.writing || !data || this.state.linking || this.state.saving) return false;
    const generation = this.generation;
    this.writing = true;
    this.update({ linking: caseId, notice: null });
    try {
      const result = await this.api.linkCase(this.callId, { caseId, expectedCaseId: data.linkedCaseId });
      if (!this.live(generation)) return true;
      this.update({ notice: { tone: "info", message: result.changed ? "Hovor je priradený k prípadu a zapísaný v jeho časovej osi." : "Hovor už bol k tomuto prípadu priradený." } });
      this.onLinked();
      return true;
    } catch (error) {
      if (!this.live(generation)) return false;
      this.update({ notice: { tone: "error", message: uncertain(error) ? "Spojenie sa prerušilo. Priradenie overujeme obnovením detailu." : message(error, "Hovor sa nepodarilo priradiť.") } });
      if (uncertain(error) || error instanceof MobileApiError && error.status === 409) this.onLinked();
      return false;
    } finally {
      this.writing = false;
      if (this.live(generation)) { this.update({ linking: null }); void this.refresh(); }
    }
  }
  dispose() { this.setActive(false); this.disposed = true; this.listeners.clear(); }
}
