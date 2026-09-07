import type { OperatorPresenceStatus } from "@/lib/supabase/database.types";

/** Survives removal of current_session_id during wrap-up. */
export type PauseReturn = {
  v: 1;
  sessionId: string;
  profileId: string;
  pauseReasonId: string | null;
  pausedSince: string;
  ownerToken: string;
};

export function readPauseReturn(value: unknown): PauseReturn | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<PauseReturn>;
  return row.v === 1 && typeof row.sessionId === "string" && typeof row.profileId === "string" &&
    (row.pauseReasonId === null || typeof row.pauseReasonId === "string") && typeof row.pausedSince === "string" &&
    typeof row.ownerToken === "string" ? row as PauseReturn : null;
}

/** Admission and readiness must agree even before cron materializes wrap-up. */
export function effectivePresenceStatus(
  row: { status: OperatorPresenceStatus; wrap_up_until?: string | null; pause_return?: unknown },
  now: Date,
): OperatorPresenceStatus {
  if (row.status !== "after_call_work") return row.status;
  const until = row.wrap_up_until ? Date.parse(row.wrap_up_until) : NaN;
  if (Number.isFinite(until) && until > now.getTime()) return "after_call_work";
  return readPauseReturn(row.pause_return) ? "paused" : "available";
}

export function effectivePresenceSince(
  row: { status: OperatorPresenceStatus; status_since: string; wrap_up_until?: string | null; pause_return?: unknown },
  now: Date,
): string {
  if (row.status === "after_call_work" && effectivePresenceStatus(row, now) === "paused" && row.wrap_up_until && Number.isFinite(Date.parse(row.wrap_up_until))) return row.wrap_up_until;
  return row.status_since;
}
