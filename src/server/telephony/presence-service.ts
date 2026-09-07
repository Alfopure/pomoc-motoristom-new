import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, OperatorPresenceStatus } from "@/lib/supabase/database.types";
import { transitionPresence } from "./routing/reservation";
import { telephonyStabilityEnabled } from "./stability";
export { effectivePresenceStatus, effectivePresenceSince } from "@/lib/telephony/presence-policy";

import { appendPresenceHistory } from "./state/effects";
import type { PresenceRow } from "./state/types";
import { PresenceServiceError } from "./service-errors";

export { PresenceServiceError } from "./service-errors";

/**
 * Operator presence (`motorist_operator_presence`) with history mirrored into
 * `motorist_operator_statuses` (design §5). Manual changes come from the
 * presence routes; automatic ones (ringing, on_call, after_call_work) are
 * written by the effects layer and the reservation RPC.
 */

type AdminClient = SupabaseClient<Database>;

export type PresenceDeps = { admin: AdminClient; now?: () => Date; onOfferCancelled?: (sessionId: string) => Promise<void> };

export type ManualPresenceStatus = Extract<OperatorPresenceStatus, "available" | "paused" | "offline">;

export const MANUAL_PRESENCE_STATUSES: ReadonlySet<string> = new Set<ManualPresenceStatus>(["available", "paused", "offline"]);

function nowOf(deps: PresenceDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

export function isManualPresenceStatus(value: unknown): value is ManualPresenceStatus {
  return typeof value === "string" && MANUAL_PRESENCE_STATUSES.has(value);
}

export async function getPresence(deps: PresenceDeps, input: { organizationId: string; profileId: string }): Promise<PresenceRow | null> {
  const { data, error } = await deps.admin.from("motorist_operator_presence").select("*").eq("organization_id", input.organizationId).eq("profile_id", input.profileId).maybeSingle();
  if (error) throw new PresenceServiceError(`Prezenciu sa nepodarilo načítať: ${error.message}`, 500);
  return data;
}

export async function listPresence(deps: PresenceDeps, organizationId: string): Promise<PresenceRow[]> {
  const { data, error } = await deps.admin.from("motorist_operator_presence").select("*").eq("organization_id", organizationId);
  if (error) throw new PresenceServiceError(`Prezenciu sa nepodarilo načítať: ${error.message}`, 500);
  return data ?? [];
}

async function ensurePresenceRow(deps: PresenceDeps, input: { organizationId: string; profileId: string }): Promise<PresenceRow> {
  const existing = await getPresence(deps, input);
  if (existing) return existing;
  const inserted = await deps.admin
    .from("motorist_operator_presence")
    .insert({ organization_id: input.organizationId, profile_id: input.profileId, status: "offline", status_since: nowOf(deps).toISOString() })
    .select("*")
    .single();
  if (inserted.error) {
    if (inserted.error.code === "23505") {
      const again = await getPresence(deps, input);
      if (again) return again;
    }
    throw new PresenceServiceError(`Prezenciu sa nepodarilo vytvoriť: ${inserted.error.message}`, 500);
  }
  return inserted.data;
}

export type SetPresenceInput = {
  organizationId: string;
  profileId: string;
  status: ManualPresenceStatus;
  pauseReasonId?: string | null;
  reason?: string | null;
  /** History `source` column (`dispatch_console`, `api`, `heartbeat`…). */
  source?: string;
};

/**
 * Manual presence change. Refused while the operator is on a call (the call
 * flow owns the row then); allowed while ringing (declining an offer), in
 * which case the stale session pointer is cleared so future reservations
 * are not blocked.
 */
export async function setPresence(deps: PresenceDeps, input: SetPresenceInput): Promise<PresenceRow> {
  if (!isManualPresenceStatus(input.status)) throw new PresenceServiceError("Neplatný stav prezencie.", 400);
  const current = await ensurePresenceRow(deps, input);
  if (current.status === "on_call" && current.current_session_id) {
    throw new PresenceServiceError("Počas hovoru nie je možné zmeniť stav.", 409);
  }

  let reasonLabel: string | null = input.reason ?? null;
  let pauseReasonId: string | null = null;
  if (input.status === "paused" && input.pauseReasonId) {
    const reason = await deps.admin
      .from("motorist_pause_reasons")
      .select("id, code, label, active")
      .eq("organization_id", input.organizationId)
      .eq("id", input.pauseReasonId)
      .maybeSingle();
    if (reason.error) throw new PresenceServiceError(`Dôvod pauzy sa nepodarilo overiť: ${reason.error.message}`, 500);
    if (!reason.data || !reason.data.active) throw new PresenceServiceError("Neplatný dôvod pauzy.", 400);
    pauseReasonId = reason.data.id;
    reasonLabel = reasonLabel ?? reason.data.label;
  }

  const now = nowOf(deps);
  const unchanged = current.status === input.status && (current.pause_reason_id ?? null) === pauseReasonId && !current.current_session_id;
  if (unchanged) return current;

  if (telephonyStabilityEnabled() || current.offer_token || current.pause_return) {
    const result = await transitionPresence(deps.admin, { ...input, action: "manual", pauseReasonId,
      expectedRevision: current.presence_revision, reason: reasonLabel, source: input.source ?? "dispatch_console" });
    if (!result.applied || !result.presence) throw new PresenceServiceError("Stav sa medzičasom zmenil. Obnovte prezenciu.", 409);
    if (result.cancellationSessionId && deps.onOfferCancelled) {
      try { await deps.onOfferCancelled(result.cancellationSessionId); } catch { /* Durable cancellation remains due for cron. */ }
    }
    return result.presence;
  }

  let query = deps.admin
    .from("motorist_operator_presence")
    .update({
      status: input.status,
      pause_reason_id: pauseReasonId,
      wrap_up_until: null,
      current_session_id: null,
      status_since: now.toISOString(),
    })
    .eq("id", current.id)
    .eq("status", current.status);
  query = current.current_session_id ? query.eq("current_session_id", current.current_session_id) : query.is("current_session_id", null);
  if (current.presence_revision !== undefined) query = query.eq("presence_revision", current.presence_revision);
  const updated = await query
    .select("*")
    .maybeSingle();
  if (updated.error) throw new PresenceServiceError(`Stav sa nepodarilo uložiť: ${updated.error.message}`, 500);
  if (!updated.data) throw new PresenceServiceError("Stav sa medzičasom zmenil. Obnovte prezenciu.", 409);

  await appendPresenceHistory(deps.admin, {
    organizationId: input.organizationId,
    profileId: input.profileId,
    status: input.status,
    reason: reasonLabel,
    source: input.source ?? "dispatch_console",
    now,
  });
  return updated.data;
}

/** Ends after-call work early; a no-op in any other status. */
export async function endWrapUp(deps: PresenceDeps, input: { organizationId: string; profileId: string; source?: string }): Promise<PresenceRow> {
  const current = await ensurePresenceRow(deps, input);
  if (current.status !== "after_call_work") return current;
  if (telephonyStabilityEnabled() || current.offer_token || current.pause_return) {
    const result = await transitionPresence(deps.admin, { ...input, action: "end_wrap_up", expectedRevision: current.presence_revision,
      expectedToken: current.offer_token, source: input.source ?? "dispatch_console" });
    return result.presence ?? (await getPresence(deps, input)) ?? current;
  }
  const now = nowOf(deps);
  const updated = await deps.admin
    .from("motorist_operator_presence")
    .update({ status: "available", wrap_up_until: null, current_session_id: null, status_since: now.toISOString() })
    .eq("id", current.id)
    .eq("status", "after_call_work")
    .select("*")
    .maybeSingle();
  if (updated.error) throw new PresenceServiceError(`Stav sa nepodarilo uložiť: ${updated.error.message}`, 500);
  if (!updated.data) return (await getPresence(deps, input)) ?? current;
  await appendPresenceHistory(deps.admin, { organizationId: input.organizationId, profileId: input.profileId, status: "available", reason: "wrap-up ukončený", source: input.source ?? "dispatch_console", now });
  return updated.data;
}

/** Existing cron materializes the effective state without requiring an open console. */
export async function sweepExpiredWrapUp(deps: PresenceDeps & { organizationId: string }, limit = 100): Promise<{ checked: number; applied: number; errors: Array<{ profileId: string; error: string }> }> {
  const now = nowOf(deps).toISOString();
  const due = await deps.admin.from("motorist_operator_presence").select("*").eq("organization_id", deps.organizationId)
    .eq("status", "after_call_work").or(`wrap_up_until.is.null,wrap_up_until.lte.${now}`).order("wrap_up_until", { nullsFirst: true }).limit(Math.max(1, Math.min(100, limit)));
  if (due.error) throw new PresenceServiceError(`Ukončenie wrap-up sa nepodarilo načítať: ${due.error.message}`, 500);
  let applied = 0;
  const errors: Array<{ profileId: string; error: string }> = [];
  for (const row of due.data ?? []) {
    try {
      if (row.presence_revision !== undefined || row.offer_token || row.pause_return || telephonyStabilityEnabled()) {
        const result = await transitionPresence(deps.admin, { organizationId: deps.organizationId, profileId: row.profile_id,
          action: "end_wrap_up", expectedRevision: row.presence_revision, expectedToken: row.offer_token, source: "cron" });
        if (result.applied) applied += 1;
      } else {
        const result = await endWrapUp(deps, { organizationId: deps.organizationId, profileId: row.profile_id, source: "cron" });
        if (result.status !== "after_call_work") applied += 1;
      }
    } catch (error) {
      errors.push({ profileId: row.profile_id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { checked: due.data?.length ?? 0, applied, errors };
}
