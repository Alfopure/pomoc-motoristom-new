import { randomUUID } from "expo-crypto";
import type { MobileTaskMessageInput, MobileTaskMessageSent, MobileTaskTransitioned, MobileTaskWorkflowInput } from "../../../src/lib/mobile-api";
import { DraftNotSentError, draftId, draftKeys, draftObject, draftText, type DraftPort } from "../drafts/port";
import type { WorkApi } from "./api";
import { AttachmentDraft } from "./attachments";
import { TaskCommand, TaskCreateDraft } from "./commands";
import { cloneDraft, commandProjection, messageCodec, workflowCodec } from "./draft-codecs";
export type WorkDraftPort = (kind: "task-create" | "task-state" | "attachment", resourceId: string) => DraftPort;
type TaskComposer = { comment: string; body: string; reviewerId: string | null | undefined };
export type TaskDrafts = {
  composerSnapshot: () => TaskComposer;
  subscribeComposer: (listener: () => void) => () => void;
  workflow: TaskCommand<MobileTaskWorkflowInput, MobileTaskTransitioned>;
  message: TaskCommand<MobileTaskMessageInput, MobileTaskMessageSent>;
  comment: string; reviewerId: string | null | undefined; body: string;
};
/** One authenticated workspace owns the controllers shared by both task views. */
export class WorkStore {
  private attachments = new Map<string, AttachmentDraft>();
  private creates = new Map<string, TaskCreateDraft>();
  private tasks = new Map<string, TaskDrafts>();
  private disposed = false;
  private composerListeners = new Map<string, Set<() => void>>();
  constructor(readonly api: WorkApi, private changed: () => void, private draftPort?: WorkDraftPort) {}
  private notify() { if (!this.disposed) this.changed(); }
  attachment(caseId: string) {
    if (this.disposed) throw new DraftNotSentError();
    let draft = this.attachments.get(caseId);
    if (!draft) { draft = new AttachmentDraft({ upload: async (...args) => { const result = await this.api.upload(...args); this.notify(); return result; } }, caseId, randomUUID, this.draftPort?.("attachment", caseId)); this.attachments.set(caseId, draft); }
    return draft;
  }
  create(caseId: string, fresh = false) {
    if (this.disposed) throw new DraftNotSentError();
    let draft = this.creates.get(caseId);
    if (!draft) { draft = new TaskCreateDraft({ createTask: async (...args) => { const result = await this.api.createTask(...args); this.notify(); return result; } }, caseId, this.draftPort?.("task-create", caseId)); this.creates.set(caseId, draft); }
    else if (fresh) draft.reset();
    return draft;
  }
  task(taskId: string) {
    if (this.disposed) throw new DraftNotSentError();
    let drafts = this.tasks.get(taskId);
    if (drafts) return drafts;
    const port = this.draftPort?.("task-state", taskId), workflow = workflowCodec(taskId), message = messageCodec(taskId);
    let comment = "", body = "", reviewerId: string | null | undefined, rejected = false;
    let projections: { workflow: object; message: object } = {
      workflow: { version: 1, status: "editing", pending: null, receipt: null }, message: { version: 1, status: "editing", pending: null, receipt: null },
    };
    const saved = port?.load();
    if (port && saved !== null) {
      try {
        const v = draftObject(saved);
        draftKeys(v, ["version", "taskId", "comment", "body", "reviewer", "workflow", "message"]);
        if (v.version !== 1 || v.taskId !== taskId || !draftText(v.comment, 10000) || !draftText(v.body, 10000)) throw new Error();
        const reviewer = draftObject(v.reviewer);
        draftKeys(reviewer, ["kind"], reviewer.kind === "selected" ? ["id"] : []);
        if (reviewer.kind === "selected") { if (reviewer.id !== null && !draftId(reviewer.id)) throw new Error(); reviewerId = reviewer.id; }
        else if (reviewer.kind !== "untouched") throw new Error();
        const restoredWorkflow = commandProjection(v.workflow, workflow), restoredMessage = commandProjection(v.message, message);
        if (restoredWorkflow.receipt && !port.acceptsScope(restoredWorkflow.receipt) || restoredMessage.receipt && !port.acceptsScope(restoredMessage.receipt)) throw new Error();
        comment = v.comment;
        body = v.body;
        projections = { workflow: restoredWorkflow, message: restoredMessage };
      } catch {
        rejected = true;
        comment = "";
        body = "";
        reviewerId = undefined;
        port.reject();
      }
    }
    const projection = () => cloneDraft({ version: 1, taskId, comment, body, reviewer: reviewerId === undefined ? { kind: "untouched" } : { kind: "selected", id: reviewerId }, ...projections });
    const child = (kind: "workflow" | "message"): DraftPort | undefined => port && ({
      load: () => rejected ? { invalid: true } : projections[kind],
      changed: payload => { if (!rejected && !this.disposed) { projections[kind] = payload; port.changed(projection()); } },
      prepare: async payload => {
        if (rejected || this.disposed) throw new DraftNotSentError();
        projections[kind] = typeof payload === "function" ? payload() : payload;
        const write = await port.prepare(projection);
        return { finish: async outcome => {
          projections[kind] = outcome;
          return write.finish(projection());
        } };
      },
      current: () => !rejected && !this.disposed && port.current(), settled: () => !rejected && port.settled(),
      acceptsScope: value => port.acceptsScope(value), reject: () => { rejected = true; port.reject(); },
    });
    const editable = () => !rejected && !this.disposed;
    const listeners = new Set<() => void>();
    this.composerListeners.set(taskId, listeners);
    let composer = { comment, body, reviewerId };
    const persistText = () => {
      if (!editable()) return;
      port?.changed(projection());
      composer = { comment, body, reviewerId };
      for (const notify of listeners) notify();
    };
    const workflowPort = child("workflow"), messagePort = child("message");
    drafts = {
      composerSnapshot: () => composer,
      subscribeComposer: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      workflow: new TaskCommand(async input => { const result = await this.api.transition(taskId, input); this.notify(); return result; }, workflowPort ? { port: workflowPort, codec: workflow } : undefined),
      message: new TaskCommand(async input => { const result = await this.api.sendMessage(taskId, input); this.notify(); return result; }, messagePort ? { port: messagePort, codec: message } : undefined),
      get comment() { return comment; }, set comment(value: string) { if (editable()) { comment = value; persistText(); } },
      get body() { return body; }, set body(value: string) { if (editable()) { body = value; persistText(); } },
      get reviewerId() { return reviewerId; }, set reviewerId(value: string | null | undefined) { if (editable()) { reviewerId = value; persistText(); } },
    };
    this.tasks.set(taskId, drafts);
    return drafts;
  }
  dispose() {
    this.disposed = true;
    for (const listeners of this.composerListeners.values()) listeners.clear();
    this.composerListeners.clear();
    for (const draft of this.attachments.values()) draft.dispose();
    for (const draft of this.creates.values()) draft.dispose();
    for (const drafts of this.tasks.values()) {
      drafts.workflow.dispose();
      drafts.message.dispose();
    }
  }
}
