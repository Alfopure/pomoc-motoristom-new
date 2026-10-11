import type { MobileCaseCreated, MobileCaseCreateInput } from "../../../src/lib/mobile-api";
import { MobileApiError } from "../lib/api";
import type { CasesApi } from "./api";

export type DraftState = { input: MobileCaseCreateInput; status: "editing" | "saving" | "uncertain" | "saved";
  error: string | null; created: MobileCaseCreated | null; reviewAfter: number; reviewedList: boolean };

/** A create request has no automatic retry. The draft outlives navigation;
 * only a verified POST result can replace it with the saved case identity. */
export class CaseDraft {
  private state: DraftState = { input: { priority: "normal", jobTypes: [] }, status: "editing", error: null, created: null, reviewAfter: 0, reviewedList: false };
  private listeners = new Set<() => void>();
  private disposed = false;
  constructor(private api: Pick<CasesApi, "create">) {}
  snapshot = () => this.state;
  subscribe = (callback: () => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; };
  private update(change: Partial<DraftState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...change }; for (const notify of this.listeners) notify();
  }
  edit(change: Partial<MobileCaseCreateInput>) {
    if (this.state.status === "saving" || this.state.status === "saved") return;
    this.update({ input: { ...this.state.input, ...change } });
  }
  reviewList(requestedAt: number) {
    if (this.state.status === "uncertain" && !this.state.reviewedList && requestedAt > this.state.reviewAfter) this.update({ reviewedList: true });
  }
  allowRetry() {
    if (this.state.status === "uncertain" && this.state.reviewedList) this.update({ status: "editing", error: null });
  }
  async submit() {
    if (this.disposed || this.state.status !== "editing") return;
    const input = { ...this.state.input, jobTypes: [...(this.state.input.jobTypes ?? [])] };
    this.update({ status: "saving", error: null, reviewAfter: 0, reviewedList: false });
    try {
      const created = await this.api.create(input);
      if (this.disposed) return;
      this.update({ status: "saved", created });
      return created;
    } catch (error) {
      const uncertain = !(error instanceof MobileApiError) || error.status === 0 || error.status === 408 || error.status >= 500;
      this.update({ status: uncertain ? "uncertain" : "editing", reviewAfter: uncertain ? Date.now() : 0, error: uncertain
        ? "Uloženie sa nepodarilo potvrdiť. Prípad už môže existovať. Najprv skontrolujte obnovený zoznam, aby nevznikol dvakrát."
        : error.message });
    }
  }
  newDraft() {
    if (this.state.status !== "saved") return;
    this.update({ input: { priority: "normal", jobTypes: [] }, status: "editing", error: null, created: null, reviewAfter: 0, reviewedList: false });
  }
  dispose() { this.disposed = true; this.listeners.clear(); }
}
