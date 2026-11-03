import { randomUUID } from "expo-crypto";
import type { MobileCaseNoteAdded, MobileCaseNoteInput } from "../../../src/lib/mobile-api";
import { MobileApiError } from "../lib/api";
import type { CasesApi } from "./api";
import { DraftNotSentError, draftKeys, draftObject, draftText, type DraftPort, type DraftWrite } from "../drafts/port";
import { copyCaseDraft, noteCommandDraft, noteReceiptDraft } from "./draft-codecs";

export type NoteState = {
  note: string;
  status: "editing" | "saving" | "uncertain" | "saved";
  error: string | null;
  receipt: MobileCaseNoteAdded | null;
  repairing: boolean;
};

export class CaseNoteDraft {
  private state: NoteState = { note: "", status: "editing", error: null, receipt: null, repairing: false };
  private pending: Readonly<MobileCaseNoteInput> | null = null;
  private listeners = new Set<() => void>();
  private disposed = false;
  private rejected = false;
  constructor(private api: Pick<CasesApi, "addNote">, private caseId: string, private uuid: () => string = randomUUID, private port?: DraftPort) {
    const saved = port?.load();
    if (port && saved !== null) {
      try {
        const v = draftObject(saved); draftKeys(v, ["version", "caseId", "note", "status", "pending", "receipt"]);
        if (v.version !== 1 || v.caseId !== caseId || !draftText(v.note, 10000) || !["editing", "saving", "uncertain", "saved"].includes(v.status as string)) throw new Error();
        this.pending = v.pending === null ? null : noteCommandDraft(v.pending);
        const receipt = v.receipt === null ? null : this.pending ? noteReceiptDraft(v.receipt, caseId, this.pending, port) : null;
        if (v.receipt !== null && !receipt || v.status === "editing" && (this.pending || receipt) || v.status !== "editing" && !this.pending
          || v.status === "saved" !== !!receipt || this.pending && this.pending.note !== v.note.trim()) throw new Error();
        this.state = { ...this.state, note: v.note, status: (v.status === "saving" ? "uncertain" : v.status) as NoteState["status"], receipt,
          error: ["saving", "uncertain"].includes(v.status as string) ? "Obnovená poznámka už môže byť uložená. Overte pôvodnú požiadavku." : null };
      } catch { this.rejected = true; this.pending = null; port.reject(); this.state.error = "Uloženú poznámku sa nepodarilo overiť. Najprv vedome zahoďte tento koncept."; }
    }
  }
  snapshot = () => this.state;
  subscribe = (callback: () => void) => {
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  };
  exportDraft(change: Partial<NoteState> = {}) {
    const state = { ...this.state, ...change };
    return copyCaseDraft({ version: 1, caseId: this.caseId, note: state.note, status: state.status, pending: this.pending, receipt: state.receipt });
  }
  private update(change: Partial<NoteState>, persist = true) {
    if (this.disposed) return;
    this.state = { ...this.state, ...change };
    if (persist && !this.rejected) this.port?.changed(this.exportDraft());
    for (const notify of this.listeners) notify();
  }
  edit(note: string) { if (!this.rejected && this.state.status === "editing") this.update({ note }); }
  async submit() {
    if (this.disposed || this.rejected || this.state.status !== "editing" || !this.state.note.trim() || this.state.note.length > 10_000) return;
    try { this.pending = Object.freeze({ mutationId: this.uuid(), note: this.state.note.trim() }); }
    catch { this.update({ error: "Požiadavku sa nepodarilo pripraviť. Skúste znova." }); return; }
    return this.send(false);
  }
  async reconcile() {
    if (this.disposed || this.rejected || this.state.status !== "uncertain" || !this.pending) return;
    return this.send(true);
  }
  async repairAudit() {
    const input = this.pending;
    if (this.disposed || this.state.status !== "saved" || this.state.repairing || !input
      || !this.state.receipt?.warnings.some(warning => warning.code === "case_note_audit_incomplete")) return;
    this.update({ repairing: true, error: null });
    let write: DraftWrite | undefined;
    try {
      if (this.port) write = await this.port.prepare(this.exportDraft());
      if (this.disposed || this.port && !this.port.current()) throw new DraftNotSentError();
      const result = await this.api.addNote(this.caseId, { ...input });
      const receipt = this.port ? noteReceiptDraft(result, this.caseId, input, this.port) : result;
      const local = await write?.finish(this.exportDraft({ receipt })); write = undefined;
      if (this.disposed) return;
      this.update({ receipt, error: local === false ? "Poznámka je uložená. Miestny záznam výsledku čaká na uloženie." : null }, false);
      return receipt;
    } catch {
      await write?.finish(this.exportDraft());
      // Repairing bookkeeping cannot turn a confirmed note into an uncertain write.
      this.update({ error: "Poznámka je uložená, ale audit sa zatiaľ nepodarilo potvrdiť." });
    } finally {
      this.update({ repairing: false });
    }
  }
  private async send(reconciling: boolean) {
    const input = this.pending;
    if (!input) return;
    this.update({ status: "saving", error: null }, false);
    let write: DraftWrite | undefined;
    try {
      if (this.port) write = await this.port.prepare(this.exportDraft());
      if (this.disposed || this.port && !this.port.current()) throw new DraftNotSentError();
      const result = await this.api.addNote(this.caseId, { ...input });
      const receipt = this.port ? noteReceiptDraft(result, this.caseId, input, this.port) : result;
      const local = await write?.finish(this.exportDraft({ status: "saved", receipt }));
      if (this.disposed) return;
      this.update({ status: "saved", receipt, error: local === false ? "Poznámka je uložená. Miestny záznam výsledku čaká na uloženie." : null }, false);
      return receipt;
    } catch (error) {
      // Auth or validation rejection of a later retry does not prove that
      // the original timed-out note was never committed.
      const uncertain = reconciling || !(error instanceof DraftNotSentError) && (!(error instanceof MobileApiError) || [0, 408, 429].includes(error.status) || error.status >= 500);
      if (!uncertain) this.pending = null;
      const change = { status: uncertain ? "uncertain" as const : "editing" as const, error: uncertain
        ? "Poznámka už môže byť uložená. Overte výsledok pred ďalším zápisom." : error instanceof Error ? error.message : "Požiadavka sa neodoslala." };
      if (write) await write.finish(this.exportDraft(change)); else this.port?.changed(this.exportDraft(change));
      this.update(change, false);
    }
  }
  newNote() {
    if (this.disposed || this.rejected || this.state.status !== "saved" || this.state.repairing || this.port && !this.port.settled()) return;
    this.pending = null;
    this.update({ note: "", status: "editing", error: null, receipt: null });
  }
  dispose() { this.disposed = true; this.listeners.clear(); }
}
