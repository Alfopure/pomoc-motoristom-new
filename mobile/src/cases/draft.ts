import type { MobileCaseCreated, MobileCaseCreateInput } from "../../../src/lib/mobile-api";
import { MobileApiError } from "../lib/api";
import type { CasesApi } from "./api";
import { DraftNotSentError, draftKeys, draftObject, type DraftPort, type DraftWrite } from "../drafts/port";
import { freezeCommand, placeSelection } from "./location";
import { caseCreatedDraft, caseDraftInput, copyCaseDraft } from "./draft-codecs";
import { customerCallNumber } from "../call-context/number";

export type DraftState = { input: MobileCaseCreateInput; status: "editing" | "saving" | "uncertain" | "saved";
  error: string | null; created: MobileCaseCreated | null; reviewAfter: number; reviewedList: boolean };

/** A create request has no automatic retry. The draft outlives navigation;
 * only a verified POST result can replace it with the saved case identity. */
export class CaseDraft {
  private state: DraftState = { input: { priority: "normal", jobTypes: [] }, status: "editing", error: null, created: null, reviewAfter: 0, reviewedList: false };
  private listeners = new Set<() => void>();
  private disposed = false;
  private rejected = false;
  private submitted: MobileCaseCreateInput | null = null;
  constructor(private api: Pick<CasesApi, "create">, private port?: DraftPort) {
    const value = port?.load();
    if (port && value !== null) {
      try {
        const v = draftObject(value); draftKeys(v, ["version", "input", "status", "submitted", "created"]);
        if (![1, 2].includes(v.version as number) || !["editing", "saving", "uncertain", "saved"].includes(v.status as string)) throw new Error();
        const input = caseDraftInput(v.input, v.version as number), submitted = v.submitted === null ? null : caseDraftInput(v.submitted, v.version as number);
        if ((v.status === "editing") !== (submitted === null) || (v.status === "saved") !== (v.created !== null)) throw new Error();
        const created = v.status === "saved" ? caseCreatedDraft(v.created, port) : null;
        const status = v.status === "saving" ? "uncertain" : v.status as DraftState["status"];
        this.submitted = submitted;
        this.state = { input, status, created, reviewAfter: Date.now(), reviewedList: false,
          error: status === "uncertain" ? "Prípad už môže existovať. Po obnove skontrolujte čerstvo načítaný zoznam pred ďalším pokusom." : null };
      } catch { this.rejected = true; port.reject(); this.state.error = "Uložený koncept prípadu sa nepodarilo overiť."; }
    }
  }
  exportDraft() { return copyCaseDraft({ version: 2, input: this.state.input, status: this.state.status, submitted: this.submitted, created: this.state.created }); }
  snapshot = () => this.state;
  subscribe = (callback: () => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; };
  private update(change: Partial<DraftState>, persist = true) {
    if (this.disposed) return;
    this.state = { ...this.state, ...change };
    if (persist && !this.rejected) this.port?.changed(this.exportDraft());
    for (const notify of this.listeners) notify();
  }
  edit(change: Partial<MobileCaseCreateInput>) {
    if (this.rejected || this.disposed || this.state.status === "saving" || this.state.status === "saved") return;
    const input = copyCaseDraft({ ...this.state.input, ...change });
    if ("manualPickupAddress" in change) delete input.pickup;
    if ("manualDestinationAddress" in change) delete input.destination;
    this.update({ input });
  }
  canApplyCallPhone() {
    return !this.disposed && !this.rejected && this.state.status === "editing" && (!this.port || this.port.current() && this.port.settled());
  }
  applyCallPhone(value: string, expectedPhone: string) {
    const phone = customerCallNumber("inbound", value);
    if (!phone || !this.canApplyCallPhone() || (this.state.input.contactPhone ?? "") !== expectedPhone) return false;
    this.edit({ contactPhone: phone });
    return true;
  }
  selectPlace(target: "pickup" | "destination", value: unknown) {
    if (this.rejected || this.disposed || this.state.status !== "editing") return;
    const input = copyCaseDraft(this.state.input); input[target] = placeSelection(value);
    delete input[target === "pickup" ? "manualPickupAddress" : "manualDestinationAddress"];
    this.update({ input });
  }
  reviewList(requestedAt: number) {
    if (this.state.status === "uncertain" && !this.state.reviewedList && requestedAt > this.state.reviewAfter) this.update({ reviewedList: true });
  }
  allowRetry() {
    if (!this.disposed && !this.rejected && this.state.status === "uncertain" && this.state.reviewedList && (!this.port || this.port.settled())) { this.submitted = null; this.update({ status: "editing", error: null }); }
  }
  async submit() {
    if (this.disposed || this.rejected || this.state.status !== "editing") return;
    const input = freezeCommand({ ...this.state.input, jobTypes: [...(this.state.input.jobTypes ?? [])] });
    this.submitted = copyCaseDraft(input);
    this.update({ status: "saving", error: null, reviewAfter: 0, reviewedList: false }, false);
    let write: DraftWrite | undefined;
    try {
      if (this.port) {
        try { write = await this.port.prepare(this.exportDraft()); } catch (error) { throw error instanceof DraftNotSentError ? error : new DraftNotSentError(); }
        if (this.disposed || !this.port.current()) throw new DraftNotSentError();
      }
      const result = await this.api.create(input);
      const created = this.port ? caseCreatedDraft(result, this.port) : result;
      const persisted = write ? await write.finish({ ...this.exportDraft(), status: "saved", created }).catch(() => false) : true;
      if (this.disposed) return;
      this.update({ status: "saved", created, error: persisted ? null : "Prípad je uložený, ale miestne potvrdenie sa nepodarilo uložiť. Skúste miestne uloženie znova." }, false);
      return created;
    } catch (error) {
      const uncertain = !(error instanceof DraftNotSentError) && (!(error instanceof MobileApiError) || error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500);
      const outcome = { ...this.exportDraft(), status: uncertain ? "uncertain" : "editing", submitted: uncertain ? this.submitted : null, created: null };
      if (write) await write.finish(outcome).catch(() => false);
      else this.port?.changed(outcome);
      if (this.disposed) return;
      if (!uncertain) this.submitted = null;
      this.update({ status: uncertain ? "uncertain" : "editing", reviewAfter: uncertain ? Date.now() : 0, error: uncertain
        ? "Uloženie sa nepodarilo potvrdiť. Prípad už môže existovať. Najprv skontrolujte obnovený zoznam, aby nevznikol dvakrát."
        : (error as Error).message }, false);
    }
  }
  newDraft() {
    if (this.disposed || this.rejected || this.state.status !== "saved") return;
    if (this.port && !this.port.settled()) { this.update({ error: "Pred novým prípadom opravte miestne uloženie potvrdenia." }, false); return; }
    this.submitted = null;
    this.update({ input: { priority: "normal", jobTypes: [] }, status: "editing", error: null, created: null, reviewAfter: 0, reviewedList: false });
  }
  dispose() { this.disposed = true; this.listeners.clear(); }
}
