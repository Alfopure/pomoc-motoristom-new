import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, OperatorPresenceStatus } from "@/lib/supabase/database.types";

import { appendPresenceHistory } from "./state/effects";
import type { PresenceRow } from "./state/types";

/**
 * Operator presence (`motorist_operator_presence`) with history mirrored into
 * `motorist_operator_statuses` (design §5). Manual changes come from the
 * presence routes; automatic ones (ringing, on_call, after_call_work) are
 * written by the effects layer and the reservation RPC.
 */

type AdminClient = SupabaseClient<Database>;

export type PresenceDeps = { admin: AdminClient; now?: () => Date };

export type ManualPresenceStatus = Extract<OperatorPresenceStatus, "available" | "paused" | "offline">;

export const MANUAL_PRESENCE_STATUSES: ReadonlySet<string> = new Set<ManualPresenceStatus>(["available", "paused", "offline"]);

export class PresenceServiceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "PresenceServiceError";
  }
}

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

  const updated = await deps.admin
    .from("motorist_operator_presence")
    .update({
      status: input.status,
      pause_reason_id: pauseReasonId,
      wrap_up_until: null,
      current_session_id: null,
      status_since: now.toISOString(),
    })
    .eq("id", current.id)
    .select("*")
    .single();
  if (updated.error) throw new PresenceServiceError(`Stav sa nepodarilo uložiť: ${updated.error.message}`, 500);

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

/** Lazily expired wrap-up: `after_call_work` past `wrap_up_until` counts as available (design §2.6). */
export function effectivePresenceStatus(row: Pick<PresenceRow, "status" | "wrap_up_until">, now: Date): OperatorPresenceStatus {
  if (row.status !== "after_call_work") return row.status;
  if (!row.wrap_up_until) return "available";
  const until = Date.parse(row.wrap_up_until);
  return Number.isNaN(until) || until <= now.getTime() ? "available" : "after_call_work";
}
