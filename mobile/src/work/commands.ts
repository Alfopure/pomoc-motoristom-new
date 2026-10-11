import type { MobileTaskCreated, MobileTaskCreateInput, MobileTaskMessages } from "../../../src/lib/mobile-api";
import { MobileApiError } from "../lib/api";
import type { WorkApi } from "./api";
export type CommandState<R> = { status: "editing" | "saving" | "uncertain" | "saved"; error: string | null; receipt: R | null };
const unknownResult = (error: unknown) => !(error instanceof MobileApiError) || [0, 408, 429].includes(error.status) || error.status >= 500;

/** Workflow and messages have replayable, flat command DTOs. A later denial
 * cannot prove that an earlier request did not commit. */
export class TaskCommand<I extends object, R> {
  private state: CommandState<R> = { status: "editing", error: null, receipt: null };
  private pending: Readonly<I> | null = null;
  private listeners = new Set<() => void>();
  private disposed = false;
  constructor(private send: (input: I) => Promise<R>) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(change: Partial<CommandState<R>>) { if (this.disposed) return; this.state = { ...this.state, ...change }; for (const notify of this.listeners) notify(); }
  async submit(input: I) {
    if (this.disposed || this.state.status !== "editing") return;
    this.pending = Object.freeze({ ...input }); return this.run(false);
  }
  async reconcile() { if (!this.disposed && this.state.status === "uncertain") return this.run(true); }
  private async run(reconciling: boolean) {
    if (!this.pending) return;
    this.update({ status: "saving", error: null });
    try {
      const receipt = await this.send({ ...this.pending }); if (this.disposed) return;
      this.update({ status: "saved", receipt }); return receipt;
    } catch (error) {
      const uncertain = reconciling || unknownResult(error); if (!uncertain) this.pending = null;
      this.update({ status: uncertain ? "uncertain" : "editing", error: uncertain ? "Výsledok nie je potvrdený. Overte pôvodnú požiadavku; nový zápis je uzamknutý." : (error as MobileApiError).message });
    }
  }
  reset() { if (!this.disposed && this.state.status === "saved") { this.pending = null; this.update({ status: "editing", error: null, receipt: null }); } }
  dispose() { this.disposed = true; this.pending = null; this.listeners.clear(); }
}

type CreateState = CommandState<MobileTaskCreated> & { input: MobileTaskCreateInput; reviewAfter: number; reviewed: boolean };
export class TaskCreateDraft {
  private state: CreateState = { input: { title: "", priority: "normal", kind: "other", assignedTo: null, dueAt: null }, status: "editing", error: null, receipt: null, reviewAfter: 0, reviewed: false };
  private listeners = new Set<() => void>();
  private disposed = false;
  constructor(private api: Pick<WorkApi, "createTask">, private caseId: string) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(change: Partial<CreateState>) { if (this.disposed) return; this.state = { ...this.state, ...change }; for (const notify of this.listeners) notify(); }
  edit(change: Partial<MobileTaskCreateInput>) { if (this.state.status === "editing") this.update({ input: { ...this.state.input, ...change } }); }
  review(requestedAt: number) { if (this.state.status === "uncertain" && requestedAt > this.state.reviewAfter && !this.state.reviewed) this.update({ reviewed: true }); }
  allowRetry() { if (this.state.status === "uncertain" && this.state.reviewed) this.update({ status: "editing", error: null }); }
  async submit() {
    if (this.disposed || this.state.status !== "editing") return;
    if (!this.state.input.title.trim() || this.state.input.title.length > 500) { this.update({ error: "Doplňte názov úlohy (najviac 500 znakov)." }); return; }
    let dueAt: string | null;
    try { dueAt = parseDueAt(this.state.input.dueAt); } catch (error) { this.update({ error: (error as Error).message }); return; }
    const input = { ...this.state.input, title: this.state.input.title.trim(), dueAt };
    this.update({ status: "saving", error: null, reviewed: false });
    try { const receipt = await this.api.createTask(this.caseId, input); if (this.disposed) return; this.update({ status: "saved", receipt }); return receipt; }
    catch (error) { const uncertain = unknownResult(error); this.update({ status: uncertain ? "uncertain" : "editing", reviewAfter: uncertain ? Date.now() : 0,
      error: uncertain ? "Úloha už môže existovať. Najprv obnovte zoznam úloh tohto prípadu a skontrolujte výsledok." : (error as MobileApiError).message }); }
  }
  dispose() { this.disposed = true; this.listeners.clear(); }
}

export function parseDueAt(value?: string | null) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Termín zadajte ako RRRR-MM-DD HH:mm alebo nechajte prázdny.");
  const [, y, m, d, h, min] = match.map(Number), date = new Date(y, m - 1, d, h, min);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d || date.getHours() !== h || date.getMinutes() !== min) throw new Error("Termín nie je platný miestny dátum a čas.");
  return date.toISOString();
}

export function orderedMessages(pages: Pick<MobileTaskMessages, "messages">[]) {
  return [...new Map([...pages].reverse().flatMap(page => page.messages).map(message => [message.id, message])).values()];
}

export function selectedReviewer(selected: string | null | undefined, current: string | null) {
  return selected === undefined ? current : selected;
}
