import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadDispatchData } from "@/data/dispatch-repository";
import type { CallerMatch, CallOutcome } from "@/data/dispatch-types";
import { cleanPhoneInput, sameDialNumber, TelephonyPhoneInputError } from "@/lib/telephony/phone";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";
import { getSupabaseServiceEnv } from "@/lib/supabase/env";

type AdminClient = SupabaseClient<Database>;
type Tables = Database["public"]["Tables"];
type AuditLogRow = Tables["motorist_audit_log"]["Row"];
type CallRow = Tables["motorist_calls"]["Row"];
type CallEventRow = Tables["motorist_call_events"]["Row"];
type CaseRow = Tables["motorist_cases"]["Row"];
type CaseEventRow = Tables["motorist_case_events"]["Row"];
type CaseTaskRow = Tables["motorist_case_tasks"]["Row"];
type OrganizationRow = Tables["motorist_organizations"]["Row"];
type ProfileRow = Tables["motorist_profiles"]["Row"];
type JsonRecord = Record<string, unknown>;

const DEFAULT_ORGANIZATION_SLUG = "pomoc-motoristom";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const outcomeLabels: Record<CallOutcome, string> = {
  reached: "Dovolané",
  not_reached: "Nedovolané",
  callback: "Zavolať naspäť",
  informational: "Informačný hovor",
  bad_contact: "Nesprávny kontakt",
  case_created: "Prípad vytvorený",
};

export class TelephonyWorkflowError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message);
    this.name = "TelephonyWorkflowError";
  }
}

export function isCallOutcome(value: unknown): value is CallOutcome {
  return typeof value === "string" && value in outcomeLabels;
}

export async function findCallerMatches(rawNumber: string): Promise<{ degraded: boolean; matches: CallerMatch[] }> {
  if (!rawNumber.trim()) {
    throw new TelephonyWorkflowError("Telefónne číslo je povinné.", 400);
  }

  try {
    cleanPhoneInput(rawNumber, "number");
  } catch (error) {
    if (error instanceof TelephonyPhoneInputError) {
      throw new TelephonyWorkflowError(error.message, 400);
    }

    throw error;
  }

  if (!getSupabaseServiceEnv()) {
    return { degraded: true, matches: [] };
  }

  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const organizationId = organization.id;
  const [contactsResult, casesResult, callsResult] = await Promise.all([
    supabase.from("motorist_contacts").select("*").eq("organization_id", organizationId).order("updated_at", { ascending: false }).limit(300),
    supabase.from("motorist_cases").select("*").eq("organization_id", organizationId).order("updated_at", { ascending: false }).limit(300),
    supabase.from("motorist_calls").select("*").eq("organization_id", organizationId).order("started_at", { ascending: false }).limit(120),
  ]);
  await Promise.all([throwOnResult(contactsResult), throwOnResult(casesResult), throwOnResult(callsResult)]);

  const contacts = contactsResult.data ?? [];
  const cases = casesResult.data ?? [];
  const calls = callsResult.data ?? [];
  const matchingContacts = contacts.filter((contact) => contact.phone && sameDialNumber(contact.phone, rawNumber));
  const matchingContactIds = new Set(matchingContacts.map((contact) => contact.id));
  const contactsById = new Map(contacts.map((contact) => [contact.id, contact]));
  const matches = new Map<string, CallerMatch>();

  matchingContacts.forEach((contact) => {
    addMatch(matches, {
      id: `contact:${contact.id}`,
      type: "contact",
      label: contact.name,
      subtitle: contact.role,
      phone: contact.phone ?? undefined,
      contactId: contact.id,
      updatedAt: contact.updated_at,
      confidence: "high",
    });
  });

  cases
    .filter((caseItem) => caseItem.contact_id && matchingContactIds.has(caseItem.contact_id))
    .forEach((caseItem) => {
      const contact = caseItem.contact_id ? contactsById.get(caseItem.contact_id) : undefined;
      addMatch(matches, {
        id: `case:${caseItem.id}`,
        type: isOpenCase(caseItem.status) ? "open_case" : "recent_case",
        label: `${caseItem.case_number} · ${caseItem.case_type}`,
        subtitle: caseItem.status,
        phone: contact?.phone ?? undefined,
        contactId: contact?.id,
        caseId: caseItem.id,
        caseNumber: caseItem.case_number,
        status: caseItem.status,
        updatedAt: caseItem.updated_at,
        confidence: isOpenCase(caseItem.status) ? "high" : "medium",
      });
    });

  calls
    .filter((call) => [call.caller_number, call.called_number, call.destination_number, call.received_number].some((number) => number && sameDialNumber(number, rawNumber)))
    .forEach((call) => {
      addMatch(matches, {
        id: `call:${call.id}`,
        type: "previous_call",
        label: call.case_id ? "Predošlý hovor s prípadom" : "Predošlý hovor",
        subtitle: call.status,
        phone: call.caller_number ?? call.called_number ?? call.destination_number ?? undefined,
        callId: call.id,
        caseId: call.case_id ?? undefined,
        status: call.status,
        updatedAt: call.started_at ?? call.created_at,
        confidence: call.case_id ? "medium" : "low",
      });
    });

  return {
    degraded: false,
    matches: [...matches.values()]
      .sort((left, right) => confidenceRank(right.confidence) - confidenceRank(left.confidence) || dateMs(right.updatedAt) - dateMs(left.updatedAt))
      .slice(0, 8),
  };
}

export async function linkCallToCase(callId: string, caseId: string) {
  ensureUuid(callId, "callId");
  ensureUuid(caseId, "caseId");

  ensureSupabaseServiceEnv();
  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const organizationId = organization.id;
  const [call, caseRow] = await Promise.all([getCall(supabase, organizationId, callId), getCase(supabase, organizationId, caseId)]);
  const actorId = await resolveDefaultOwnerId(supabase, organizationId);
  const now = new Date().toISOString();
  const latestPayload = {
    ...jsonRecord(call.raw_latest_payload),
    linkedCaseId: caseId,
    linkedAt: now,
    linkedBy: "dispatch_console",
  };

  await throwOnResult(
    supabase
      .from("motorist_calls")
      .update({
        case_id: caseId,
        raw_latest_payload: toJson(latestPayload),
      })
      .eq("organization_id", organizationId)
      .eq("id", callId),
  );
  await insertSingle<CallEventRow>(
    supabase
      .from("motorist_call_events")
      .insert({
        organization_id: organizationId,
        call_id: callId,
        provider: call.provider,
        provider_session_id: call.provider_session_id,
        event_type: "app.link_case",
        event_fingerprint: `app:link_case:${callId}:${caseId}:${now}`,
        payload: toJson({ call_id: callId, case_id: caseId }),
        raw_payload: toJson(latestPayload),
        normalized_payload: toJson({ call_id: callId, case_id: caseId }),
        handled_status: "processed",
        received_at: now,
      })
      .select("*")
      .single(),
  );
  await insertSingle<CaseEventRow>(
    supabase
      .from("motorist_case_events")
      .insert({
        organization_id: organizationId,
        case_id: caseId,
        actor_profile_id: actorId,
        event_type: "call_linked",
        title: "Hovor priradený k prípadu",
        body: `${call.caller_number ?? call.destination_number ?? "Neznáme číslo"} · ${caseRow.case_number}`,
        payload: toJson({ call_id: callId, caller_number: call.caller_number, status: call.status }),
      })
      .select("*")
      .single(),
  );
  await audit(supabase, organizationId, actorId, "call.link_case", "motorist_calls", callId, {
    call_id: callId,
    case_id: caseId,
    case_number: caseRow.case_number,
  });

  return loadDispatchData();
}

export async function setCallOutcome(
  callId: string,
  input: {
    outcome: unknown;
    note?: unknown;
    callbackMinutes?: unknown;
  },
) {
  ensureUuid(callId, "callId");

  if (!isCallOutcome(input.outcome)) {
    throw new TelephonyWorkflowError("Neplatný výsledok hovoru.", 400);
  }

  ensureSupabaseServiceEnv();
  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);
  const organizationId = organization.id;
  const call = await getCall(supabase, organizationId, callId);
  const actorId = call.operator_id ?? (await resolveDefaultOwnerId(supabase, organizationId));
  const now = new Date().toISOString();
  const note = readString(input.note);
  const callbackMinutes = cleanCallbackMinutes(input.callbackMinutes);
  const label = outcomeLabels[input.outcome];
  const latestPayload = {
    ...jsonRecord(call.raw_latest_payload),
    outcome: input.outcome,
    outcomeLabel: label,
    outcomeNote: note,
    callbackMinutes: input.outcome === "callback" ? callbackMinutes : undefined,
    outcomeAt: now,
    outcomeBy: "dispatch_console",
  };

  await throwOnResult(
    supabase
      .from("motorist_calls")
      .update({
        summary: note ? `${label}: ${note}` : label,
        raw_latest_payload: toJson(latestPayload),
      })
      .eq("organization_id", organizationId)
      .eq("id", callId),
  );
  await insertSingle<CallEventRow>(
    supabase
      .from("motorist_call_events")
      .insert({
        organization_id: organizationId,
        call_id: callId,
        provider: call.provider,
        provider_session_id: call.provider_session_id,
        event_type: "app.outcome",
        event_fingerprint: `app:outcome:${callId}:${input.outcome}:${now}`,
        payload: toJson({ call_id: callId, outcome: input.outcome, note }),
        raw_payload: toJson(latestPayload),
        normalized_payload: toJson({ call_id: callId, outcome: input.outcome }),
        handled_status: "processed",
        received_at: now,
      })
      .select("*")
      .single(),
  );

  if (call.case_id) {
    await insertSingle<CaseEventRow>(
      supabase
        .from("motorist_case_events")
        .insert({
          organization_id: organizationId,
          case_id: call.case_id,
          actor_profile_id: actorId,
          event_type: "call_outcome",
          title: `Výsledok hovoru: ${label}`,
          body: note ?? `${call.caller_number ?? call.destination_number ?? "Neznáme číslo"}`,
          payload: toJson({ call_id: callId, outcome: input.outcome, callback_minutes: callbackMinutes }),
        })
        .select("*")
        .single(),
    );

    if (input.outcome === "callback") {
      await createCallbackTaskIfNeeded(supabase, organizationId, call, actorId, callbackMinutes);
    }
  }

  await audit(supabase, organizationId, actorId, "call.outcome", "motorist_calls", callId, {
    call_id: callId,
    case_id: call.case_id,
    outcome: input.outcome,
    note,
  });

  return loadDispatchData();
}

async function createCallbackTaskIfNeeded(
  supabase: AdminClient,
  organizationId: string,
  call: CallRow,
  actorId: string | null,
  callbackMinutes: number,
) {
  if (!call.case_id) {
    return null;
  }

  const existing = await supabase
    .from("motorist_case_tasks")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("case_id", call.case_id)
    .eq("status", "open")
    .ilike("title", "Zavolať späť%")
    .limit(1)
    .maybeSingle();
  await throwOnResult(existing);

  if (existing.data) {
    return existing.data;
  }

  return insertSingle<CaseTaskRow>(
    supabase
      .from("motorist_case_tasks")
      .insert({
        organization_id: organizationId,
        case_id: call.case_id,
        title: `Zavolať späť: ${call.caller_number ?? call.destination_number ?? "neznáme číslo"}`,
        assigned_to: actorId,
        due_at: dueInMinutes(callbackMinutes),
        status: "open",
      })
      .select("*")
      .single(),
  );
}

async function resolveOrganization(supabase: AdminClient): Promise<OrganizationRow> {
  const organizationId = process.env.MOTORIST_ORGANIZATION_ID?.trim();
  const query = organizationId
    ? supabase.from("motorist_organizations").select("*").eq("id", organizationId).maybeSingle()
    : supabase
        .from("motorist_organizations")
        .select("*")
        .eq("slug", process.env.MOTORIST_ORGANIZATION_SLUG?.trim() || DEFAULT_ORGANIZATION_SLUG)
        .maybeSingle();
  const result = await query;
  await throwOnResult(result);

  if (!result.data?.active) {
    throw new TelephonyWorkflowError("Aktívna organizácia sa nenašla.", 404);
  }

  return result.data;
}

async function resolveDefaultOwnerId(supabase: AdminClient, organizationId: string) {
  const result = await supabase
    .from("motorist_profiles")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("active", true)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  await throwOnResult(result);
  return (result.data as ProfileRow | null)?.id ?? null;
}

async function getCall(supabase: AdminClient, organizationId: string, callId: string): Promise<CallRow> {
  const result = await supabase.from("motorist_calls").select("*").eq("organization_id", organizationId).eq("id", callId).maybeSingle();
  await throwOnResult(result);

  if (!result.data) {
    throw new TelephonyWorkflowError("Hovor sa nenašiel.", 404);
  }

  return result.data;
}

async function getCase(supabase: AdminClient, organizationId: string, caseId: string): Promise<CaseRow> {
  const result = await supabase.from("motorist_cases").select("*").eq("organization_id", organizationId).eq("id", caseId).maybeSingle();
  await throwOnResult(result);

  if (!result.data) {
    throw new TelephonyWorkflowError("Prípad sa nenašiel.", 404);
  }

  return result.data;
}

async function throwOnResult(result: PromiseLike<{ error: { message: string } | null }> | { error: { message: string } | null }) {
  const resolved = await result;
  if (resolved.error) {
    throw new TelephonyWorkflowError(resolved.error.message);
  }
}

async function insertSingle<Row>(query: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<Row> {
  const result = await query;
  if (result.error) {
    throw new TelephonyWorkflowError(result.error.message);
  }
  if (!result.data) {
    throw new TelephonyWorkflowError("Supabase nevrátil vytvorený záznam.");
  }
  return result.data as Row;
}

async function audit(
  supabase: AdminClient,
  organizationId: string,
  actorProfileId: string | null,
  action: string,
  entityType: string,
  entityId: string,
  payload: Json,
) {
  await insertSingle<AuditLogRow>(
    supabase
      .from("motorist_audit_log")
      .insert({
        organization_id: organizationId,
        actor_profile_id: actorProfileId,
        action,
        entity_type: entityType,
        entity_id: entityId,
        source: "dispatch_console",
        after_payload: payload,
      })
      .select("*")
      .single(),
  );
}

function addMatch(matches: Map<string, CallerMatch>, match: CallerMatch) {
  if (!matches.has(match.id)) {
    matches.set(match.id, match);
  }
}

function ensureSupabaseServiceEnv() {
  if (!getSupabaseServiceEnv()) {
    throw new TelephonyWorkflowError("Supabase service env nie je nastavený.", 503);
  }
}

function isOpenCase(status: CaseRow["status"]) {
  return !["completed_assisted", "completed_no_assistance", "rejected", "cancelled", "futile_trip"].includes(status);
}

function cleanCallbackMinutes(value: unknown) {
  const minutes = Number(value ?? 30);
  return Number.isFinite(minutes) ? Math.min(1440, Math.max(5, Math.round(minutes))) : 30;
}

function dueInMinutes(minutes: number) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function confidenceRank(confidence: CallerMatch["confidence"]) {
  return confidence === "high" ? 3 : confidence === "medium" ? 2 : 1;
}

function dateMs(value?: string) {
  return value ? new Date(value).getTime() || 0 : 0;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function ensureUuid(value: unknown, label: string) {
  if (!nonEmpty(value)) {
    throw new TelephonyWorkflowError(`${label} je povinné.`, 400);
  }

  if (!uuidPattern.test(value.trim())) {
    throw new TelephonyWorkflowError(`${label} musí byť UUID.`, 400);
  }
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function jsonRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}
