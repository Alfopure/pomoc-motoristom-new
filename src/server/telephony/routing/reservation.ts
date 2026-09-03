import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, OperatorPresenceStatus } from "@/lib/supabase/database.types";

/**
 * Atomic operator reservation (design §2.6): on an operator leg's
 * `call.answered` exactly one session may move the operator to `on_call`.
 * The RPC performs the compare-and-set on `motorist_operator_presence`.
 */

type AdminClient = SupabaseClient<Database>;

export class ReservationError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ReservationError";
  }
}

export async function reserveOperator(admin: AdminClient, input: { profileId: string; sessionId: string }): Promise<boolean> {
  const { data, error } = await admin.rpc("motorist_reserve_operator", { p_profile_id: input.profileId, p_session_id: input.sessionId });
  if (error) throw new ReservationError(`motorist_reserve_operator failed: ${error.message}`, error);
  return data === true;
}

/**
 * Releases a reservation held for `sessionId` (no-op when the operator has
 * meanwhile been reserved by another session). `status` is the presence the
 * operator returns to; `wrapUpUntil` is set for `after_call_work`.
 */
export async function releaseOperator(
  admin: AdminClient,
  input: { profileId: string; sessionId: string; status: OperatorPresenceStatus; wrapUpUntil?: string | null; now?: Date },
): Promise<boolean> {
  const now = (input.now ?? new Date()).toISOString();
  const { data, error } = await admin
    .from("motorist_operator_presence")
    .update({
      status: input.status,
      current_session_id: null,
      wrap_up_until: input.status === "after_call_work" ? (input.wrapUpUntil ?? null) : null,
      status_since: now,
    })
    .eq("profile_id", input.profileId)
    .eq("current_session_id", input.sessionId)
    .select("id");
  if (error) throw new ReservationError(`release failed: ${error.message}`, error);
  return (data ?? []).length > 0;
}
