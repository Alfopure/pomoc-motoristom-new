import type { MobileCaseCreateInput, MobileCaseCreated, MobileCaseDetailData, MobileCaseNoteAdded, MobileCaseNoteInput, MobileCaseUpdated, MobileCaseUpdateInput, MobileScope, MobileCasePlaceSelection } from "../../../src/lib/mobile-api";
import { draftDate, draftId, draftKeys, draftObject, draftText, type DraftPort } from "../drafts/port";

import { placeSelection } from "./location";

export type CaseEditable = MobileCaseDetailData["editable"] & { pickup?: MobileCasePlaceSelection | null; destination?: MobileCasePlaceSelection | null };
const lengths = { contactName: 200, contactPhone: 64, licensePlate: 32, vehicleMake: 80, vehicleModel: 120,
  manualPickupAddress: 500, manualDestinationAddress: 500, incidentDescription: 5000, note: 10000 };
const priorities = ["urgent", "high", "normal", "low"];
const jobs = ["tow", "replacement_vehicle", "onsite_assistance", "vehicle_recovery"];
const statuses = ["open", "completed_assisted", "completed_no_assistance", "waiting_for_docs", "cancelled", "futile_trip"];
const check = (condition: unknown) => { if (!condition) throw new Error("Invalid case draft"); };
export const copyCaseDraft = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

export function caseDraftInput(value: unknown, version = 2): MobileCaseCreateInput {
  const input = draftObject(value); draftKeys(input, [], [...Object.keys(lengths), "priority", "jobTypes", ...(version === 2 ? ["pickup", "destination"] : [])]);
  for (const [key, max] of Object.entries(lengths)) check(!(key in input) || draftText(input[key], max));
  check(!("priority" in input) || priorities.includes(input.priority as string));
  if ("jobTypes" in input) check(Array.isArray(input.jobTypes) && input.jobTypes.length <= jobs.length
    && new Set(input.jobTypes).size === input.jobTypes.length && input.jobTypes.every(job => jobs.includes(job as string)));
  for (const target of ["pickup", "destination"] as const) if (target in input) {
    check(!((target === "pickup" ? "manualPickupAddress" : "manualDestinationAddress") in input));
    if (input[target] !== null) { const selected = placeSelection(input[target]); check(JSON.stringify(selected) === JSON.stringify(input[target]) || Object.entries(selected).every(([key, v]) => v === draftObject(input[target])[key])); }
  }
  return copyCaseDraft(input) as MobileCaseCreateInput;
}
export function editableDraft(value: unknown, version = 2): CaseEditable {
  const input = draftObject(value); draftKeys(input, [...Object.keys(lengths), "priority", "jobTypes", "status"], version === 2 ? ["pickup", "destination"] : []);
  check(draftText(input.status, 80) && !!input.status);
  const { status, pickup, destination, ...fields } = input;
  caseDraftInput(fields, 1);
  const selections = Object.fromEntries((["pickup", "destination"] as const).filter(target => target in input).map(target => [target, input[target] === null ? null : placeSelection(input[target])]));
  return { ...copyCaseDraft(fields), ...selections, status } as CaseEditable;
}
function warnings(value: unknown): MobileCaseCreated["warnings"] {
  check(Array.isArray(value) && value.length <= 100);
  return (value as unknown[]).map(item => {
    const v = draftObject(item); draftKeys(v, ["code", "field", "message"]);
    check(draftText(v.code, 200) && draftText(v.field, 200) && draftText(v.message, 5000));
    return { code: v.code as string, field: v.field as string, message: v.message as string };
  });
}
const scopeKeys = ["ok", "apiVersion", "environment", "profileId", "checkedAt"];
function receiptScope(value: Record<string, unknown>, port: DraftPort): MobileScope {
  check(port.acceptsScope(value));
  return { ok: true, apiVersion: 1, environment: value.environment as MobileScope["environment"], profileId: value.profileId as string, checkedAt: value.checkedAt as string };
}
export function caseCreatedDraft(value: unknown, port: DraftPort): MobileCaseCreated {
  const v = draftObject(value); draftKeys(v, [...scopeKeys, "caseId", "caseNumber", "warnings"]);
  const scope = receiptScope(v, port); check(draftId(v.caseId) && draftText(v.caseNumber, 160) && !!v.caseNumber);
  return { ...scope, caseId: v.caseId as string, caseNumber: v.caseNumber as string, warnings: warnings(v.warnings) };
}
export function caseUpdateCommand(value: unknown, base: { updatedAt: string; editable: MobileCaseDetailData["editable"] }, version = 2): MobileCaseUpdateInput {
  const v = draftObject(value); draftKeys(v, ["mutationId", "expectedUpdatedAt"], [...Object.keys(lengths), "priority", "jobTypes", "status", ...(version === 2 ? ["pickup", "destination"] : [])]);
  check(draftId(v.mutationId) && v.expectedUpdatedAt === base.updatedAt && draftDate(v.expectedUpdatedAt));
  const { mutationId, expectedUpdatedAt, status, ...fields } = v; caseDraftInput(fields, version);
  check(status === undefined || statuses.includes(status as string));
  check(Object.keys(fields).length > 0 || status !== undefined);
  return { ...copyCaseDraft(fields), mutationId, expectedUpdatedAt, ...(status === undefined ? {} : { status }) } as MobileCaseUpdateInput;
}
export function caseUpdatedDraft(value: unknown, caseId: string, pending: MobileCaseUpdateInput | null, port: DraftPort): MobileCaseUpdated {
  const v = draftObject(value); draftKeys(v, [...scopeKeys, "caseId", "mutationId", "committedRevision", "warnings", "refreshRequired"]);
  const scope = receiptScope(v, port); check(v.caseId === caseId && draftId(v.mutationId) && (!pending || v.mutationId === pending.mutationId)
    && draftDate(v.committedRevision) && v.refreshRequired === true);
  return { ...scope, caseId, mutationId: v.mutationId as string, committedRevision: v.committedRevision as string, warnings: warnings(v.warnings), refreshRequired: true };
}
export function noteCommandDraft(value: unknown): MobileCaseNoteInput {
  const v = draftObject(value); draftKeys(v, ["mutationId", "note"]);
  check(draftId(v.mutationId) && draftText(v.note, 10000) && !!v.note.trim() && v.note === v.note.trim());
  return { mutationId: v.mutationId as string, note: v.note as string };
}
export function noteReceiptDraft(value: unknown, caseId: string, pending: MobileCaseNoteInput, port: DraftPort): MobileCaseNoteAdded {
  const v = draftObject(value); draftKeys(v, [...scopeKeys, "caseId", "mutationId", "eventId", "warnings", "refreshRequired"]);
  const scope = receiptScope(v, port); check(v.caseId === caseId && v.mutationId === pending.mutationId && v.eventId === pending.mutationId && v.refreshRequired === true);
  return { ...scope, caseId, mutationId: pending.mutationId, eventId: pending.mutationId, warnings: warnings(v.warnings), refreshRequired: true };
}
