import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MobileCaseNoteAdded, MobileCaseNoteInput, MobileScope } from "@/lib/mobile-api";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";
import { isUuid } from "@/lib/telephony/uuid";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/mutation-error";
import { readMobileJsonBody } from "./body";

type Admin = SupabaseClient<Database>;
type Event = Database["public"]["Tables"]["motorist_case_events"]["Row"];
const SOURCE = "mobile_case_note_v1";
const unconfirmed = () => new MutationError("Výsledok poznámky sa nepodarilo potvrdiť. Overte tú istú požiadavku.", 503, "CASE_NOTE_UNCONFIRMED");
const mismatch = () => new MutationError("Identita poznámky už patrí inej požiadavke. Rozpracovaný text zostáva zachovaný.", 422, "CASE_NOTE_MUTATION_MISMATCH");
const object = (value: Json): Record<string, Json | undefined> => value && typeof value === "object" && !Array.isArray(value) ? value : {};

export function parseMobileCaseNote(value: unknown): MobileCaseNoteInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MutationError("Neplatná poznámka.", 400);
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => key !== "mutationId" && key !== "note") || typeof body.mutationId !== "string" || !isUuid(body.mutationId)
    || typeof body.note !== "string" || !body.note.trim() || body.note.length > 10_000 || body.note.includes("\0")) {
    throw new MutationError("Napíšte poznámku s najviac 10 000 znakmi a platnou identitou požiadavky.", 400);
  }
  return { mutationId: body.mutationId, note: body.note.trim() };
}
export async function readMobileCaseNote(request: Request) { return parseMobileCaseNote(await readMobileJsonBody(request)); }

export async function addMobileCaseNote(actor: MotoristActor, caseId: string, raw: MobileCaseNoteInput, signal?: AbortSignal,
  admin: Admin = createSupabaseAdminClient()): Promise<Omit<MobileCaseNoteAdded, keyof MobileScope>> {
  if (!isUuid(caseId)) throw new MutationError("Neplatný prípad.", 400);
  const input = parseMobileCaseNote(raw);
  const fingerprint = createHash("sha256").update(JSON.stringify([SOURCE, actor.organizationId, actor.profileId, caseId, input.note])).digest("hex");
  const deadline = AbortSignal.timeout(8_000), abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  async function existingEvent(): Promise<Event | null> {
    const { data, error } = await admin.from("motorist_case_events").select("*").eq("organization_id", actor.organizationId)
      .eq("id", input.mutationId).abortSignal(abort).maybeSingle();
    if (error) throw unconfirmed();
    return data;
  }
  function verify(event: Event | null): asserts event is Event {
    if (!event || event.organization_id !== actor.organizationId || event.actor_profile_id !== actor.profileId || event.case_id !== caseId
      || event.event_type !== "note_added" || event.body !== input.note || object(event.payload).source !== SOURCE || object(event.payload).fingerprint !== fingerprint) throw mismatch();
  }
  let event = await existingEvent();
  if (!event) {
    const existingCase = await admin.from("motorist_cases").select("id").eq("organization_id", actor.organizationId).eq("id", caseId).abortSignal(abort).maybeSingle();
    if (existingCase.error) throw unconfirmed();
    if (!existingCase.data) throw new MutationError("Prípad sa nenašiel.", 404);
    const result = await admin.from("motorist_case_events").insert({ id: input.mutationId, organization_id: actor.organizationId,
      case_id: caseId, actor_profile_id: actor.profileId, event_type: "note_added", title: "Poznámka", body: input.note,
      payload: { source: SOURCE, fingerprint } }).select("*").abortSignal(abort).single();
    if (result.error && result.error.code !== "23505") throw unconfirmed();
    event = result.error ? await existingEvent() : result.data;
  }
  verify(event);

  // The note event is committed. Audit trouble must never turn this into a
  // second note; a replay checks or repairs the same deterministic audit ID.
  const auditMatches = (audit: Database["public"]["Tables"]["motorist_audit_log"]["Row"] | null) => audit?.organization_id === actor.organizationId
    && audit.actor_profile_id === actor.profileId && audit.action === "case.note.add" && audit.entity_type === "motorist_cases"
    && audit.entity_id === caseId && audit.source === SOURCE && object(audit.after_payload).fingerprint === fingerprint;
  let audited = false;
  try {
    const prior = await admin.from("motorist_audit_log").select("*").eq("organization_id", actor.organizationId).eq("id", input.mutationId).abortSignal(abort).maybeSingle();
    if (!prior.error && prior.data) audited = auditMatches(prior.data);
    else if (!prior.error) {
      const result = await admin.from("motorist_audit_log").insert({ id: input.mutationId, organization_id: actor.organizationId,
        actor_profile_id: actor.profileId, action: "case.note.add", entity_type: "motorist_cases", entity_id: caseId, source: SOURCE,
        after_payload: { fingerprint, length: input.note.length } }).select("*").abortSignal(abort).single();
      if (!result.error) audited = auditMatches(result.data);
      else if (result.error.code === "23505") {
        const existing = await admin.from("motorist_audit_log").select("*").eq("organization_id", actor.organizationId).eq("id", input.mutationId).abortSignal(abort).maybeSingle();
        audited = !existing.error && auditMatches(existing.data);
      }
    }
  } catch {
    // SDK transport exceptions after the event commit have the same explicit
    // audit-incomplete receipt as a PostgREST failure.
    audited = false;
  }
  return { caseId, mutationId: input.mutationId, eventId: event.id, refreshRequired: true, warnings: audited ? []
    : [{ code: "case_note_audit_incomplete", field: "note", message: "Poznámka je uložená, ale audit sa nepodarilo potvrdiť. Nevkladajte ju znovu; overte tú istú požiadavku." }] };
}
