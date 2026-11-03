import type { MobileCaseOwnerAssigned, MobileCaseOwnerContext, MobileCaseOwnerInput } from "../../../src/lib/mobile-api";
import type { CasesApi } from "./api";
import { DraftNotSentError, draftDate, draftId, draftKeys, draftObject, type DraftPort, type DraftWrite } from "../drafts/port";
import { MobileApiError } from "../lib/api";
import { compareRevisions, freezeCommand } from "./location";

type Baseline = { revision: string; owner: MobileCaseOwnerContext["owner"] };
type OwnerState = { status: "editing" | "saving" | "uncertain" | "conflict" | "blocked" | "saved"; selectedId: string | null;
  baseline: Baseline | null; context: MobileCaseOwnerContext | null; receipt: MobileCaseOwnerAssigned | null; refreshing: boolean; canRecover: boolean; error: string | null };
function command(value: unknown): MobileCaseOwnerInput {
  const v = draftObject(value); draftKeys(v, ["mutationId", "expectedUpdatedAt", "ownerId"]);
  if (!draftId(v.mutationId) || !draftId(v.ownerId) || !draftDate(v.expectedUpdatedAt)) throw new Error("Invalid owner command");
  return freezeCommand({ mutationId: v.mutationId, expectedUpdatedAt: v.expectedUpdatedAt, ownerId: v.ownerId });
}
function verifiedReceipt(value: unknown, caseId: string, pending: MobileCaseOwnerInput, port?: DraftPort): MobileCaseOwnerAssigned {
  const v = draftObject(value); draftKeys(v, ["ok", "apiVersion", "environment", "profileId", "checkedAt", "caseId", "mutationId", "ownerId", "committedRevision", "refreshRequired"]);
  if (v.ok !== true || v.apiVersion !== 1 || !["test", "production"].includes(v.environment as string) || !draftId(v.profileId) || !draftDate(v.checkedAt) || port && !port.acceptsScope(v) || v.caseId !== caseId || v.mutationId !== pending.mutationId || v.ownerId !== pending.ownerId
    || !draftDate(v.committedRevision) || compareRevisions(v.committedRevision, pending.expectedUpdatedAt) < 0 || v.refreshRequired !== true) throw new MobileApiError("Priradenie nebolo platne potvrdené.", 502);
  return JSON.parse(JSON.stringify(v)) as MobileCaseOwnerAssigned;
}
export class CaseOwnerDraft {
  private state: OwnerState = { status: "editing", selectedId: null, baseline: null, context: null, receipt: null, refreshing: false, canRecover: false, error: null };
  private pending: MobileCaseOwnerInput | null = null;
  private listeners = new Set<() => void>();
  private active = true;
  private disposed = false;
  private rejected = false;
  private read: AbortController | null = null;
  constructor(private api: Pick<CasesApi, "ownerContext" | "assignOwner">, readonly caseId: string, private uuid: () => string, private port?: DraftPort) {
    const saved = port?.load();
    if (port && saved !== null) try {
      const v = draftObject(saved); draftKeys(v, ["version", "caseId", "status", "selectedId", "baseline", "pending", "receipt", "canRecover"]);
      if (typeof v.canRecover !== "boolean" || v.version !== 1 || v.caseId !== caseId || !draftId(caseId) || !["editing", "saving", "uncertain", "conflict", "blocked", "saved"].includes(v.status as string)
        || !(v.selectedId === null || draftId(v.selectedId))) throw new Error();
      let baseline: Baseline | null = null;
      if (v.baseline !== null) { const b = draftObject(v.baseline), owner = draftObject(b.owner); draftKeys(b, ["revision", "owner"]); draftKeys(owner, ["id", "name", "mine"]);
        if (!draftDate(b.revision) || !(owner.id === null || draftId(owner.id)) || !(owner.name === null || typeof owner.name === "string" && owner.name.length <= 320) || typeof owner.mine !== "boolean") throw new Error();
        baseline = { revision: b.revision, owner: owner as Baseline["owner"] }; }
      this.pending = v.pending === null ? null : command(v.pending);
      if ((["saving", "uncertain", "blocked", "saved"].includes(v.status as string)) !== !!this.pending
        || this.pending && (!baseline || this.pending.ownerId !== v.selectedId || this.pending.expectedUpdatedAt !== baseline.revision)
        || (v.status === "saved") !== (v.receipt !== null)) throw new Error();
      const receipt = v.receipt === null ? null : verifiedReceipt(v.receipt, caseId, this.pending!, port);
      const status = v.status === "saving" ? "uncertain" : v.status === "editing" && v.selectedId ? "conflict" : v.status as OwnerState["status"];
      this.state = { ...this.state, status, canRecover: v.canRecover, selectedId: v.selectedId as string | null, baseline, receipt,
        error: status === "uncertain" ? "Pôvodné priradenie ešte nie je potvrdené. Overte iba tú istú požiadavku." : status === "conflict" ? "Pred pokračovaním obnovte a porovnajte priradenie." : null };
    } catch { this.rejected = true; this.pending = null; port.reject(); this.state.error = "Uložené priradenie sa nepodarilo overiť. Vedome zahoďte tento koncept."; }
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  exportDraft(change: Partial<OwnerState> = {}) {
    const state = { ...this.state, ...change };
    return JSON.parse(JSON.stringify({ version: 1, caseId: this.caseId, status: state.status, selectedId: state.selectedId, baseline: state.baseline, pending: this.pending, receipt: state.receipt, canRecover: state.canRecover }));
  }
  private update(change: Partial<OwnerState>, persist = true) {
    if (this.disposed) return;
    this.state = { ...this.state, ...change };
    if (persist && !this.rejected) this.port?.changed(this.exportDraft());
    this.listeners.forEach(listener => listener());
  }
  private eligible(id: string, context = this.state.context) {
    return context?.available && context.targets.some(target => target.id === id)
      && (context.capabilities.assign || context.capabilities.take && id === context.profileId);
  }
  select(id: string) {
    if (this.disposed || this.rejected || this.state.status !== "editing" || this.state.refreshing || !this.eligible(id)) return;
    this.update({ selectedId: id, baseline: { revision: this.state.context!.caseRevision, owner: this.state.context!.owner }, error: null });
  }
  async refresh() {
    if (this.disposed || this.rejected || !this.active || this.read || this.state.status === "saving") return;
    const read = new AbortController(); this.read = read; this.update({ refreshing: true, context: null }, false);
    try {
      const context = await this.api.ownerContext(this.caseId, read.signal);
      if (read.signal.aborted || this.disposed || this.read !== read) return;
      if (this.state.receipt && compareRevisions(context.caseRevision, this.state.receipt.committedRevision) < 0) throw new MobileApiError("Detail ešte nezobrazuje potvrdené priradenie.", 502);
      const conflict = this.state.status === "editing" && this.state.selectedId && this.state.baseline?.revision !== context.caseRevision;
      this.update({ context, ...(conflict ? { status: "conflict" as const } : {}), error: null });
    } catch (error) { if (!read.signal.aborted && !this.disposed) this.update({ context: null, error: error instanceof Error ? error.message : "Priradenie sa nepodarilo načítať." }, false); }
    finally { if (this.read === read) { this.read = null; this.update({ refreshing: false }, false); } }
  }
  review() {
    if (this.disposed || this.rejected || this.read || !(this.state.status === "conflict" || this.state.status === "blocked" && this.state.canRecover) || !this.state.context || this.port && !this.port.settled()) return;
    this.pending = null;
    this.update({ status: "editing", canRecover: false, baseline: null, selectedId: this.state.selectedId && this.eligible(this.state.selectedId) ? this.state.selectedId : null, error: null });
    if (this.state.selectedId) this.select(this.state.selectedId);
  }
  reset() {
    if (this.disposed || this.rejected || this.read || !["saved", "conflict"].includes(this.state.status) || this.port && !this.port.settled()) return;
    this.pending = null; this.update({ status: "editing", selectedId: null, baseline: null, context: null, receipt: null, error: null });
  }
  submit() { return this.state.status === "editing" ? this.send(false) : Promise.resolve(); }
  reconcile() { return this.state.status === "uncertain" ? this.send(true) : Promise.resolve(); }
  private async send(reconciling: boolean) {
    if (this.disposed || this.rejected || !this.active) return;
    if (!reconciling) {
      if (this.read || !this.state.selectedId || !this.state.baseline || !this.eligible(this.state.selectedId)) return;
      this.pending = command({ mutationId: this.uuid(), expectedUpdatedAt: this.state.baseline.revision, ownerId: this.state.selectedId });
    }
    if (!this.pending) return;
    const input = this.pending; this.update({ status: "saving", error: null }, false);
    let write: DraftWrite | undefined;
    try {
      if (this.port) { try { write = await this.port.prepare(this.exportDraft()); } catch { throw new DraftNotSentError(); } }
      if (this.disposed || this.port && !this.port.current()) throw new DraftNotSentError();
      const receipt = verifiedReceipt(await this.api.assignOwner(this.caseId, input), this.caseId, input, this.port);
      const stored = await write?.finish(this.exportDraft({ status: "saved", receipt })).catch(() => false);
      this.update({ status: "saved", receipt, context: null, error: stored === false ? "Priradenie je uložené. Miestne potvrdenie ešte čaká na uloženie." : null }, false);
    } catch (error) {
      let change: Partial<OwnerState>;
      if (error instanceof DraftNotSentError) { if (!reconciling) this.pending = null; change = { status: reconciling ? "uncertain" : "editing", error: error.message }; }
      else if (reconciling || !(error instanceof MobileApiError) || [0, 408, 429].includes(error.status) || error.status >= 500) change = { status: "uncertain", error: "Priradenie ešte nie je potvrdené. Overiť môžete iba pôvodnú požiadavku." };
      else if (error.status === 409 && error.code === "CASE_REVISION_CONFLICT") { this.pending = null; change = { status: "conflict", context: null, error: "Priradenie medzitým zmenil kolega. Obnovte údaje a vedome potvrďte nový výber." }; }
      else change = { status: "blocked", context: null, error: error.message, canRecover: [400, 401, 403, 404].includes(error.status) && !["CASE_MUTATION_MISMATCH", "environment_mismatch"].includes(error.code ?? "") };
      if (write) await write.finish(this.exportDraft(change)).catch(() => false); else this.port?.changed(this.exportDraft(change));
      this.update(change, false);
    }
  }
  setActive(active: boolean) { this.active = active; if (!active && this.read) { this.read.abort(); this.read = null; this.update({ refreshing: false, context: null }, false); } }
  dispose() { this.disposed = true; this.read?.abort(); this.read = null; this.listeners.clear(); }
}
