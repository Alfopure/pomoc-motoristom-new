import { sameNoteDraft, type NoteColleague, type NoteDraft, type PersonalNote } from "@/domain/notes";
export type NotebookSnapshot = {
  notes: PersonalNote[]; colleagues: NoteColleague[]; drafts: Record<string, NoteDraft>;
  selectedId: string | null; saving: boolean; loading: boolean; hidden: boolean;
  error: string; conflicts: string[];
};
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export class NotebookStore {
  private state: NotebookSnapshot = { notes: [], colleagues: [], drafts: {}, selectedId: null, saving: false, loading: false, hidden: false, error: "", conflicts: [] };
  private listeners = new Set<() => void>();
  private generation = 0;
  private readSequence = 0;
  private disposed = false;
  private savePromise: Promise<boolean> | null = null;
  constructor(private fetcher: Fetcher = (url, init) => fetch(url, init), private featureEnabled = true) {}
  get enabled() { return this.featureEnabled; }
  setEnabled = (enabled: boolean) => {
    if (enabled === this.featureEnabled) return;
    this.featureEnabled = enabled;
    this.clear();
    this.update({ hidden: true });
  };
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<NotebookSnapshot>) { if (this.disposed) return; this.state = { ...this.state, ...patch }; this.listeners.forEach(fn => fn()); }
  clear = () => { this.generation++; this.readSequence++; this.savePromise = null; this.update({ notes: [], colleagues: [], drafts: {}, selectedId: null, saving: false, loading: false, hidden: false, conflicts: [], error: "Prístup k poznámkam treba znovu overiť." }); };
  dispose = () => { this.clear(); this.disposed = true; this.listeners.clear(); };
  /** Hide all previously displayed content before requesting online authorization. */
  reauthorize = () => { this.readSequence++; this.update({ hidden: true }); return this.refresh(); };
  select = (id: string | null) => this.update({ selectedId: id });
  edit = (id: string, patch: Partial<NoteDraft>) => {
    const note = this.state.notes.find(note => note.id === id);
    if (!this.enabled || !note?.canEdit || this.state.hidden) return;
    const draft = { ...(this.state.drafts[id] ?? note), ...patch };
    const drafts = { ...this.state.drafts, [id]: draft };
    if (sameNoteDraft(draft, note)) delete drafts[id];
    this.update({ drafts, error: "" });
  };
  discard = () => this.update({ drafts: {}, conflicts: [], error: "" });
  async refresh() {
    if (this.disposed || !this.enabled) return;
    const generation = this.generation, sequence = ++this.readSequence;
    this.update({ loading: true });
    try {
      const response = await this.fetcher("/api/notes", { cache: "no-store" });
      if (generation !== this.generation || sequence !== this.readSequence || this.disposed) return;
      if (response.status === 401 || response.status === 403) { this.clear(); return; }
      if (!response.ok) throw new Error("Poznámky sa nepodarilo overiť. Neuložené zmeny zostávajú v tomto okne.");
      const payload = await response.json() as { notes: PersonalNote[] };
      if (generation !== this.generation || sequence !== this.readSequence || this.disposed) return;
      const allowed = new Set(payload.notes.map(note => note.id));
      const drafts = Object.fromEntries(Object.entries(this.state.drafts).filter(([id]) => allowed.has(id)));
      const conflicts = payload.notes.filter(note => drafts[note.id] && this.state.notes.find(old => old.id === note.id)?.revision !== note.revision).map(note => note.id);
      // Removed notes and drafts are discarded atomically. New readSequence prevents
      // an older read from restoring revoked content after this authorized response.
      this.update({ notes: payload.notes, drafts, conflicts: [...new Set([...this.state.conflicts.filter(id => allowed.has(id)), ...conflicts])], hidden: false, error: "", selectedId: this.state.selectedId && allowed.has(this.state.selectedId) ? this.state.selectedId : null });
    } catch (error) {
      if (generation === this.generation && sequence === this.readSequence) this.update({ error: error instanceof Error ? error.message : "Poznámky nie sú dostupné." });
    } finally { if (generation === this.generation && sequence === this.readSequence) this.update({ loading: false }); }
  }
  async loadColleagues() {
    if (!this.enabled || this.disposed) return;
    const generation = this.generation;
    try {
      const response = await this.fetcher("/api/notes/colleagues", { cache: "no-store" });
      if (response.status === 401 || response.status === 403) { if (generation === this.generation) this.clear(); return; }
      if (!response.ok) return;
      const payload = await response.json() as { colleagues: NoteColleague[] };
      if (generation === this.generation) this.update({ colleagues: payload.colleagues });
    } catch { /* Notes remain usable when the colleague directory is unavailable. */ }
  }
  async create() {
    if (this.state.saving || this.state.hidden || this.disposed || !this.enabled) return;
    const generation = this.generation;
    this.update({ saving: true, error: "" });
    try {
      const response = await this.fetcher("/api/notes", { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "", body: "", recipientProfileIds: [] }) });
      // A capability/identity change invalidates this mutation before handling
      // authorization failures too: its old 401 must not clear a new draft.
      if (generation !== this.generation || this.disposed) return;
      if (!response.ok) { if (response.status === 401 || response.status === 403) { this.clear(); return; } throw new Error("Novú poznámku sa nepodarilo vytvoriť."); }
      const { note } = await response.json() as { note: PersonalNote };
      if (generation === this.generation) { this.readSequence++; this.update({ notes: [note, ...this.state.notes.filter(item => item.id !== note.id)], selectedId: note.id, loading: false }); }
    } catch (error) { if (generation === this.generation) this.update({ error: error instanceof Error ? error.message : "Poznámku sa nepodarilo vytvoriť." }); }
    finally { if (generation === this.generation) this.update({ saving: false }); }
  }
  save = (): Promise<boolean> => {
    if (this.savePromise) return this.savePromise;
    if (this.state.hidden || this.disposed || this.state.saving || !this.enabled) return Promise.resolve(false);
    const operation = this.saveDrafts();
    this.savePromise = operation;
    void operation.finally(() => { if (this.savePromise === operation) this.savePromise = null; });
    return operation;
  };
  private async saveDrafts(): Promise<boolean> {
    const generation = this.generation;
    this.update({ saving: true, error: "" });
    try {
      for (const id of Object.keys(this.state.drafts)) {
        const note = this.state.notes.find(note => note.id === id), draft = this.state.drafts[id];
        if (!note?.canEdit || !draft) continue;
        if (this.state.conflicts.includes(id)) { this.update({ selectedId: id, error: "Poznámka sa zmenila v inom okne. Skopírujte si rozpracovaný text alebo načítajte aktuálnu verziu." }); return false; }
        const response = await this.fetcher(`/api/notes/${id}`, { method: "PATCH", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...draft, expectedRevision: note.revision }) });
        if (generation !== this.generation || this.disposed) return false;
        if (response.status === 401 || response.status === 403) { this.clear(); return false; }
        if (response.status === 404) { this.readSequence++; this.removeLocal(id); return false; }
        if (response.status === 409) { this.update({ conflicts: [...new Set([...this.state.conflicts, id])], selectedId: id }); throw new Error("Poznámka sa zmenila v inom okne. Načítajte aktuálnu verziu."); }
        if (!response.ok) throw new Error("Zmeny nie sú uložené. Skontrolujte pripojenie a skúste to znova.");
        const { note: saved } = await response.json() as { note: PersonalNote };
        if (generation !== this.generation || this.disposed || !this.state.notes.some(item => item.id === id)) return false;
        this.readSequence++; // A list begun before this commit must not replace its revision.
        const drafts = { ...this.state.drafts };
        if (drafts[id] && sameNoteDraft(drafts[id], draft)) delete drafts[id];
        this.update({ notes: this.state.notes.map(item => item.id === id ? saved : item), drafts, conflicts: this.state.conflicts.filter(value => value !== id), loading: false });
      }
      return Object.keys(this.state.drafts).length === 0;
    } catch (error) { if (generation === this.generation) this.update({ error: error instanceof Error ? error.message : "Zmeny nie sú uložené." }); return false; }
    finally { if (generation === this.generation) this.update({ saving: false }); }
  }
  private removeLocal(id: string) {
    const drafts = { ...this.state.drafts }; delete drafts[id];
    this.update({ notes: this.state.notes.filter(note => note.id !== id), drafts, selectedId: this.state.selectedId === id ? null : this.state.selectedId, conflicts: this.state.conflicts.filter(value => value !== id) });
  }
  async reloadSelected() {
    const id = this.state.selectedId;
    if (id) { const drafts = { ...this.state.drafts }; delete drafts[id]; this.update({ drafts, conflicts: this.state.conflicts.filter(value => value !== id) }); }
    await this.refresh();
  }
  async deleteSelected() {
    const note = this.state.notes.find(note => note.id === this.state.selectedId);
    if (!this.enabled || this.disposed || !note?.canEdit || this.state.saving || this.state.hidden) return;
    const generation = this.generation;
    this.update({ saving: true, error: "" });
    try {
      const response = await this.fetcher(`/api/notes/${note.id}`, { method: "DELETE", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: note.revision }) });
      if (generation !== this.generation || this.disposed) return;
      if (response.status === 401 || response.status === 403) { this.clear(); return; }
      if (!response.ok && response.status !== 404) throw new Error(response.status === 409 ? "Poznámka sa zmenila. Pred vymazaním načítajte aktuálnu verziu." : "Poznámku sa nepodarilo vymazať.");
      this.readSequence++; this.removeLocal(note.id);
    } catch (error) { if (generation === this.generation) this.update({ error: error instanceof Error ? error.message : "Poznámku sa nepodarilo vymazať." }); }
    finally { if (generation === this.generation) this.update({ saving: false }); }
  }
}
