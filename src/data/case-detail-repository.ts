import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/mutation-error";
import { mapCase } from "./dispatch-repository";
import type { CaseDetailData } from "./case-detail";

export async function loadCaseDetail(caseId: string, actor: Pick<MotoristActor, "organizationId" | "profileId">, signal?: AbortSignal,
  client: SupabaseClient<Database> = createSupabaseAdminClient()): Promise<CaseDetailData> {
  if (!/^[0-9a-f-]{36}$/i.test(caseId)) throw new MutationError("Neplatný prípad.", 400);
  const deadline = AbortSignal.timeout(8_000);
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const scope = <T extends keyof Database["public"]["Tables"]>(table: T) => client.from(table).select("*").eq("organization_id" as never, actor.organizationId as never).abortSignal(abort);
  // A concurrent card commit between dependency reads invalidates this snapshot.
  for (let attempt = 0; attempt < 2; attempt++) {
    const [caseResult, events, submissions] = await Promise.all([
      scope("motorist_cases").eq("id", caseId).maybeSingle(),
      scope("motorist_case_events").eq("case_id", caseId).order("created_at", { ascending: false }).limit(200),
      scope("motorist_location_submissions").eq("case_id", caseId).eq("accepted", true).order("submitted_at", { ascending: false }).limit(1),
    ]);
    if (caseResult.error || events.error || submissions.error) throw new MutationError("Prípad sa nepodarilo načítať.", 503);
    const row = caseResult.data;
    if (!row) throw new MutationError("Prípad sa nenašiel.", 404);
    const submission = submissions.data?.[0];
    const locationIds = [row.pickup_location_id, row.destination_location_id, submission?.location_id].filter((id): id is string => Boolean(id));
    const profileIds = [row.owner_id, ...(events.data ?? []).map(event => event.actor_profile_id)].filter((id): id is string => Boolean(id));
    const [contact, vehicle, locations, profiles] = await Promise.all([
      row.contact_id ? scope("motorist_contacts").eq("id", row.contact_id) : { data: [], error: null },
      row.vehicle_id ? scope("motorist_vehicles").eq("id", row.vehicle_id) : { data: [], error: null },
      locationIds.length ? scope("motorist_locations").in("id", locationIds) : { data: [], error: null },
      profileIds.length ? scope("motorist_profiles").in("id", [...new Set(profileIds)]) : { data: [], error: null },
    ]);
    if (contact.error || vehicle.error || locations.error || profiles.error) throw new MutationError("Súvisiace údaje sa nepodarilo načítať.", 503);
    const verified = await scope("motorist_cases").eq("id", caseId).maybeSingle();
    if (verified.error) throw new MutationError("Revíziu prípadu sa nepodarilo overiť.", 503);
    if (!verified.data) throw new MutationError("Prípad sa nenašiel.", 404);
    if (verified.data.updated_at !== row.updated_at) continue;
    const detail = mapCase({ caseRow: row,
      contactsById: new Map((contact.data ?? []).map(item => [item.id, item])),
      vehiclesById: new Map((vehicle.data ?? []).map(item => [item.id, item])),
      locationById: new Map((locations.data ?? []).map(item => [item.id, item])),
      profilesById: new Map((profiles.data ?? []).map(item => [item.id, item])),
      events: events.data ?? [], tasks: [], customerLocationSubmission: submission,
    });
    Reflect.deleteProperty(detail, "tasks");
    return detail;
  }
  throw new MutationError("Prípad sa počas načítania zmenil. Skúste obnoviť znovu.", 503);
}
