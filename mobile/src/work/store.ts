import { randomUUID } from "expo-crypto";
import type { MobileTaskMessageInput, MobileTaskMessageSent, MobileTaskTransitioned, MobileTaskWorkflowInput } from "../../../src/lib/mobile-api";
import type { WorkApi } from "./api";
import { AttachmentDraft } from "./attachments";
import { TaskCommand, TaskCreateDraft } from "./commands";
export type TaskDrafts = {
  workflow: TaskCommand<MobileTaskWorkflowInput, MobileTaskTransitioned>;
  message: TaskCommand<MobileTaskMessageInput, MobileTaskMessageSent>;
  comment: string; reviewerId: string | null | undefined; body: string;
};
/** Owned by the authenticated Cases workspace, not an individual screen. */
export class WorkStore {
  private attachments = new Map<string, AttachmentDraft>();
  private creates = new Map<string, TaskCreateDraft>();
  private tasks = new Map<string, TaskDrafts>();
  private disposed = false;
  constructor(readonly api: WorkApi, private changed: () => void) {}
  private notify() { if (!this.disposed) this.changed(); }
  attachment(caseId: string) {
    let draft = this.attachments.get(caseId);
    if (!draft) { draft = new AttachmentDraft({ upload: async (...args) => { const result = await this.api.upload(...args); this.notify(); return result; } }, caseId, randomUUID); this.attachments.set(caseId, draft); }
    return draft;
  }
  create(caseId: string, fresh = false) {
    let draft = this.creates.get(caseId);
    if (!draft || fresh && draft.snapshot().status === "saved") { draft?.dispose(); draft = new TaskCreateDraft({ createTask: async (...args) => { const result = await this.api.createTask(...args); this.notify(); return result; } }, caseId); this.creates.set(caseId, draft); }
    return draft;
  }
  task(taskId: string) {
    let drafts = this.tasks.get(taskId);
    if (!drafts) {
      drafts = { workflow: new TaskCommand(async input => { const result = await this.api.transition(taskId, input); this.notify(); return result; }),
        message: new TaskCommand(async input => { const result = await this.api.sendMessage(taskId, input); this.notify(); return result; }), comment: "", reviewerId: undefined, body: "" };
      this.tasks.set(taskId, drafts);
    }
    return drafts;
  }
  dispose() { this.disposed = true; for (const draft of this.attachments.values()) draft.dispose(); for (const draft of this.creates.values()) draft.dispose(); for (const drafts of this.tasks.values()) { drafts.workflow.dispose(); drafts.message.dispose(); } }
}
