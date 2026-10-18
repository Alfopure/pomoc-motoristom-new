import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CallOutcome } from "@/data/dispatch-types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import { caseStatusLabels, isClosedCaseStatus, isMobileCaseStatus } from "@/lib/mobile-case-filters";
import { MOBILE_CALL_NOTE_LIMIT, MOBILE_CALL_OUTCOMES, type MobileCallCaseInput, type MobileCallCaseSuggestion, type MobileCallOutcome, type MobileCallOutcomeInput, type MobileCallWrapUp } from "@/lib/mobile-call-wrap-up";
import type { MobileDraftScope } from "@/lib/mobile-api";
import { isUuid } from "@/lib/telephony/uuid";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/mutation-error";
import { taskWorkspaceSystemEnabled } from "@/server/task-system-gate";
import { findCallerMatches, recordCallCaseLink, recordCallOutcome, TelephonyWorkflowError } from "@/server/telephony-workflow";
import { telephonyStabilityEnabled } from "@/server/telephony/stability";

// The mobile list must stay the web's outcome set in both directions.
const sameOutcomes: [CallOutcome, MobileCallOutcome] extends [MobileCallOutcome, CallOutcome] ? true : never = true;
void sameOutcomes;
type Admin = SupabaseClient<Database>;
type WrapUpBody = Omit<MobileCallWrapUp, keyof MobileDraftScope>;
const labels = new Map(MOBILE_CALL_OUTCOMES.map(item => [item.value, item.label]));
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
function unavailable(): never { throw new MutationError("Údaje hovoru sa nepodarilo overiť.", 503); }
function text(value: unknown, max: number, multiline = false): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, "").trim();
  const bounded = clean.slice(0, max).replace(/[\ud800-\udbff]$/, "");
  return bounded || null;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** A SIP address or malformed stored endpoint is not a customer number. */
function customerNumber(direction: string, row: { caller_number: string | null; called_number: string | null; destination_number: string | null }): string | null {
  if (direction === "internal") return null;
  const value = direction === "outbound" ? row.destination_number || row.called_number : row.caller_number;
  if (typeof value !== "string" || value.length > 80) return null;
  const result = value.trim();
  return /^\+?[0-9][0-9 ()-]{1,78}[0-9]$/.test(result) ? result : null;
}
/** Workflow messages below 500 are user-facing Slovak text; other failures stay generic. */
async function workflow<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) {
    if (error instanceof TelephonyWorkflowError && /callback number unknown/.test(error.message)) {
      throw new MutationError("Na číslo tohto hovoru sa spätné volanie nedá naplánovať.", 409, "callback_scheduling_unavailable");
    }
    if (error instanceof TelephonyWorkflowError) throw new MutationError(error.status < 500 ? error.message : "Zápis hovoru sa nepodarilo dokončiť.", error.status < 500 ? error.status : 503);
    throw error;
  }
}

export function parseCallId(value: string): string {
  if (!isUuid(value)) throw new MutationError("Hovor sa nenašiel.", 404);
  return value.toLowerCase();
}

async function readCall(admin: Admin, actor: MotoristActor, callId: string) {
  const { data, error } = await admin.from("motorist_calls")
    .select("id,organization_id,direction,caller_number,called_number,destination_number,case_id,raw_latest_payload")
    .eq("organization_id", actor.organizationId).eq("id", callId).maybeSingle();
  if (error) return unavailable();
  if (!data || data.organization_id !== actor.organizationId) throw new MutationError("Hovor sa nenašiel.", 404);
  return data;
}

type CallRow = Awaited<ReturnType<typeof readCall>>;
/** Mirrors motorist_callback_number on the number motorist_schedule_callback_v1 reads. */
function queueNumber(call: CallRow): boolean {
  if (call.direction === "internal") return false;
  const raw = call.direction === "outbound" ? call.destination_number ?? call.called_number : call.caller_number;
  const digits = (raw ?? "").replace(/[^0-9]/g, "").replace(/^00/, "");
  return digits.length >= 8 && digits.length <= 15;
}
async function callbackScheduling(admin: Admin, organizationId: string, call: CallRow): Promise<MobileCallWrapUp["callbackScheduling"]> {
  if (telephonyStabilityEnabled() || await taskWorkspaceSystemEnabled(admin, organizationId)) return queueNumber(call) ? "queue" : "unavailable";
  return call.case_id ? "case_task" : "unavailable";
}

async function suggestions(admin: Admin, actor: MotoristActor, number: string | null, linkedCaseId: string | null): Promise<{ items: MobileCallCaseSuggestion[]; available: boolean }> {
  if (!number) return { items: [], available: true };
  let result: Awaited<ReturnType<typeof findCallerMatches>>;
  try { result = await findCallerMatches(number, { organizationId: actor.organizationId }); }
  catch { return { items: [], available: false }; }
  if (result.degraded) return { items: [], available: false };
  const contactNames = new Map(result.matches.filter(item => item.type === "contact" && item.contactId).map(item => [item.contactId!, text(item.label, 200)]));
  const candidates = new Map<string, { reason: MobileCallCaseSuggestion["reason"]; contactName: string | null }>();
  for (const item of result.matches) {
    const caseId = item.caseId?.toLowerCase();
    if (!caseId || !isUuid(caseId) || caseId === linkedCaseId || candidates.has(caseId)) continue;
    if (item.type === "open_case" || item.type === "recent_case") candidates.set(caseId, { reason: "contact", contactName: item.contactId ? contactNames.get(item.contactId) ?? null : null });
    else if (item.type === "previous_call") candidates.set(caseId, { reason: "previous_call", contactName: null });
  }
  const ids = [...candidates.keys()].slice(0, 8);
  if (!ids.length) return { items: [], available: true };
  // Current case rows, not the matcher's labels: status and number must be live.
  const { data, error } = await admin.from("motorist_cases").select("id,organization_id,case_number,status,updated_at")
    .eq("organization_id", actor.organizationId).in("id", ids);
  if (error) return { items: [], available: false };
  const rows = new Map((data ?? []).filter(row => row.organization_id === actor.organizationId).map(row => [row.id.toLowerCase(), row]));
  const items = ids.flatMap(id => {
    const row = rows.get(id), meta = candidates.get(id)!, caseNumber = text(row?.case_number, 120);
    if (!row || !caseNumber || !isMobileCaseStatus(row.status)) return [];
    return [{ caseId: id, caseNumber, statusLabel: caseStatusLabels[row.status], open: !isClosedCaseStatus(row.status), contactName: meta.contactName, reason: meta.reason }];
  });
  return { items: items.sort((a, b) => Number(b.open) - Number(a.open)).slice(0, 5), available: true };
}

export async function getMobileCallWrapUp(actor: MotoristActor, id: string, admin: Admin = createSupabaseAdminClient()): Promise<WrapUpBody> {
  const callId = parseCallId(id);
  const call = await readCall(admin, actor, callId);
  const linkedCaseId = call.case_id && isUuid(call.case_id) ? call.case_id.toLowerCase() : null;
  const number = customerNumber(call.direction, call);
  const [caseRow, scheduling, matched] = await Promise.all([
    linkedCaseId ? admin.from("motorist_cases").select("id,organization_id,case_number,status").eq("organization_id", actor.organizationId).eq("id", linkedCaseId).maybeSingle() : null,
    callbackScheduling(admin, actor.organizationId, call),
    suggestions(admin, actor, number, linkedCaseId),
  ]);
  if (caseRow?.error) return unavailable();
  const caseNumber = text(caseRow?.data?.case_number, 120);
  const linkedCase = caseRow?.data && caseNumber && isMobileCaseStatus(caseRow.data.status)
    ? { id: linkedCaseId!, caseNumber, statusLabel: caseStatusLabels[caseRow.data.status] } : null;
  const payload = record(call.raw_latest_payload);
  const value = typeof payload.outcome === "string" && labels.has(payload.outcome as MobileCallOutcome) ? payload.outcome as MobileCallOutcome : null;
  const minutes = payload.callbackMinutes;
  const at = typeof payload.outcomeAt === "string" && Number.isFinite(Date.parse(payload.outcomeAt)) ? new Date(payload.outcomeAt).toISOString() : null;
  return {
    callId, number, linkedCaseId, linkedCase,
    outcome: value ? { value, label: labels.get(value)!, note: text(payload.outcomeNote, MOBILE_CALL_NOTE_LIMIT, true),
      callbackMinutes: value === "callback" && Number.isSafeInteger(minutes) && (minutes as number) > 0 ? minutes as number : null, at } : null,
    callbackScheduling: scheduling, suggestions: matched.items, matchesAvailable: matched.available,
  };
}

export function parseCallOutcome(value: unknown): MobileCallOutcomeInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MutationError("Neplatný výsledok hovoru.", 400);
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !["mutationId", "outcome", "note", "callbackMinutes"].includes(key))
    || typeof body.mutationId !== "string" || !isUuid(body.mutationId)
    || typeof body.outcome !== "string" || !labels.has(body.outcome as MobileCallOutcome)) throw new MutationError("Neplatný výsledok hovoru.", 400);
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") throw new MutationError("Neplatná poznámka.", 400);
  const note = typeof body.note === "string" ? body.note.trim() : "";
  if (note.length > MOBILE_CALL_NOTE_LIMIT) throw new MutationError(`Poznámka môže mať najviac ${MOBILE_CALL_NOTE_LIMIT} znakov.`, 400);
  if (CONTROL.test(note)) throw new MutationError("Neplatná poznámka.", 400);
  const minutes = body.callbackMinutes ?? null;
  if (body.outcome === "callback" ? !(Number.isSafeInteger(minutes) && (minutes as number) >= 5 && (minutes as number) <= 1440) : minutes !== null) {
    throw new MutationError("Zvoľte, o koľko minút treba zavolať naspäť.", 400);
  }
  return { mutationId: body.mutationId.toLowerCase(), outcome: body.outcome as MobileCallOutcome, note: note || null, callbackMinutes: minutes as number | null };
}

export async function saveMobileCallOutcome(actor: MotoristActor, id: string, input: MobileCallOutcomeInput, admin: Admin = createSupabaseAdminClient()) {
  const callId = parseCallId(id);
  if (input.outcome === "callback") {
    const call = await readCall(admin, actor, callId);
    const prior = record(call.raw_latest_payload).outcomeMutationId === input.mutationId;
    // Without the queue or a case nothing would remind anybody; say so instead of storing an empty promise.
    if (!prior && await callbackScheduling(admin, actor.organizationId, call) === "unavailable") {
      throw new MutationError(queueNumber(call) ? "Spätné volanie sa bez prípadu nedá naplánovať. Najprv priraďte hovor k prípadu."
        : "Na číslo tohto hovoru sa spätné volanie nedá naplánovať.", 409, "callback_scheduling_unavailable");
    }
  }
  const result = await workflow(() => recordCallOutcome(callId, {
    outcome: input.outcome, note: input.note ?? undefined, callbackMinutes: input.callbackMinutes ?? undefined, callbackActionId: input.mutationId,
  }, { profileId: actor.profileId, organizationId: actor.organizationId }, { mutationId: input.mutationId, source: "mobile_app" }));
  return { callId, mutationId: input.mutationId, replayed: result.replayed };
}

export function parseCallCase(value: unknown): MobileCallCaseInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MutationError("Neplatné priradenie hovoru.", 400);
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== 2 || typeof body.caseId !== "string" || !isUuid(body.caseId)
    || !Object.hasOwn(body, "expectedCaseId") || body.expectedCaseId !== null && (typeof body.expectedCaseId !== "string" || !isUuid(body.expectedCaseId))) {
    throw new MutationError("Neplatné priradenie hovoru.", 400);
  }
  return { caseId: body.caseId.toLowerCase(), expectedCaseId: typeof body.expectedCaseId === "string" ? body.expectedCaseId.toLowerCase() : null };
}

export async function linkMobileCallCase(actor: MotoristActor, id: string, input: MobileCallCaseInput) {
  const callId = parseCallId(id);
  const result = await workflow(() => recordCallCaseLink(callId, input.caseId, {
    actor: { profileId: actor.profileId, organizationId: actor.organizationId }, expectedCaseId: input.expectedCaseId, source: "mobile_app",
  }));
  return { callId, caseId: input.caseId, changed: result.changed };
}
