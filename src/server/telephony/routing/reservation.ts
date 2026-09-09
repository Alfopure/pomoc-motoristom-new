import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, OperatorPresenceStatus } from "@/lib/supabase/database.types";
import { telephonyStabilityEnabled } from "../stability";

type PresenceRow = Database["public"]["Tables"]["motorist_operator_presence"]["Row"];

export type PresenceTransitionInput = {
  organizationId: string;
  profileId: string;
  action: "acquire" | "manual" | "dispatch" | "answer" | "pickup" | "release" | "end_wrap_up";
  sessionId?: string | null;
  expectedRevision?: number | null;
  expectedToken?: string | null;
  status?: OperatorPresenceStatus;
  pauseReasonId?: string | null;
  wrapUpUntil?: string | null;
  reason?: string | null;
  source?: string;
};

export type PresenceTransitionResult = { applied: boolean; reused?: boolean; cancellationSessionId?: string | null; revision?: number; offerToken?: string | null; presence?: PresenceRow; reason?: string };

/** Server-only RPC. Authorization is taken from the authenticated server actor. */
export async function transitionPresence(admin: AdminClient, input: PresenceTransitionInput): Promise<PresenceTransitionResult> {
  const { data, error } = await admin.rpc("motorist_presence_transition_v1", {
    p_organization_id: input.organizationId, p_profile_id: input.profileId, p_action: input.action,
    p_session_id: input.sessionId ?? null, p_expected_revision: input.expectedRevision ?? null,
    p_expected_token: input.expectedToken ?? null, p_status: input.status ?? null,
    p_pause_reason_id: input.pauseReasonId ?? null, p_wrap_up_until: input.wrapUpUntil ?? null,
    p_reason: input.reason ?? null, p_source: input.source ?? "telephony",
  });
  if (error) throw new ReservationError(`presence transition failed: ${error.message}`, error);
  if (!data || typeof data !== "object" || Array.isArray(data) || typeof data.applied !== "boolean") throw new ReservationError("Invalid presence transition result");
  return data as PresenceTransitionResult;
}

/** Ordinary outbound/supervision acquisition; token is returned by the same transaction. */
export async function reserveOperatorOwnership(admin: AdminClient, input: { organizationId: string; profileId: string; sessionId: string }): Promise<PresenceTransitionResult> {
  const current = await admin.from("motorist_operator_presence").select("*").eq("organization_id", input.organizationId).eq("profile_id", input.profileId).maybeSingle();
  if (current.error) throw new ReservationError(`reservation read failed: ${current.error.message}`, current.error);
  if (telephonyStabilityEnabled() || current.data?.presence_revision !== undefined || current.data?.offer_token || current.data?.pause_return) {
    return transitionPresence(admin, { ...input, action: "acquire", expectedRevision: current.data?.presence_revision });
  }
  return { applied: await reserveOperator(admin, { profileId: input.profileId, sessionId: input.sessionId }) };
}

export function authorizeOperatorDispatch(admin: AdminClient, input: Omit<PresenceTransitionInput, "action">): Promise<PresenceTransitionResult> {
  return transitionPresence(admin, { ...input, action: "dispatch" });
}

export function reserveOperatorPickup(admin: AdminClient, input: Omit<PresenceTransitionInput, "action">): Promise<PresenceTransitionResult> {
  return transitionPresence(admin, { ...input, action: "pickup" });
}

export function releaseOperatorPresence(admin: AdminClient, input: Omit<PresenceTransitionInput, "action">): Promise<PresenceTransitionResult> {
  return transitionPresence(admin, { ...input, action: "release" });
}

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

export async function reserveOperator(admin: AdminClient, input: { profileId: string; sessionId: string; organizationId?: string; expectedToken?: string; expectedRevision?: number }): Promise<boolean> {
  if (input.organizationId && (telephonyStabilityEnabled() || input.expectedToken)) {
    return (await transitionPresence(admin, { ...input, organizationId: input.organizationId, action: "answer" })).applied;
  }
  const { data, error } = await admin.rpc("motorist_reserve_operator", { p_profile_id: input.profileId, p_session_id: input.sessionId });
  if (error) throw new ReservationError(`motorist_reserve_operator failed: ${error.message}`, error);
  return data === true;
}

/**
 * Answer compatibility legs against the installed DB contract. The boolean
 * legacy RPC may create an offer token, so callers that create ownership must
 * receive that token and attach it to the exact answering leg.
 */
export async function reserveAnsweredOperator(
  admin: AdminClient,
  input: { organizationId: string; profileId: string; sessionId: string; expectedToken?: string },
): Promise<PresenceTransitionResult> {
  const current = await admin.from("motorist_operator_presence").select("*")
    .eq("organization_id", input.organizationId).eq("profile_id", input.profileId).maybeSingle();
  if (current.error) throw new ReservationError(`answer ownership read failed: ${current.error.message}`, current.error);
  if (!current.data) return { applied: false, reason: "no_presence" };
  if (telephonyStabilityEnabled() || current.data.presence_revision !== undefined || current.data.offer_token || current.data.pause_return) {
    // Never let a historical tokenless answer borrow a newer same-session offer.
    if (current.data.offer_token && !input.expectedToken) return { applied: false, reason: "not_owner" };
    return transitionPresence(admin, { ...input,
      action: current.data.current_session_id ? "answer" : "acquire",
      expectedRevision: current.data.presence_revision,
    });
  }
  return { applied: await reserveOperator(admin, input) };
}

/**
 * Releases a reservation held for `sessionId` (no-op when the operator has
 * meanwhile been reserved by another session). `status` is the presence the
 * operator returns to; `wrapUpUntil` is set for `after_call_work`.
 */
export async function releaseOperator(
  admin: AdminClient,
  input: { profileId: string; sessionId: string; status: OperatorPresenceStatus; wrapUpUntil?: string | null; now?: Date; organizationId?: string; expectedToken?: string; expectedRevision?: number },
): Promise<boolean> {
  // Read existing ownership even with admission disabled: rollback may not drop
  // an in-flight paused pickup's durable return context.
  const current = await admin.from("motorist_operator_presence").select("*").eq("profile_id", input.profileId).maybeSingle();
  if (current.error) throw new ReservationError(`release read failed: ${current.error.message}`, current.error);
  if (current.data && (telephonyStabilityEnabled() || current.data.offer_token || current.data.pause_return)) {
    if (current.data.offer_token && !input.expectedToken) return false;
    return (await releaseOperatorPresence(admin, { ...input, organizationId: input.organizationId ?? current.data.organization_id,
      expectedToken: input.expectedToken, expectedRevision: input.expectedRevision })).applied;
  }
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
