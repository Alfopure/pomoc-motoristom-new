import type { MobileTaskCreated, MobileTaskCreateInput, MobileTaskMessages } from "../../../src/lib/mobile-api";
import { MobileApiError } from "../lib/api";
import { DraftNotSentError, draftKeys, draftObject, type DraftPort, type DraftWrite } from "../drafts/port";
import { cloneDraft, commandProjection, taskCreated, taskCreateInput, type CommandCodec, type CommandProjection } from "./draft-codecs";
import type { WorkApi } from "./api";
export type CommandState<R> = { status: "editing" | "saving" | "uncertain" | "saved"; error: string | null; receipt: R | null };
const unknownResult = (error: unknown) => !(error instanceof MobileApiError) || [0, 408, 429].includes(error.status) || error.status >= 500;
const localReceiptError = "Zápis je potvrdený, ale miestne uloženie potvrdenia zlyhalo. Pred ďalším zápisom opravte uloženie konceptov.";
async function finish(write: DraftWrite | undefined, payload: object) {
  try { return write ? await write.finish(payload) : true; } catch { return false; }
}

/** Workflow/messages preserve the exact command; a later denial is not proof of absence. */
export class TaskCommand<I extends object, R> {
  private state: CommandState<R> = { status: "editing", error: null, receipt: null };
  private pending: Readonly<I> | null = null;
  private listeners = new Set<() => void>();
  private disposed = false;
  private rejected = false;
  constructor(private send: (input: I) => Promise<R>, private durable?: { port: DraftPort; codec: CommandCodec<I, R> }) {
    const value = durable?.port.load();
    if (durable && value !== null) {
      try {
        const saved = commandProjection(value, durable.codec);
        if (saved.receipt && !durable.port.acceptsScope(saved.receipt)) throw new Error();
        this.pending = saved.pending ? Object.freeze(saved.pending) : null;
        const status = saved.status === "saving" ? "uncertain" : saved.status;
        this.state = { status, receipt: saved.receipt, error: status === "uncertain" ? "Obnovená požiadavka nemá potvrdený výsledok. Overte pôvodný zápis." : null };
      } catch { this.rejected = true; durable.port.reject(); this.state.error = "Uložený koncept úlohy sa nepodarilo overiť."; }
    }
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  exportDraft(): CommandProjection<I, R> { return cloneDraft({ version: 1, status: this.state.status, pending: this.pending as I | null, receipt: this.state.receipt }); }
  private update(change: Partial<CommandState<R>>, persist = true) {
    if (this.disposed) return;
    this.state = { ...this.state, ...change };
    if (persist && !this.rejected) this.durable?.port.changed(this.exportDraft());
    for (const notify of this.listeners) notify();
  }
  async submit(input: I) {
    if (this.disposed || this.rejected || this.state.status !== "editing") return;
    try { this.pending = Object.freeze(this.durable ? this.durable.codec.input(input) : { ...input }); }
    catch { this.update({ error: "Požiadavku sa nepodarilo pripraviť." }, false); return; }
    return this.run(false);
  }
  async reconcile() { if (!this.disposed && !this.rejected && this.state.status === "uncertain") return this.run(true); }
  private async run(reconciling: boolean) {
    if (!this.pending) return;
    const pending = { ...this.pending }, port = this.durable?.port;
    this.update({ status: "saving", error: null }, false);
    let write: DraftWrite | undefined;
    try {
      if (port) {
        try { write = await port.prepare(this.exportDraft()); } catch (error) { throw error instanceof DraftNotSentError ? error : new DraftNotSentError(); }
        if (this.disposed || !port.current()) throw new DraftNotSentError();
      }
      const received = await this.send(pending);
      const receipt = this.durable ? this.durable.codec.receipt(received, pending) : received;
      if (this.durable && !this.durable.port.acceptsScope(receipt)) throw new MobileApiError("Potvrdenie sa nepodarilo overiť.", 502);
      const persisted = await finish(write, { version: 1, status: "saved", pending, receipt });
      if (this.disposed) return;
      this.update({ status: "saved", receipt, error: persisted ? null : localReceiptError }, false); return receipt;
    } catch (error) {
      const uncertain = reconciling || !(error instanceof DraftNotSentError) && unknownResult(error);
      const outcome = { version: 1, status: uncertain ? "uncertain" : "editing", pending: uncertain ? pending : null, receipt: null };
      await finish(write, outcome);
      if (this.disposed) return;
      this.pending = uncertain ? Object.freeze(pending) : null;
      this.update({ status: uncertain ? "uncertain" : "editing", error: uncertain ? "Výsledok nie je potvrdený. Overte pôvodnú požiadavku; nový zápis je uzamknutý." : (error as Error).message }, !write);
    }
  }
  reset() {
    if (!this.disposed && !this.rejected && this.state.status === "saved" && (!this.durable || this.durable.port.settled())) {
      this.pending = null; this.update({ status: "editing", error: null, receipt: null }); return true;
    }
    return false;
  }
  dispose() { this.disposed = true; this.pending = null; this.listeners.clear(); }
}

type CreateState = CommandState<MobileTaskCreated> & { input: MobileTaskCreateInput; reviewAfter: number; reviewed: boolean };
const createInput = (): MobileTaskCreateInput => ({ title: "", priority: "normal", kind: "other", assignedTo: null, dueAt: null });
export class TaskCreateDraft {
  private state: CreateState = { input: createInput(), status: "editing", error: null, receipt: null, reviewAfter: 0, reviewed: false };
  private pending: MobileTaskCreateInput | null = null;
  private listeners = new Set<() => void>();
  private disposed = false;
  private rejected = false;
  constructor(private api: Pick<WorkApi, "createTask">, private caseId: string, private port?: DraftPort) {
    const value = port?.load();
    if (port && value !== null) {
      try {
        const v = draftObject(value); draftKeys(v, ["version", "caseId", "input", "status", "pending", "receipt"]);
        if (v.version !== 1 || v.caseId !== caseId || !["editing", "saving", "uncertain", "saved"].includes(v.status as string)) throw new Error();
        const input = taskCreateInput(v.input), pending = v.pending === null ? null : taskCreateInput(v.pending, true);
        if ((v.status === "editing") !== (pending === null) || (v.status === "saved") !== (v.receipt !== null)) throw new Error();
        const receipt = v.status === "saved" ? taskCreated(v.receipt, caseId) : null;
        if (receipt && !port.acceptsScope(receipt)) throw new Error();
        const status = v.status === "saving" ? "uncertain" : v.status as CreateState["status"];
        this.pending = pending;
        this.state = { input, status, receipt, reviewed: false, reviewAfter: Date.now(), error: status === "uncertain" ? "Úloha už môže existovať. Obnovte zoznam úloh tohto prípadu a skontrolujte výsledok." : null };
      } catch { this.rejected = true; port.reject(); this.state.error = "Uložený koncept úlohy sa nepodarilo overiť."; }
    }
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  exportDraft() { return cloneDraft({ version: 1, caseId: this.caseId, input: this.state.input, status: this.state.status, pending: this.pending, receipt: this.state.receipt }); }
  private update(change: Partial<CreateState>, persist = true) { if (this.disposed) return; this.state = { ...this.state, ...change }; if (persist && !this.rejected) this.port?.changed(this.exportDraft()); for (const notify of this.listeners) notify(); }
  edit(change: Partial<MobileTaskCreateInput>) { if (!this.rejected && this.state.status === "editing") this.update({ input: { ...this.state.input, ...change } }); }
  review(requestedAt: number) { if (this.state.status === "uncertain" && requestedAt > this.state.reviewAfter && !this.state.reviewed) this.update({ reviewed: true }, false); }
  allowRetry() { if (!this.rejected && this.state.status === "uncertain" && this.state.reviewed) { this.pending = null; this.update({ status: "editing", error: null }); } }
  reset() { if (!this.rejected && this.state.status === "saved" && (!this.port || this.port.settled())) { this.pending = null; this.update({ input: createInput(), status: "editing", error: null, receipt: null, reviewed: false, reviewAfter: 0 }); } }
  async submit() {
    if (this.disposed || this.rejected || this.state.status !== "editing") return;
    if (!this.state.input.title.trim() || this.state.input.title.length > 500) { this.update({ error: "Doplňte názov úlohy (najviac 500 znakov)." }); return; }
    let input: MobileTaskCreateInput;
    try { input = taskCreateInput({ ...this.state.input, title: this.state.input.title.trim(), dueAt: parseDueAt(this.state.input.dueAt) }, true); }
    catch (error) { this.update({ error: (error as Error).message }); return; }
    this.pending = input;
    this.update({ status: "saving", error: null, reviewed: false }, false);
    let write: DraftWrite | undefined;
    try {
      if (this.port) {
        try { write = await this.port.prepare(this.exportDraft()); } catch (error) { throw error instanceof DraftNotSentError ? error : new DraftNotSentError(); }
        if (this.disposed || !this.port.current()) throw new DraftNotSentError();
      }
      const received = await this.api.createTask(this.caseId, input);
      const receipt = this.port ? taskCreated(received, this.caseId) : received;
      if (this.port && !this.port.acceptsScope(receipt)) throw new MobileApiError("Potvrdenie sa nepodarilo overiť.", 502);
      const persisted = await finish(write, { ...this.exportDraft(), status: "saved", pending: input, receipt });
      if (this.disposed) return;
      this.update({ status: "saved", receipt, error: persisted ? null : localReceiptError }, false); return receipt;
    } catch (error) {
      const uncertain = !(error instanceof DraftNotSentError) && unknownResult(error);
      await finish(write, { ...this.exportDraft(), status: uncertain ? "uncertain" : "editing", pending: uncertain ? input : null, receipt: null });
      if (this.disposed) return;
      this.pending = uncertain ? input : null;
      this.update({ status: uncertain ? "uncertain" : "editing", reviewAfter: uncertain ? Date.now() : 0,
        error: uncertain ? "Úloha už môže existovať. Najprv obnovte zoznam úloh tohto prípadu a skontrolujte výsledok." : (error as Error).message }, !write);
    }
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
