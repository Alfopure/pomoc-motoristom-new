import type { CasePriority } from "@/domain/types";
import { TASK_MESSAGE_LIMIT, type TaskMessage, type TaskMessageCursor, type WorkspaceTask } from "@/domain/task-workspace";
export type TaskDraft = { title: string; assignedTo: string; dueAt: string; reminderAt: string; priority: CasePriority; status: "open" | "done"; caseIds: string[]; reminderChannels: ("in_app" | "email")[] };
export type TaskWorkspaceSnapshot = {
  tasks: WorkspaceTask[]; selectedId: string | null; creating: boolean; createDraft: TaskDraft;
  drafts: Record<string, { value: TaskDraft; revision: number }>;
  chats: Record<string, { messages: TaskMessage[]; nextCursor: TaskMessageCursor | null; loaded: boolean; latestFetched?: TaskMessageCursor }>;
  chatDrafts: Record<string, string>; pendingMessages: Record<string, { clientMessageId: string; body: string }>;
  hidden: boolean; loading: boolean; saving: boolean; error: string; conflicts: string[];
};
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export function emptyTaskDraft(viewer?: string): TaskDraft { return { title: "", assignedTo: viewer ?? "unassigned", dueAt: "", reminderAt: "", priority: "normal", status: "open", caseIds: [], reminderChannels: ["in_app"] }; }
export function taskDraft(task: WorkspaceTask): TaskDraft { return { title: task.title, assignedTo: task.assignedTo || "unassigned", dueAt: task.dueAt || "", reminderAt: (task as WorkspaceTask & { reminderAt?: string | null }).reminderAt || "", priority: task.priority, status: task.status === "done" ? "done" : "open", caseIds: task.caseIds, reminderChannels: ["in_app"] }; }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const compareMessagePositions = (a: TaskMessageCursor, b: TaskMessageCursor) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
export class TaskWorkspaceStore {
  private listeners = new Set<() => void>();
  private state: TaskWorkspaceSnapshot;
  private generation = 0;
  private readSequence = 0;
  private openSequence = 0;
  private exactReads = new Map<string, number>();
  private revokedIds = new Set<string>();
  private authoritativeList = false;
  private messageReads = new Map<string, Promise<void>>();
  private savePromise: Promise<boolean> | null = null;
  private onTasksChange?: (tasks: WorkspaceTask[]) => void;
  setOnTasksChange = (callback?: (tasks: WorkspaceTask[]) => void) => { this.onTasksChange = callback; };
  constructor(private featureEnabled: boolean, private viewer?: string, private fetcher: Fetcher = (url, init) => fetch(url, init), initialTasks: WorkspaceTask[] = []) {
    this.state = { tasks: featureEnabled ? initialTasks : [], selectedId: null, creating: false, createDraft: emptyTaskDraft(viewer), drafts: {}, chats: {}, chatDrafts: {}, pendingMessages: {}, hidden: !featureEnabled, loading: false, saving: false, error: "", conflicts: [] };
  }
  get enabled() { return this.featureEnabled; }
  setEnabled = (enabled: boolean) => {
    if (enabled === this.featureEnabled) return;
    this.featureEnabled = enabled;
    this.clear();
  };
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<TaskWorkspaceSnapshot>) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); }
  get dirty() { return Boolean(!same(this.state.createDraft, emptyTaskDraft(this.viewer)) || Object.keys(this.state.drafts).length || Object.values(this.state.chatDrafts).some(value => value.trim()) || Object.keys(this.state.pendingMessages).length); }
  clear = () => { this.generation++; this.readSequence++; this.openSequence++; this.messageReads.clear(); this.savePromise = null; this.exactReads.clear(); this.authoritativeList = false; this.revokedIds.clear(); this.update({ tasks: [], selectedId: null, creating: false, createDraft: emptyTaskDraft(this.viewer), drafts: {}, chats: {}, chatDrafts: {}, pendingMessages: {}, hidden: true, loading: false, saving: false, conflicts: [], error: "Prístup k úlohám treba znovu overiť." }); };
  reauthorize = () => { this.update({ hidden: true }); return this.refresh(); };
  discard = () => { if (!this.state.saving) this.update({ drafts: {}, chatDrafts: {}, pendingMessages: {}, createDraft: emptyTaskDraft(this.viewer), conflicts: [], error: "" }); };
  select = (id: string | null) => { this.openSequence++; this.update({ selectedId: id, creating: false, error: "" }); if (id) void this.loadMessages(id); };
  open = async (id: string) => {
    if (!this.enabled) return;
    const generation = this.generation, sequence = ++this.openSequence;
    this.readSequence++; this.update({ loading: false }); this.exactReads.set(id, sequence);
    try {
      const { task } = await this.request(`/api/tasks/${encodeURIComponent(id)}`) as { task: WorkspaceTask };
      if (generation !== this.generation || sequence !== this.openSequence) return;
      this.accept(task); this.select(task.id);
      // Exact navigation supersedes an in-flight resume check. Reauthorize the
      // remaining cached list before showing it, without waiting for the poll.
      if (this.state.hidden) void this.refresh();
    } catch (error) {
      if (generation === this.generation && sequence === this.openSequence) {
        if ((error as { status?: number }).status === 404) this.removeTask(id);
        this.update({ error: error instanceof Error ? error.message : "Úloha nie je dostupná." });
      }
    } finally { if (this.exactReads.get(id) === sequence) this.exactReads.delete(id); }
  };
  private removeTask(id: string) {
    this.revokedIds.add(id);
    const without = <T,>(items: Record<string, T>) => Object.fromEntries(Object.entries(items).filter(([key]) => key !== id));
    this.update({ tasks: this.state.tasks.filter(task => task.id !== id), drafts: without(this.state.drafts), chats: without(this.state.chats), chatDrafts: without(this.state.chatDrafts), pendingMessages: without(this.state.pendingMessages), selectedId: this.state.selectedId === id ? null : this.state.selectedId });
  }
  openCreate = () => { if (!this.enabled || this.state.hidden) return; this.update({ creating: true, selectedId: null, error: "" }); };
  editCreate = (patch: Partial<TaskDraft>) => { if (!this.enabled || this.state.hidden) return; this.update({ createDraft: { ...this.state.createDraft, ...patch }, error: "" }); };
  edit = (id: string, patch: Partial<TaskDraft>) => {
    if (!this.enabled || this.state.hidden) return;
    const task = this.state.tasks.find(item => item.id === id); if (!task) return;
    const current = this.state.drafts[id] ?? { value: taskDraft(task), revision: task.revision };
    const next = { ...current, value: { ...current.value, ...patch } };
    const drafts = { ...this.state.drafts, [id]: next };
    if (same(next.value, taskDraft(task))) delete drafts[id];
    this.update({ drafts, error: "" });
  };
  editChat = (id: string, body: string) => { if (!this.enabled || this.state.hidden) return; this.update({ chatDrafts: { ...this.state.chatDrafts, [id]: body }, error: "" }); };
  setTasks = (tasks: WorkspaceTask[]) => {
    if (!this.enabled || this.state.hidden) return;
    // DispatchData carries no list revision: absence in an older prop snapshot
    // is not deletion evidence. Only our sequenced authorized list may remove.
    const current = new Map(this.state.tasks.map(task => [task.id, task]));
    let needsAuthorization = false;
    for (const task of tasks) {
      const existing = current.get(task.id);
      if (this.revokedIds.has(task.id)) continue;
      if (!existing && this.authoritativeList) { needsAuthorization = true; continue; }
      if (!existing || task.revision > existing.revision) current.set(task.id, task);
    }
    const merged = [...current.values()];
    if (!same(merged, this.state.tasks)) this.update({ tasks: merged });
    if (needsAuthorization && !this.state.loading) void this.refresh();
  };
  private applyAuthorizedList(tasks: WorkspaceTask[]) {
    const current = new Map(this.state.tasks.map(task => [task.id, task]));
    const merged = tasks.map(task => {
      this.revokedIds.delete(task.id);
      const existing = current.get(task.id);
      return existing && existing.revision > task.revision ? existing : task;
    });
    const allowed = new Set(merged.map(task => task.id));
    for (const task of current.values()) {
      if (allowed.has(task.id)) continue;
      // An exact read already in flight resolves its own authority. A later
      // poll can remove it after a transient failure; a 404 removes it at once.
      if (this.exactReads.has(task.id)) { merged.push(task); allowed.add(task.id); }
      else this.revokedIds.add(task.id);
    }
    const retain = <T,>(items: Record<string, T>) => Object.fromEntries(Object.entries(items).filter(([id]) => allowed.has(id)));
    this.authoritativeList = true;
    this.update({ tasks: merged, drafts: retain(this.state.drafts), chats: retain(this.state.chats), chatDrafts: retain(this.state.chatDrafts), pendingMessages: retain(this.state.pendingMessages),
      conflicts: this.state.conflicts.filter(id => allowed.has(id)), hidden: false, error: "", selectedId: this.state.selectedId && allowed.has(this.state.selectedId) ? this.state.selectedId : null });
    this.onTasksChange?.(merged);
  }
  private accept(task: WorkspaceTask) {
    this.revokedIds.delete(task.id);
    this.readSequence++;
    const existing = this.state.tasks.find(item => item.id === task.id);
    const tasks = [existing && existing.revision > task.revision ? existing : task, ...this.state.tasks.filter(item => item.id !== task.id)];
    this.update({ tasks, loading: false }); this.onTasksChange?.(tasks);
  }
  private async request(url: string, init?: RequestInit) {
    const generation = this.generation;
    const response = await this.fetcher(url, { cache: "no-store", signal: AbortSignal.timeout(15_000), ...init });
    if (response.status === 401 || response.status === 403) { if (generation === this.generation) this.clear(); throw new Error("Prístup k úlohám treba znovu overiť."); }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(result.error || "Zmeny nie sú uložené. Skontrolujte pripojenie a skúste znova."); Object.assign(error, { status: response.status }); throw error; }
    return result;
  }
  async refresh() {
    if (!this.enabled) return;
    const sequence = ++this.readSequence, generation = this.generation;
    this.update({ loading: true });
    try {
      const { tasks } = await this.request("/api/tasks") as { tasks: WorkspaceTask[] };
      if (sequence !== this.readSequence || generation !== this.generation) return;
      this.applyAuthorizedList(tasks);
    } catch (error) { if (generation === this.generation && sequence === this.readSequence) this.update({ error: error instanceof Error ? error.message : "Úlohy nie sú dostupné." }); }
    finally { if (sequence === this.readSequence) this.update({ loading: false }); }
  }
  private body(value: unknown): RequestInit { return { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }; }
  private payload(draft: TaskDraft, includeChannels = true) {
    if (!draft.title.trim() || draft.title.trim().length > 500) throw new Error("Úloha potrebuje názov s najviac 500 znakmi.");
    if (draft.dueAt && !Number.isFinite(Date.parse(draft.dueAt))) throw new Error("Skontrolujte termín úlohy.");
    if (draft.reminderAt && !Number.isFinite(Date.parse(draft.reminderAt))) throw new Error("Skontrolujte čas pripomienky.");
    const { reminderChannels, ...fields } = draft;
    return { ...fields, ...(includeChannels ? { reminderChannels } : {}), reminderAt: draft.reminderAt ? new Date(draft.reminderAt).toISOString() : null, title: draft.title.trim(), assignedTo: draft.assignedTo === "unassigned" ? null : draft.assignedTo, dueAt: draft.dueAt ? new Date(draft.dueAt).toISOString() : null };
  }
  private async operation(action: () => Promise<void>): Promise<boolean> {
    if (!this.enabled || this.state.saving || this.state.hidden) return false;
    this.update({ saving: true, error: "" });
    const generation = this.generation;
    try { await action(); return generation === this.generation; }
    catch (error) { if (generation === this.generation) this.update({ error: error instanceof Error ? error.message : "Zmeny nie sú uložené." }); return false; }
    finally { if (generation === this.generation) this.update({ saving: false }); }
  }
  create = () => this.operation(async () => {
    const draft = this.state.createDraft, generation = this.generation;
    const { task } = await this.request("/api/tasks", { method: "POST", ...this.body(this.payload(draft)) }) as { task: WorkspaceTask };
    if (generation !== this.generation) return;
    this.accept(task);
    this.update({ createDraft: same(draft, this.state.createDraft) ? emptyTaskDraft(this.viewer) : this.state.createDraft, creating: false, selectedId: task.id });
  });
  saveTask = (id: string) => this.operation(async () => {
    const draft = this.state.drafts[id]; if (!draft) return;
    const generation = this.generation;
    try {
      const { task } = await this.request(`/api/tasks/${id}`, { method: "PATCH", ...this.body({ ...this.payload(draft.value, false), expectedRevision: draft.revision }) }) as { task: WorkspaceTask };
      if (generation !== this.generation || !this.state.tasks.some(item => item.id === id)) return;
      this.accept(task);
      const drafts = { ...this.state.drafts };
      if (same(drafts[id], draft)) delete drafts[id];
      else if (drafts[id]) drafts[id] = { ...drafts[id], revision: task.revision };
      this.update({ drafts, conflicts: this.state.conflicts.filter(value => value !== id) });
    } catch (error) { if (generation === this.generation && (error as { status?: number }).status === 409) this.update({ conflicts: [...new Set([...this.state.conflicts, id])] }); throw error; }
  });
  reloadTask = async (id: string) => {
    if (!this.enabled || this.state.saving) return;
    const generation = this.generation;
    try {
      const { task } = await this.request(`/api/tasks/${id}`) as { task: WorkspaceTask };
      if (generation !== this.generation || !this.state.tasks.some(item => item.id === id)) return;
      this.accept(task); const drafts = { ...this.state.drafts }; delete drafts[id];
      this.update({ drafts, conflicts: this.state.conflicts.filter(value => value !== id), error: "" });
    } catch (error) { if (generation === this.generation) this.update({ error: error instanceof Error ? error.message : "Úloha nie je dostupná." }); }
  };
  deleteTask = (id: string) => this.operation(async () => {
    const task = this.state.tasks.find(item => item.id === id); if (!task) return;
    const generation = this.generation;
    await this.request(`/api/tasks/${id}`, { method: "DELETE", ...this.body({ expectedRevision: task.revision }) });
    if (generation !== this.generation) return;
    const tasks = this.state.tasks.filter(item => item.id !== id), drafts = { ...this.state.drafts }, chats = { ...this.state.chats }, chatDrafts = { ...this.state.chatDrafts }, pendingMessages = { ...this.state.pendingMessages };
    delete drafts[id]; delete chats[id]; delete chatDrafts[id]; delete pendingMessages[id];
    this.revokedIds.add(id); this.readSequence++; this.update({ tasks, drafts, chats, chatDrafts, pendingMessages, selectedId: null }); this.onTasksChange?.(tasks);
  });
  link = (id: string, caseId: string, unlink = false) => this.operation(async () => {
    const task = this.state.tasks.find(item => item.id === id); if (!task) return;
    if (this.state.drafts[id]) throw new Error("Pred zmenou prepojenia uložte rozpracovanú úlohu.");
    const generation = this.generation;
    const { task: saved } = await this.request(`/api/tasks/${id}/links`, { method: unlink ? "DELETE" : "POST", ...this.body({ caseId, expectedRevision: task.revision }) }) as { task: WorkspaceTask };
    if (generation === this.generation && this.state.tasks.some(item => item.id === id)) this.accept(saved);
  });
  loadMessages = (id: string, older = false): Promise<void> => {
    if (!this.enabled) return Promise.resolve();
    const existing = this.messageReads.get(id); if (existing) return existing;
    const operation = this.fetchMessages(id, older); this.messageReads.set(id, operation);
    void operation.finally(() => { if (this.messageReads.get(id) === operation) this.messageReads.delete(id); });
    return operation;
  };
  private async fetchMessages(id: string, older: boolean) {
    const current = this.state.chats[id], generation = this.generation;
    if (older && !current?.nextCursor) return;
    const cursor = older ? current?.nextCursor : null;
    const query = cursor ? `?beforeCreatedAt=${encodeURIComponent(cursor.createdAt)}&beforeId=${encodeURIComponent(cursor.id)}` : "";
    try {
      const page = await this.request(`/api/tasks/${id}/messages${query}`) as { messages: TaskMessage[]; nextCursor: TaskMessageCursor | null };
      if (generation !== this.generation || !this.state.tasks.some(task => task.id === id)) return;
      const orderedPage = [...page.messages].sort(compareMessagePositions);
      const messages = [...new Map([...(this.state.chats[id]?.messages ?? []), ...orderedPage].map(message => [message.id, message])).values()].sort(compareMessagePositions);
      // Preserve older-page progress only when the fresh page reaches the last
      // fetched head. A disjoint page after reconnect must expose its gap via
      // its own cursor. A just-sent message alone does not prove that overlap.
      const overlapsFetched = !orderedPage.length || Boolean(current?.latestFetched && compareMessagePositions(orderedPage[0], current.latestFetched) <= 0);
      const newest = orderedPage.at(-1);
      const latestFetched = !older && newest ? { id: newest.id, createdAt: newest.createdAt } : current?.latestFetched;
      this.update({ chats: { ...this.state.chats, [id]: { messages, nextCursor: older || !current?.loaded || !overlapsFetched ? page.nextCursor : current.nextCursor, loaded: true, latestFetched } } });
    } catch (error) { if (generation === this.generation) this.update({ error: error instanceof Error ? error.message : "Správy nie sú dostupné." }); }
  }
  sendMessage = (id: string) => this.operation(async () => {
    const body = this.state.chatDrafts[id]?.trim() ?? "";
    const pending = this.state.pendingMessages[id] ?? { body, clientMessageId: crypto.randomUUID() };
    if (!pending.body || pending.body.length > TASK_MESSAGE_LIMIT) throw new Error("Správa musí mať 1 až 10 000 znakov.");
    const generation = this.generation;
    this.update({ pendingMessages: { ...this.state.pendingMessages, [id]: pending } });
    const { message } = await this.request(`/api/tasks/${id}/messages`, { method: "POST", ...this.body(pending) }) as { message: TaskMessage };
    if (generation !== this.generation || !this.state.tasks.some(item => item.id === id)) return;
    const pendingMessages = { ...this.state.pendingMessages }; delete pendingMessages[id];
    const chatDrafts = { ...this.state.chatDrafts }; if (chatDrafts[id]?.trim() === pending.body) delete chatDrafts[id];
    const chat = this.state.chats[id] ?? { messages: [], nextCursor: null, loaded: false };
    this.update({ pendingMessages, chatDrafts, chats: { ...this.state.chats, [id]: { ...chat, messages: [...chat.messages.filter(item => item.id !== message.id), message] } } });
  });
  saveAll = (): Promise<boolean> => {
    if (this.savePromise) return this.savePromise;
    const operation = (async () => {
      if (this.state.saving) return false;
      if (!same(this.state.createDraft, emptyTaskDraft(this.viewer)) && !await this.create()) return false;
      for (const id of Object.keys(this.state.drafts)) if (!await this.saveTask(id)) { this.select(id); return false; }
      for (const id of new Set([...Object.keys(this.state.chatDrafts), ...Object.keys(this.state.pendingMessages)])) {
        if ((this.state.chatDrafts[id]?.trim() || this.state.pendingMessages[id]) && !await this.sendMessage(id)) { this.select(id); return false; }
      }
      return !this.dirty;
    })();
    this.savePromise = operation; void operation.finally(() => { if (this.savePromise === operation) this.savePromise = null; }); return operation;
  };
}
