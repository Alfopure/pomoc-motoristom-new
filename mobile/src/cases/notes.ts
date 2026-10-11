import { randomUUID } from "expo-crypto";
import type { MobileCaseNoteAdded, MobileCaseNoteInput } from "../../../src/lib/mobile-api";
import { MobileApiError } from "../lib/api";
import type { CasesApi } from "./api";

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
  constructor(private api: Pick<CasesApi, "addNote">, private caseId: string, private uuid: () => string = randomUUID) {}
  snapshot = () => this.state;
  subscribe = (callback: () => void) => {
    this.listeners.add(callback);
    return () => { this.listeners.delete(callback); };
  };
  private update(change: Partial<NoteState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...change };
    for (const notify of this.listeners) notify();
  }
  edit(note: string) { if (this.state.status === "editing") this.update({ note }); }
  async submit() {
    if (this.disposed || this.state.status !== "editing" || !this.state.note.trim() || this.state.note.length > 10_000) return;
    try { this.pending = Object.freeze({ mutationId: this.uuid(), note: this.state.note.trim() }); }
    catch { this.update({ error: "Požiadavku sa nepodarilo pripraviť. Skúste znova." }); return; }
    return this.send(false);
  }
  async reconcile() {
    if (this.disposed || this.state.status !== "uncertain" || !this.pending) return;
    return this.send(true);
  }
  async repairAudit() {
    const input = this.pending;
    if (this.disposed || this.state.status !== "saved" || this.state.repairing || !input
      || !this.state.receipt?.warnings.some(warning => warning.code === "case_note_audit_incomplete")) return;
    this.update({ repairing: true, error: null });
    try {
      const receipt = await this.api.addNote(this.caseId, { ...input });
      if (this.disposed) return;
      this.update({ receipt });
      return receipt;
    } catch {
      // Repairing bookkeeping cannot turn a confirmed note into an uncertain write.
      this.update({ error: "Poznámka je uložená, ale audit sa zatiaľ nepodarilo potvrdiť." });
    } finally {
      this.update({ repairing: false });
    }
  }
  private async send(reconciling: boolean) {
    const input = this.pending;
    if (!input) return;
    this.update({ status: "saving", error: null });
    try {
      const receipt = await this.api.addNote(this.caseId, { ...input });
      if (this.disposed) return;
      this.update({ status: "saved", receipt });
      return receipt;
    } catch (error) {
      // Auth or validation rejection of a later retry does not prove that
      // the original timed-out note was never committed.
      const uncertain = reconciling || !(error instanceof MobileApiError) || error.status === 0 || error.status === 408 || error.status >= 500;
      if (!uncertain) this.pending = null;
      this.update({ status: uncertain ? "uncertain" : "editing", error: uncertain
        ? "Poznámka už môže byť uložená. Overte výsledok pred ďalším zápisom." : error.message });
    }
  }
  newNote() {
    if (this.disposed || this.state.status !== "saved" || this.state.repairing) return;
    this.pending = null;
    this.update({ note: "", status: "editing", error: null, receipt: null });
  }
  dispose() { this.disposed = true; this.pending = null; this.listeners.clear(); }
}
