import type { MobileCaseDetailData, MobileCaseUpdateInput, MobileCaseUpdated } from "../../../src/lib/mobile-api";
import { MobileApiError } from "../lib/api";
import type { CasesApi } from "./api";

type Editable = MobileCaseDetailData["editable"];
export type EditState = { base: MobileCaseDetailData; input: Editable; status: "editing" | "saving" | "uncertain" | "conflict" | "blocked" | "committed" | "saved";
  error: string | null; receipt: MobileCaseUpdated | null; latest: MobileCaseDetailData | null; refreshing: boolean };
const writableStatuses = ["open", "completed_assisted", "completed_no_assistance", "waiting_for_docs", "cancelled", "futile_trip"];
export function changedFields(base: Editable, input: Editable): Partial<Editable> {
  return Object.fromEntries(Object.keys(base).filter(key => JSON.stringify(base[key as keyof Editable]) !== JSON.stringify(input[key as keyof Editable]))
    .map(key => [key, input[key as keyof Editable]]));
}
// Date truncates database microseconds. Compare the remaining fraction too,
// without changing either revision string sent to the mutation endpoint.
function revisionBefore(value: string, minimum: string) {
  const milliseconds = Date.parse(value), baseline = Date.parse(minimum);
  const submillisecond = (revision: string) => Number((revision.match(/[T ]\d{2}:\d{2}:\d{2}\.(\d+)/)?.[1].slice(3) ?? "").padEnd(6, "0").slice(0, 6));
  return milliseconds < baseline || milliseconds === baseline && submillisecond(value) < submillisecond(minimum);
}
export class CaseEdit {
  private state: EditState;
  private listeners = new Set<() => void>();
  private disposed = false;
  private active = true;
  private read: AbortController | null = null;
  private pending: MobileCaseUpdateInput | null = null;
  constructor(private api: Pick<CasesApi, "update" | "detail">, source: MobileCaseDetailData, private uuid: () => string) {
    this.state = { base: source, input: { ...source.editable, jobTypes: [...source.editable.jobTypes] }, status: "editing", error: null, receipt: null, latest: null, refreshing: false };
  }
  snapshot = () => this.state;
  subscribe = (callback: () => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; };
  private update(change: Partial<EditState>) { if (!this.disposed) { this.state = { ...this.state, ...change }; for (const notify of this.listeners) notify(); } }
  edit(change: Partial<Editable>) {
    if (this.disposed || this.state.status !== "editing") return;
    this.update({ input: { ...this.state.input, ...change }, error: null });
  }
  async save() {
    if (this.disposed || !["editing", "uncertain"].includes(this.state.status)) return;
    if (!this.pending) {
      const changes = changedFields(this.state.base.editable, this.state.input);
      if (!Object.keys(changes).length) return;
      if (changes.status !== undefined && !writableStatuses.includes(changes.status)) { this.update({ error: "Vyberte podporovaný stav prípadu." }); return; }
      try {
        this.pending = Object.freeze({ ...changes, ...(changes.jobTypes ? { jobTypes: [...changes.jobTypes] } : {}), expectedUpdatedAt: this.state.base.updatedAt, mutationId: this.uuid() }) as MobileCaseUpdateInput;
      } catch { this.update({ error: "Požiadavku sa nepodarilo pripraviť. Skúste znova." }); return; }
    }
    const reconciling = this.state.status === "uncertain";
    this.update({ status: "saving", error: null });
    try {
      const receipt = await this.api.update(this.state.base.id, this.pending);
      if (this.disposed) return;
      this.pending = null; this.update({ status: "committed", receipt });
    } catch (error) {
      if (this.disposed) return;
      if (error instanceof MobileApiError && error.status === 409 && error.code === "CASE_REVISION_CONFLICT") {
        this.pending = null; this.update({ status: "conflict", error: "Prípad medzitým zmenil kolega. Vaše úpravy zostali zachované. Načítajte aktuálne údaje a porovnajte ich." });
      } else if (reconciling || !(error instanceof MobileApiError) || [0, 408, 429].includes(error.status) || error.status >= 500) {
        this.update({ status: "uncertain", error: "Výsledok uloženia nie je potvrdený. Údaje sú uzamknuté; overiť môžete iba tú istú požiadavku." });
      } else if ([401, 403, 404, 409].includes(error.status) || error.code === "CASE_MUTATION_MISMATCH") {
        this.update({ status: "blocked", error: error.message });
      } else { this.pending = null; this.update({ status: "editing", error: error.message }); }
    }
  }
  async refresh() {
    if (this.disposed || !this.active || this.read || !["conflict", "committed"].includes(this.state.status)) return;
    const phase = this.state.status;
    const read = new AbortController(); this.read = read; this.update({ refreshing: true, error: null });
    try {
      const result = await this.api.detail(this.state.base.id, read.signal);
      if (this.disposed || read.signal.aborted || this.state.status !== phase) return;
      if (phase === "committed" && this.state.receipt && revisionBefore(result.case.updatedAt, this.state.receipt.committedRevision)) {
        throw new MobileApiError("Detail ešte nezobrazuje potvrdenú revíziu. Obnovte uložený detail.", 502);
      }
      if (phase === "conflict") this.update({ latest: result.case });
      else this.update({ base: result.case, input: { ...result.case.editable, jobTypes: [...result.case.editable.jobTypes] }, status: "saved" });
    } catch (error) {
      if (!this.disposed && !read.signal.aborted) this.update({ error: error instanceof MobileApiError ? error.message : "Aktuálne údaje sa nepodarilo načítať." });
    } finally { if (this.read === read) { this.read = null; this.update({ refreshing: false }); } }
  }
  rebase() {
    if (this.disposed || this.read || this.state.status !== "conflict" || !this.state.latest) return;
    const changes = changedFields(this.state.base.editable, this.state.input), latest = this.state.latest;
    this.update({ base: latest, input: { ...latest.editable, ...changes }, latest: null, status: "editing", error: null });
  }
  reload() {
    if (this.disposed || this.read || this.state.status !== "conflict" || !this.state.latest) return;
    const latest = this.state.latest;
    this.update({ base: latest, input: { ...latest.editable, jobTypes: [...latest.editable.jobTypes] }, latest: null, status: "editing", error: null });
  }
  setActive(active: boolean) { this.active = active; if (!active && this.read) { this.read.abort(); this.read = null; this.update({ refreshing: false }); } }
  dispose() { this.disposed = true; this.read?.abort(); this.read = null; this.listeners.clear(); }
}
