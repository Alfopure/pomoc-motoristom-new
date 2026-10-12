import type { MobileCaseDetailData, MobileCaseUpdateInput, MobileCaseUpdated } from "../../../src/lib/mobile-api";
import { MobileApiError } from "../lib/api";
import type { CasesApi } from "./api";
import { DraftNotSentError, draftDate, draftId, draftKeys, draftObject, draftText, type DraftPort, type DraftWrite } from "../drafts/port";
import { caseUpdateCommand, caseUpdatedDraft, copyCaseDraft, editableDraft } from "./draft-codecs";

type Editable = MobileCaseDetailData["editable"];
export type EditState = { base: MobileCaseDetailData; input: Editable; status: "editing" | "saving" | "uncertain" | "conflict" | "blocked" | "committed" | "saved";
  error: string | null; receipt: MobileCaseUpdated | null; latest: MobileCaseDetailData | null; refreshing: boolean; canRecover: boolean };
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
  private rejected = false;
  constructor(private api: Pick<CasesApi, "update" | "detail">, source: MobileCaseDetailData, private uuid: () => string, private port?: DraftPort) {
    this.state = { base: source, input: { ...source.editable, jobTypes: [...source.editable.jobTypes] }, status: "editing", error: null, receipt: null, latest: null, refreshing: false, canRecover: false };
    const saved = port?.load();
    if (port && saved !== null) {
      try {
        const v = draftObject(saved); draftKeys(v, ["version", "base", "input", "status", "pending", "receipt", "canRecover"]);
        const b = draftObject(v.base); draftKeys(b, ["id", "caseNumber", "updatedAt", "editable"]);
        if (v.version !== 1 || b.id !== source.id || !draftId(b.id) || !draftText(b.caseNumber, 160) || !b.caseNumber || !draftDate(b.updatedAt)
          || !["editing", "saving", "uncertain", "conflict", "blocked", "committed", "saved"].includes(v.status as string) || typeof v.canRecover !== "boolean") throw new Error();
        const base = { ...source, id: b.id, caseNumber: b.caseNumber, updatedAt: b.updatedAt, editable: editableDraft(b.editable) }, input = editableDraft(v.input);
        this.pending = v.pending === null ? null : caseUpdateCommand(v.pending, base);
        if (this.pending) {
          const { mutationId: _id, expectedUpdatedAt: _revision, ...fields } = this.pending;
          const changes = changedFields(base.editable, input);
          // Key ordering is not command identity; compare each field.
          if (Object.keys(fields).length !== Object.keys(changes).length
            || Object.entries(fields).some(([key, value]) => JSON.stringify(value) !== JSON.stringify(changes[key as keyof Editable]))) throw new Error();
        }
        const receipt = v.receipt === null ? null : caseUpdatedDraft(v.receipt, source.id, this.pending, port);
        let status = (v.status === "saving" ? "uncertain" : v.status) as EditState["status"];
        if (["saving", "uncertain", "blocked", "committed", "saved"].includes(v.status as string) && !this.pending
          || ["committed", "saved"].includes(status) !== !!receipt || ["editing", "conflict"].includes(status) && !!this.pending
          || receipt && revisionBefore(receipt.committedRevision, base.updatedAt)) throw new Error();
        let latest: MobileCaseDetailData | null = null;
        if (["editing", "conflict", "blocked"].includes(status) && source.updatedAt !== base.updatedAt) { if (status === "editing") status = "conflict"; latest = source; }
        if (status === "saved" && receipt && revisionBefore(source.updatedAt, receipt.committedRevision)) status = "committed";
        this.state = { ...this.state, base, input, status, receipt, latest, canRecover: v.canRecover,
          error: status === "uncertain" ? "Obnovený zápis ešte nie je potvrdený. Overte iba pôvodnú požiadavku." : status === "conflict" ? "Prípad sa od uloženia konceptu zmenil. Porovnajte aktuálne údaje." : null };
      } catch { this.rejected = true; this.pending = null; port.reject(); this.state.error = "Uložené úpravy sa nepodarilo overiť. Najprv vedome zahoďte tento koncept."; }
    }
  }
  snapshot = () => this.state;
  subscribe = (callback: () => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; };
  exportDraft(change: Partial<EditState> = {}) {
    const state = { ...this.state, ...change };
    return copyCaseDraft({ version: 1, base: { id: state.base.id, caseNumber: state.base.caseNumber, updatedAt: state.base.updatedAt, editable: state.base.editable },
      input: state.input, status: state.status, pending: this.pending, receipt: state.receipt, canRecover: state.canRecover });
  }
  private update(change: Partial<EditState>, persist = true) { if (!this.disposed) { this.state = { ...this.state, ...change }; if (persist && !this.rejected) this.port?.changed(this.exportDraft()); for (const notify of this.listeners) notify(); } }
  edit(change: Partial<Editable>) {
    if (this.disposed || this.rejected || this.state.status !== "editing") return;
    this.update({ input: { ...this.state.input, ...change }, error: null });
  }
  async save() {
    if (this.disposed || this.rejected || !["editing", "uncertain"].includes(this.state.status)) return;
    if (!this.pending) {
      const changes = changedFields(this.state.base.editable, this.state.input);
      if (!Object.keys(changes).length) return;
      if (changes.status !== undefined && !writableStatuses.includes(changes.status)) { this.update({ error: "Vyberte podporovaný stav prípadu." }); return; }
      try {
        this.pending = Object.freeze({ ...changes, ...(changes.jobTypes ? { jobTypes: [...changes.jobTypes] } : {}), expectedUpdatedAt: this.state.base.updatedAt, mutationId: this.uuid() }) as MobileCaseUpdateInput;
      } catch { this.update({ error: "Požiadavku sa nepodarilo pripraviť. Skúste znova." }); return; }
    }
    const reconciling = this.state.status === "uncertain";
    const input = this.pending;
    this.update({ status: "saving", error: null }, false);
    let write: DraftWrite | undefined;
    try {
      if (this.port) write = await this.port.prepare(this.exportDraft());
      if (this.disposed || this.port && !this.port.current()) throw new DraftNotSentError();
      const result = await this.api.update(this.state.base.id, input);
      const receipt = this.port ? caseUpdatedDraft(result, this.state.base.id, input, this.port) : result;
      if (revisionBefore(receipt.committedRevision, input.expectedUpdatedAt)) throw new MobileApiError("Server nepotvrdil platnú revíziu uloženia.", 502);
      const local = await write?.finish(this.exportDraft({ status: "committed", receipt }));
      if (this.disposed) return;
      this.update({ status: "committed", receipt, error: local === false ? "Prípad je uložený. Miestny záznam výsledku ešte čaká na uloženie." : null }, false);
    } catch (error) {
      let change: Partial<EditState>;
      if (error instanceof DraftNotSentError) {
        if (!reconciling) this.pending = null;
        change = { status: reconciling ? "uncertain" : "editing", error: error.message };
      } else if (reconciling || !(error instanceof MobileApiError) || [0, 408, 429].includes(error.status) || error.status >= 500) {
        change = { status: "uncertain", error: "Výsledok uloženia nie je potvrdený. Údaje sú uzamknuté; overiť môžete iba tú istú požiadavku." };
      } else if (error.status === 409 && error.code === "CASE_REVISION_CONFLICT") {
        this.pending = null; change = { status: "conflict", error: "Prípad medzitým zmenil kolega. Vaše úpravy zostali zachované. Načítajte aktuálne údaje a porovnajte ich." };
      } else if ([401, 403, 404, 409].includes(error.status) || error.code === "CASE_MUTATION_MISMATCH") {
        change = { status: "blocked", error: error.message, canRecover: [401, 403, 404].includes(error.status) && !["environment_mismatch", "CASE_MUTATION_MISMATCH"].includes(error.code ?? "") };
      } else { this.pending = null; change = { status: "editing", error: error.message }; }
      if (write) await write.finish(this.exportDraft(change)); else this.port?.changed(this.exportDraft(change));
      this.update(change, false);
    }
  }
  async refresh() {
    if (this.disposed || !this.active || this.read || (!["conflict", "committed"].includes(this.state.status) && !(this.state.status === "blocked" && this.state.canRecover))) return;
    const phase = this.state.status;
    const read = new AbortController(); this.read = read; this.update({ refreshing: true, error: null, latest: null });
    try {
      const result = await this.api.detail(this.state.base.id, read.signal);
      if (this.disposed || read.signal.aborted || this.state.status !== phase) return;
      if (phase === "committed" && this.state.receipt && revisionBefore(result.case.updatedAt, this.state.receipt.committedRevision)) {
        throw new MobileApiError("Detail ešte nezobrazuje potvrdenú revíziu. Obnovte uložený detail.", 502);
      }
      if (phase === "conflict" || phase === "blocked") this.update({ latest: result.case });
      else this.update({ status: "saved" });
    } catch (error) {
      if (!this.disposed && !read.signal.aborted) this.update({ error: error instanceof MobileApiError ? error.message : "Aktuálne údaje sa nepodarilo načítať." });
    } finally { if (this.read === read) { this.read = null; this.update({ refreshing: false }); } }
  }
  rebase() {
    if (this.disposed || this.rejected || this.read || this.port && !this.port.settled() || (this.state.status !== "conflict" && !(this.state.status === "blocked" && this.state.canRecover)) || !this.state.latest) return;
    const changes = changedFields(this.state.base.editable, this.state.input), latest = this.state.latest;
    this.pending = null;
    this.update({ base: latest, input: { ...latest.editable, ...changes }, latest: null, status: "editing", error: null, canRecover: false });
  }
  reload() {
    if (this.disposed || this.rejected || this.read || this.port && !this.port.settled() || (this.state.status !== "conflict" && !(this.state.status === "blocked" && this.state.canRecover)) || !this.state.latest) return;
    const latest = this.state.latest;
    this.pending = null;
    this.update({ base: latest, input: { ...latest.editable, jobTypes: [...latest.editable.jobTypes] }, latest: null, status: "editing", error: null, canRecover: false });
  }
  setActive(active: boolean) { this.active = active; if (!active && this.read) { this.read.abort(); this.read = null; this.update({ refreshing: false }); } }
  newEdit(source: MobileCaseDetailData) {
    if (this.disposed || this.rejected || this.state.status !== "saved" || source.id !== this.state.base.id || this.port && !this.port.settled()
      || this.state.receipt && revisionBefore(source.updatedAt, this.state.receipt.committedRevision)) return;
    this.pending = null;
    this.update({ base: source, input: { ...source.editable, jobTypes: [...source.editable.jobTypes] }, status: "editing", receipt: null, latest: null, error: null, canRecover: false });
  }
  observeFreshSource(source: MobileCaseDetailData) {
    if (this.disposed || this.rejected || source.id !== this.state.base.id || this.state.status === "saving" || this.state.status === "uncertain") return;
    if (revisionBefore(source.updatedAt, this.state.base.updatedAt)) throw new MobileApiError("Aktuálny detail ešte nezobrazuje revíziu rozpracovaných úprav. Skúste obnovu znova.", 502);
    if (this.state.status === "editing" && source.updatedAt !== this.state.base.updatedAt) this.update({ status: "conflict", latest: source, error: "Prípad sa od rozpracovania zmenil. Porovnajte aktuálne údaje pred uložením." });
    else if (this.state.status === "conflict" || this.state.status === "blocked" && this.state.canRecover) this.update({ latest: source });
  }
  dispose() { this.disposed = true; this.read?.abort(); this.read = null; this.listeners.clear(); }
}
