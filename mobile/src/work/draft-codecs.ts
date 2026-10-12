import type { MobileScope, MobileTaskCreateInput, MobileTaskCreated, MobileTaskMessageInput, MobileTaskMessageSent, MobileTaskWorkflowInput, MobileTaskTransitioned } from "../../../src/lib/mobile-api";
import { draftDate, draftId, draftKeys, draftObject, draftText } from "../drafts/port";
export const cloneDraft = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const check = (condition: unknown) => { if (!condition) throw new Error("Invalid task draft"); };
const utc = (v: unknown): v is string => draftDate(v) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && new Date(v).toISOString() === v;
export const revision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
export const scopeKeys = ["ok", "apiVersion", "environment", "profileId", "checkedAt"];
export function validateDraftScope(v: Record<string, unknown>): MobileScope {
  check(v.ok === true && v.apiVersion === 1 && ["test", "production"].includes(v.environment as string) && draftId(v.profileId) && draftDate(v.checkedAt));
  return { ok: true, apiVersion: 1, environment: v.environment as MobileScope["environment"], profileId: v.profileId as string, checkedAt: v.checkedAt as string };
}
export function taskCreateInput(value: unknown, submitted = false): MobileTaskCreateInput {
  const v = draftObject(value); draftKeys(v, ["title"], ["assignedTo", "dueAt", "priority", "kind"]);
  check(draftText(v.title, 500) && (!submitted || !!v.title.trim()));
  check(v.assignedTo === undefined || v.assignedTo === null || draftId(v.assignedTo));
  check(v.dueAt === undefined || v.dueAt === null || (submitted ? utc(v.dueAt) : draftText(v.dueAt, 64)));
  check(v.priority === undefined || ["urgent", "high", "normal", "low"].includes(v.priority as string));
  check(v.kind === undefined || ["callback", "sms", "dispatch", "documents", "billing", "handover", "other"].includes(v.kind as string));
  return cloneDraft(v) as MobileTaskCreateInput;
}
export function taskCreated(value: unknown, caseId: string): MobileTaskCreated {
  const v = draftObject(value); draftKeys(v, [...scopeKeys, "caseId", "taskId", "refreshRequired"]);
  const scope = validateDraftScope(v); check(v.caseId === caseId && draftId(v.taskId) && v.refreshRequired === true);
  return { ...scope, caseId, taskId: v.taskId as string, refreshRequired: true };
}
export type CommandCodec<I, R> = { input(value: unknown): I; receipt(value: unknown, input: I): R };
export function workflowCodec(taskId: string): CommandCodec<MobileTaskWorkflowInput, MobileTaskTransitioned> {
  return {
    input(value) {
      const v = draftObject(value); draftKeys(v, ["action", "expectedRevision", "commandId"], ["reviewerProfileId", "comment"]);
      check(["start", "submit_review", "approve", "return", "complete", "reopen", "to_todo"].includes(v.action as string) && revision(v.expectedRevision) && draftId(v.commandId));
      check(v.reviewerProfileId === undefined || draftId(v.reviewerProfileId));
      check(v.comment === undefined || draftText(v.comment, 10000));
      check(v.action !== "submit_review" || draftId(v.reviewerProfileId) && typeof v.comment === "string" && !!v.comment.trim());
      check(v.action !== "return" || typeof v.comment === "string" && !!v.comment.trim());
      return cloneDraft(v) as MobileTaskWorkflowInput;
    },
    receipt(value, input) {
      const v = draftObject(value); draftKeys(v, [...scopeKeys, "taskId", "commandId", "committedRevision", "currentRevision", "refreshRequired"]);
      const scope = validateDraftScope(v);
      check(v.taskId === taskId && v.commandId === input.commandId && revision(v.committedRevision) && v.committedRevision > input.expectedRevision && revision(v.currentRevision) && v.currentRevision >= (v.committedRevision as number) && v.refreshRequired === true);
      return { ...scope, taskId, commandId: input.commandId, committedRevision: v.committedRevision as number, currentRevision: v.currentRevision as number, refreshRequired: true };
    },
  };
}
export function messageCodec(taskId: string): CommandCodec<MobileTaskMessageInput, MobileTaskMessageSent> {
  return {
    input(value) {
      const v = draftObject(value); draftKeys(v, ["clientMessageId", "body"]); check(draftId(v.clientMessageId) && draftText(v.body, 10000) && !!v.body.trim());
      return { clientMessageId: v.clientMessageId as string, body: v.body as string };
    },
    receipt(value, input) {
      const v = draftObject(value); draftKeys(v, [...scopeKeys, "taskId", "message", "refreshRequired"]);
      const scope = validateDraftScope(v), m = draftObject(v.message); draftKeys(m, ["id", "taskId", "authorProfileId", "authorName", "body", "createdAt", "clientMessageId"]);
      check(v.taskId === taskId && v.refreshRequired === true && draftId(m.id) && m.taskId === taskId && m.authorProfileId === scope.profileId && draftText(m.authorName, 320) && m.body === input.body && m.clientMessageId === input.clientMessageId && draftDate(m.createdAt));
      return { ...scope, taskId, message: cloneDraft(m) as MobileTaskMessageSent["message"], refreshRequired: true };
    },
  };
}
export type CommandProjection<I, R> = { version: 1; status: "editing" | "saving" | "uncertain" | "saved"; pending: I | null; receipt: R | null };
export function commandProjection<I, R>(value: unknown, codec: CommandCodec<I, R>): CommandProjection<I, R> {
  const v = draftObject(value); draftKeys(v, ["version", "status", "pending", "receipt"]);
  check(v.version === 1 && ["editing", "saving", "uncertain", "saved"].includes(v.status as string));
  const status = v.status as CommandProjection<I, R>["status"];
  if (status === "editing") { check(v.pending === null && v.receipt === null); return { version: 1, status, pending: null, receipt: null }; }
  const pending = codec.input(v.pending);
  if (status !== "saved") { check(v.receipt === null); return { version: 1, status, pending, receipt: null }; }
  return { version: 1, status, pending, receipt: codec.receipt(v.receipt, pending) };
}
