import type { TaskWorkspaceCommand, TaskWorkspaceCreate, TaskWorkspaceReceipt } from "../../../src/lib/mobile-task-workspace";
import { DraftNotSentError, draftDate, draftId, draftObject, type DraftPort, type DraftWrite } from "../drafts/port";
import { MobileApiError } from "../lib/api";
import { TaskPhotos } from "./photos";
import type { UploadFiles } from "../field-work/uploads";
import { employeeTask, taskChecklist, taskSchedule, taskCommandInput, taskCreateInput, type EmployeeTasksApi } from "./api";

export type TaskDraftInput = Omit<TaskWorkspaceCreate, "commandId"> & { targetLabel: string };
type WriteStatus = "editing" | "saving" | "uncertain" | "saved";
export type EmployeeTaskCreateState = {
  input: TaskDraftInput; status: WriteStatus; error: string | null;
  pending: TaskWorkspaceCreate | null; receipt: TaskWorkspaceReceipt | null;
};
export type EmployeeTaskCommandState = {
  status: WriteStatus; error: string | null; pending: TaskWorkspaceCommand | null;
  receipt: TaskWorkspaceReceipt | null; draftText: string;
  checklistDraft: { items: ReturnType<typeof taskChecklist>; expectedRevision: number } | null;
  recurrenceDraft: { schedule: ReturnType<typeof taskSchedule>; expectedRevision: number; expectedSeriesRevision?: number } | null;
};
export type EmployeeTasksState = { create: EmployeeTaskCreateState; commands: Record<string, EmployeeTaskCommandState>; revoked: boolean };
type Options = { id: () => string; createPort?: DraftPort; commandPort?: (taskId: string) => DraftPort; photoPort?: (key: string) => DraftPort; photoFiles?: UploadFiles };
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const unknownResult = (error: unknown) => !(error instanceof MobileApiError) || [0, 408, 429].includes(error.status) || error.status >= 500;
const errorText = (error: unknown) => error instanceof Error ? error.message : "Úlohu sa nepodarilo uložiť.";
const uncertainText = "Spojenie sa prerušilo. Overte pôvodnú požiadavku; novú úlohu zatiaľ nevytvárajte.";
const savedLocallyError = "Úloha je uložená, ale potvrdenie sa nepodarilo uložiť v zariadení. Obnovte údaje pred ďalším zápisom.";
const emptyCommand = (): EmployeeTaskCommandState => ({ status: "editing", error: null, pending: null, receipt: null, draftText: "", checklistDraft: null, recurrenceDraft: null });
// Attachment metadata is read afresh; the private draft vault deliberately excludes
// attachments and temporary URLs. Command confirmations need only the task identity.
function receiptForStorage(receipt: TaskWorkspaceReceipt | null) {
  if (!receipt) return null;
  const { attachments: _photos, ...task } = receipt.task as TaskWorkspaceReceipt["task"] & { attachments?: unknown };
  return { ...receipt, task };
}
type WithoutCommandId<T> = T extends unknown ? Omit<T, "commandId"> : never;
export type EmployeeTaskCommandDraft = WithoutCommandId<TaskWorkspaceCommand>;
function restoredReceipt(value: unknown, pendingId: string | undefined, userId: string, port: DraftPort, taskId?: string): TaskWorkspaceReceipt | null {
  if (value === null) return null;
  const row = draftObject(value), task = employeeTask(row.task);
  if (row.ok !== true || row.apiVersion !== 1 || row.userId !== userId || !draftId(row.organizationId) || !draftDate(row.checkedAt)
    || row.commandId !== pendingId || typeof row.committedRevision !== "number" || !Number.isSafeInteger(row.committedRevision)
    || row.committedRevision < 1 || row.committedRevision > task.revision || taskId && task.id !== taskId || !port.acceptsScope(row)) throw new Error();
  return { ...row, task } as TaskWorkspaceReceipt;
}

/** Account-owned state. Keep this instance above module navigation. DraftPort
 * optionally binds pending writes to the existing secure draft vault. */
export class EmployeeTasksStore {
  private state: EmployeeTasksState;
  private listeners = new Set<() => void>();
  private disposed = false;
  private unsubscribe: () => void;
  readonly photos: TaskPhotos;
  private commandPorts = new Map<string, DraftPort>();
  private commandPort(taskId: string) {
    if (!this.options.commandPort) return undefined;
    let port = this.commandPorts.get(taskId);
    if (!port) { port = this.options.commandPort(taskId); this.commandPorts.set(taskId, port); }
    return port;
  }
  constructor(readonly api: EmployeeTasksApi, readonly userId: string, private options: Options) {
    this.photos = new TaskPhotos(api, userId, { id: options.id, port: options.photoPort, files: options.photoFiles });
    this.state = { create: this.emptyCreate(), commands: {}, revoked: false };
    try {
      const restored = options.createPort?.load();
      if (restored !== undefined && restored !== null) {
        const value = draftObject(restored);
        if (value.version !== 1 || value.userId !== userId || !["editing", "saving", "uncertain", "saved"].includes(value.status as string)) throw new Error();
        const input = this.restoreInput(value.input);
        const pending = value.pending === null ? null : taskCreateInput(value.pending);
        if ((value.status === "editing") !== (pending === null) || (value.status === "saved") !== (value.receipt !== null)) throw new Error();
        const receipt = restoredReceipt(value.receipt, pending?.commandId, userId, options.createPort!);
        const status = value.status === "saving" ? "uncertain" : value.status as WriteStatus;
        this.state.create = { input, pending, receipt, status, error: status === "uncertain" ? uncertainText : null };
      }
    } catch {
      options.createPort?.reject();
      this.state = { create: { ...this.emptyCreate(), error: "Uložený koncept úlohy sa nepodarilo overiť." }, commands: {}, revoked: true };
    }
    this.unsubscribe = api.subscribeAccessLoss(() => this.revoke());
  }
  private emptyCreate(): EmployeeTaskCreateState {
    return { input: { title: "", target: { kind: "person", userId: this.userId }, targetLabel: "Ja", description: "", priority: "normal", dueAt: null },
      status: "editing", error: null, pending: null, receipt: null };
  }
  private restoreInput(value: unknown): TaskDraftInput {
    const row = draftObject(value);
    if (typeof row.targetLabel !== "string" || row.targetLabel.length > 200) throw new Error();
    const { targetLabel, ...input } = row;
    // Validate incomplete title separately: it is allowed in a local draft.
    if (typeof input.title !== "string" || input.title.length > 500) throw new Error();
    const checklist = input.checklist === undefined ? undefined : taskChecklist(input.checklist, true);
    const recurrence = input.recurrence === undefined ? undefined : taskSchedule(input.recurrence, true);
    const checked = taskCreateInput({ ...input,
      ...(checklist ? { checklist: checklist.map(item => ({ ...item, title: item.title.trim() || "Bod" })) } : {}),
      ...(recurrence ? { recurrence: { ...recurrence, time: "09:00" } } : {}), title: input.title.trim() ? input.title : "Koncept", commandId: this.userId });
    const { commandId: _id, ...restored } = checked;
    return { ...restored, ...(checklist ? { checklist } : {}), ...(recurrence ? { recurrence } : {}), title: input.title, targetLabel };
  }
  snapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify() { for (const listener of this.listeners) listener(); }
  private createPayload() { return { version: 1, userId: this.userId, ...clone(this.state.create), receipt: receiptForStorage(this.state.create.receipt) }; }
  private updateCreate(change: Partial<EmployeeTaskCreateState>, persist = true) {
    if (this.disposed || this.state.revoked) return;
    this.state = { ...this.state, create: { ...this.state.create, ...change } };
    if (persist) this.options.createPort?.changed(this.createPayload());
    this.notify();
  }
  editCreate(change: Partial<TaskDraftInput>) {
    if (this.state.create.status === "editing") this.updateCreate({ input: { ...this.state.create.input, ...change }, error: null });
  }
  async beginCreate() {
    if (this.state.create.status === "saved" && (!this.options.createPort || this.options.createPort.settled())) {
      if (this.state.create.receipt && !await this.photos.releaseCreate(this.state.create.receipt.task)) {
        this.updateCreate({ error: "Fotografia predchádzajúcej úlohy ešte čaká na miestne uloženie. Skúste vytvorenie novej úlohy znova." }); return false;
      }
      this.updateCreate(this.emptyCreate());
    }
    return true;
  }
  discardCreate() {
    if (this.state.create.status === "editing") this.updateCreate(this.emptyCreate());
  }
  async create() {
    if (this.disposed || this.state.revoked || this.state.create.status !== "editing") return;
    const { targetLabel: _label, ...input } = this.state.create.input;
    let pending: TaskWorkspaceCreate;
    try { pending = taskCreateInput({ ...input, commandId: this.options.id() }); }
    catch (error) { this.updateCreate({ error: errorText(error) }); return; }
    this.updateCreate({ pending: clone(pending) }, false);
    return this.runCreate(false);
  }
  async retryCreate() {
    if (!this.disposed && !this.state.revoked && this.state.create.status === "uncertain") return this.runCreate(true);
  }
  private async runCreate(reconciling: boolean) {
    const pending = this.state.create.pending;
    if (!pending) return;
    const port = this.options.createPort;
    this.updateCreate({ status: "saving", error: null }, false);
    const originalPayload = this.createPayload();
    let write: DraftWrite | undefined;
    try {
      if (port) {
        try { write = await port.prepare(originalPayload); } catch { throw new DraftNotSentError(); }
        if (!port.current() || this.disposed) throw new DraftNotSentError();
      }
      const receipt = await this.api.create(clone(pending));
      if (this.disposed || this.state.revoked) return;
      if (port && !port.acceptsScope(receipt)) throw new MobileApiError("Potvrdenie patrí inému účtu.", 502);
      let persisted = true;
      try { if (write) persisted = await write.finish({ ...originalPayload, status: "saved", receipt: receiptForStorage(receipt) }); } catch { persisted = false; }
      this.updateCreate({ status: "saved", receipt, error: persisted ? null : savedLocallyError }, false);
      return receipt;
    } catch (error) {
      const uncertain = reconciling || !(error instanceof DraftNotSentError) && unknownResult(error);
      const change = { status: uncertain ? "uncertain" as const : "editing" as const, pending: uncertain ? pending : null, error: uncertain ? uncertainText : errorText(error) };
      try { if (write) await write.finish({ ...originalPayload, ...change }); } catch { /* Exact pending envelope remains in memory. */ }
      this.updateCreate(change, !write);
    }
  }
  commandState(taskId: string): EmployeeTaskCommandState {
    if (this.disposed || this.state.revoked) return emptyCommand();
    if (this.state.commands[taskId]) return this.state.commands[taskId];
    let state = emptyCommand();
    const port = this.commandPort(taskId);
    try {
      const stored = port?.load();
      if (stored !== undefined && stored !== null) {
        const row = draftObject(stored);
        if (row.version !== 1 || row.userId !== this.userId || row.taskId !== taskId || !["saving", "uncertain", "saved", "editing"].includes(row.status as string)) throw new Error();
        const pending = row.pending === null ? null : taskCommandInput(row.pending);
        if ((row.status === "editing") !== (pending === null) || (row.status === "saved") !== (row.receipt !== null)) throw new Error();
        const receipt = restoredReceipt(row.receipt, pending?.commandId, this.userId, port!, taskId);
        if (row.draftText !== undefined && (typeof row.draftText !== "string" || row.draftText.length > 10_000)) throw new Error();
        let checklistDraft: EmployeeTaskCommandState["checklistDraft"] = null, recurrenceDraft: EmployeeTaskCommandState["recurrenceDraft"] = null;
        for (const key of ["checklistDraft", "recurrenceDraft"] as const) {
          if (row[key] !== undefined && row[key] !== null) {
            const draft = draftObject(row[key]);
            if (typeof draft.expectedRevision !== "number" || !Number.isSafeInteger(draft.expectedRevision) || draft.expectedRevision < 1) throw new Error();
            if (key === "checklistDraft") checklistDraft = { items: taskChecklist(draft.items, true), expectedRevision: draft.expectedRevision };
            else {
              if (draft.expectedSeriesRevision !== undefined && (typeof draft.expectedSeriesRevision !== "number" || !Number.isSafeInteger(draft.expectedSeriesRevision) || draft.expectedSeriesRevision < 1)) throw new Error();
              recurrenceDraft = { schedule: taskSchedule(draft.schedule, true), expectedRevision: draft.expectedRevision,
                ...(draft.expectedSeriesRevision === undefined ? {} : { expectedSeriesRevision: draft.expectedSeriesRevision }) };
            }
          }
        }
        state = { checklistDraft, recurrenceDraft, status: row.status === "saving" ? "uncertain" : row.status as WriteStatus, pending, receipt, draftText: typeof row.draftText === "string" ? row.draftText : "", error: row.status === "saving" || row.status === "uncertain" ? uncertainText : null };
      }
    } catch { port?.reject(); this.revoke(); return emptyCommand(); }
    this.state = { ...this.state, commands: { ...this.state.commands, [taskId]: state } };
    return state;
  }
  private updateCommand(taskId: string, change: Partial<EmployeeTaskCommandState>, persist = true) {
    if (this.disposed || this.state.revoked) return;
    const state = { ...this.commandState(taskId), ...change };
    this.state = { ...this.state, commands: { ...this.state.commands, [taskId]: state } };
    if (persist) this.commandPort(taskId)?.changed({ version: 1, userId: this.userId, taskId, ...clone(state), receipt: receiptForStorage(state.receipt) });
    this.notify();
  }
  editComment(taskId: string, draftText: string) {
    const current = this.commandState(taskId);
    if (draftText.length <= 10_000 && (current.status === "editing" || current.status === "saved" && !current.error)) {
      this.updateCommand(taskId, { draftText, error: null,
        ...(current.status === "saved" ? { status: "editing", pending: null, receipt: null } : {}) });
    }
  }
  editChecklist(taskId: string, items: ReturnType<typeof taskChecklist> | null, expectedRevision: number) {
    const current = this.commandState(taskId);
    if (current.status === "saving" || current.status === "uncertain") return;
    this.updateCommand(taskId, { checklistDraft: items === null ? null : { items, expectedRevision }, error: null,
      ...(current.status === "saved" ? { status: "editing", pending: null, receipt: null } : {}) });
  }
  editRecurrence(taskId: string, schedule: ReturnType<typeof taskSchedule> | null, expectedRevision: number, expectedSeriesRevision?: number) {
    const current = this.commandState(taskId);
    if (current.status === "saving" || current.status === "uncertain") return;
    this.updateCommand(taskId, { recurrenceDraft: schedule === null ? null : { schedule, expectedRevision, ...(expectedSeriesRevision === undefined ? {} : { expectedSeriesRevision }) }, error: null,
      ...(current.status === "saved" ? { status: "editing", pending: null, receipt: null } : {}) });
  }
  async command(taskId: string, input: EmployeeTaskCommandDraft) {
    if (this.disposed || this.state.revoked || !draftId(taskId)) return;
    const current = this.commandState(taskId);
    if (current.status === "saving" || current.status === "uncertain") return;
    if (current.status === "saved" && this.options.commandPort && !this.commandPort(taskId)!.settled()) return;
    let pending: TaskWorkspaceCommand;
    try { pending = taskCommandInput({ ...input, commandId: this.options.id() }); }
    catch (error) { this.updateCommand(taskId, { error: errorText(error) }); return; }
    this.updateCommand(taskId, { pending: clone(pending), receipt: null }, false);
    return this.runCommand(taskId, false);
  }
  async retryCommand(taskId: string) {
    if (!this.disposed && !this.state.revoked && this.commandState(taskId).status === "uncertain") return this.runCommand(taskId, true);
  }
  private async runCommand(taskId: string, reconciling: boolean) {
    const pending = this.commandState(taskId).pending;
    if (!pending) return;
    const port = this.commandPort(taskId);
    this.updateCommand(taskId, { status: "saving", error: null }, false);
    let write: DraftWrite | undefined;
    const originalPayload = { version: 1, userId: this.userId, taskId, ...clone(this.commandState(taskId)), receipt: receiptForStorage(this.commandState(taskId).receipt) };
    try {
      if (port) {
        try { write = await port.prepare(originalPayload); } catch { throw new DraftNotSentError(); }
        if (this.disposed || !port.current()) throw new DraftNotSentError();
      }
      const receipt = await this.api.command(taskId, clone(pending));
      if (this.disposed || this.state.revoked) return;
      if (port && !port.acceptsScope(receipt)) throw new MobileApiError("Potvrdenie patrí inému účtu.", 502);
      const draftText = ["comment", "submit_review", "return"].includes(pending.action) ? "" : this.commandState(taskId).draftText;
      const checklistDraft = pending.action === "checklist" ? null : this.commandState(taskId).checklistDraft;
      const recurrenceDraft = pending.action === "recurrence" ? null : this.commandState(taskId).recurrenceDraft;
      let persisted = true;
      try { if (write) persisted = await write.finish({ ...originalPayload, status: "saved", receipt: receiptForStorage(receipt), draftText, checklistDraft, recurrenceDraft }); } catch { persisted = false; }
      this.updateCommand(taskId, { status: "saved", receipt, draftText, checklistDraft, recurrenceDraft, error: persisted ? null : savedLocallyError }, false);
      return receipt;
    } catch (error) {
      const uncertain = reconciling || !(error instanceof DraftNotSentError) && unknownResult(error);
      const change = { status: uncertain ? "uncertain" as const : "editing" as const, pending: uncertain ? pending : null, error: uncertain ? uncertainText : errorText(error) };
      try { if (write) await write.finish({ ...originalPayload, ...change }); } catch { /* The retry keeps the exact original envelope. */ }
      this.updateCommand(taskId, change, !write);
    }
  }
  revoke() {
    if (this.disposed) return;
    this.photos.dispose();
    this.state = { create: this.emptyCreate(), commands: {}, revoked: true };
    this.notify();
  }
  dispose() { this.disposed = true; this.photos.dispose(); this.unsubscribe(); this.listeners.clear(); this.state = { create: this.emptyCreate(), commands: {}, revoked: true }; }
}
