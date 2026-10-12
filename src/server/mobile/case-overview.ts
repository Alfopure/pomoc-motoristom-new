import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MobileCaseOverview } from "@/lib/mobile-api";
import { MOBILE_CLOSED_CASE_STATUSES } from "@/lib/mobile-case-filters";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/mutation-error";

/** Independent observations: concurrent case changes can affect each count separately. */
export async function getMobileCaseOverview(
  actor: MotoristActor,
  signal?: AbortSignal,
  admin: SupabaseClient<Database> = createSupabaseAdminClient(),
): Promise<MobileCaseOverview["counts"]> {
  const deadline = AbortSignal.timeout(8_000);
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const open = () => {
    let read = admin.from("motorist_cases").select("id", { count: "exact", head: true })
      .eq("organization_id", actor.organizationId).abortSignal(abort);
    for (const status of MOBILE_CLOSED_CASE_STATUSES) read = read.neq("status", status);
    return read;
  };
  const results = await Promise.all([
    open(),
    open().eq("owner_id", actor.profileId),
    open().is("owner_id", null),
    open().eq("priority", "urgent"),
  ]);
  const counts = results.map(result => {
    if (
      abort.aborted || result.error || typeof result.count !== "number"
      || !Number.isSafeInteger(result.count) || result.count < 0
    ) {
      throw new MutationError("Prehľad prípadov sa nepodarilo načítať.", 503);
    }
    return result.count;
  });
  return { open: counts[0], mine: counts[1], unassigned: counts[2], urgent: counts[3] };
}
