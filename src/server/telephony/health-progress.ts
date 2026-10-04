import { GREETING_TIMEOUT_MS, readMeta, TALKING_STATES, WAITING_TICK_STALE_MS, type LegRow, type SessionRow } from "./state/types";

/** Allow a cron tick to recover an overdue interaction before warning. */
export const PROGRESS_WARN_MS = 5 * 60_000;
export const PROGRESS_FAIL_MS = 15 * 60_000;

export type HealthSession = Pick<SessionRow, "id" | "state" | "metadata" | "started_at" | "created_at" | "parked_at"
  | "answered_at" | "answered_by_profile_id" | "customer_leg_id" | "conference_id">;
export type HealthLeg = Pick<LegRow, "id" | "session_id" | "role" | "profile_id" | "answered_at" | "bridged_at" | "telnyx_call_control_id">;
export type ProgressIssue = { sessionId: string; state: SessionRow["state"]; reason: string; deadlineAt: string; overdueMs: number };

function timestamp(value: string | null | undefined): number | null {
  const result = value ? Date.parse(value) : NaN;
  return Number.isFinite(result) ? result : null;
}

/**
 * Expected transitions, not a heartbeat: an established conversation can be
 * silent in the webhook ledger for hours. Lease/maintenance writes also bump
 * updated_at, so that column is deliberately not part of this input.
 */
export function sessionProgressIssue(session: HealthSession, now: Date, parkMaxMinutes = 30, openLegs?: HealthLeg[]): ProgressIssue | null {
  const meta = readMeta(session);
  const connection = meta.recording?.connection;
  let pendingAt = timestamp(meta.recording?.pendingAudio?.readyAt)
    ?? (connection && !connection.confirmedAt ? timestamp(connection.startedAt) : null);
  if (!connection && !session.conference_id && session.state === "talking" && openLegs) {
    const customer = openLegs.find(leg => leg.id === session.customer_leg_id || leg.role === "customer");
    // A customer who already left a conference does not invalidate the call
    // between its remaining parties. This fallback only checks a current pair.
    if (customer) {
      const candidates = openLegs.filter(leg => leg.answered_at && (["operator", "external"].includes(leg.role) && leg.profile_id === session.answered_by_profile_id
        || leg.role === "external" && !session.answered_by_profile_id));
      const winner = meta.answered_leg_call_control_id;
      const operator = typeof winner === "string" ? candidates.find(leg => leg.telnyx_call_control_id === winner)
        : candidates.find(leg => leg.bridged_at) ?? candidates[0];
      if (!customer.bridged_at || !operator?.bridged_at) {
        const answers = [customer.answered_at, operator?.answered_at, session.answered_at].map(timestamp).filter((at): at is number => at !== null);
        pendingAt ??= answers.length ? Math.max(...answers) : null;
      }
    }
  }
  if (TALKING_STATES.has(session.state)) {
    // The reducer can enter talking before a pending bridge is confirmed.
    if (pendingAt !== null && now.getTime() > pendingAt) return {
      sessionId: session.id, state: session.state, reason: "connection_unconfirmed",
      deadlineAt: new Date(pendingAt).toISOString(), overdueMs: now.getTime() - pendingAt,
    };
    return null;
  }
  const started = timestamp(session.started_at) ?? timestamp(session.created_at);
  const deadlines: Array<{ at: number; reason: string }> = [];
  const add = (at: number | null, reason: string) => { if (at !== null && Number.isFinite(at)) deadlines.push({ at, reason }); };
  const after = (value: string | null | undefined, duration: number) => {
    const at = timestamp(value);
    return at === null ? null : at + duration;
  };
  if (session.state === "greeting") {
    add(timestamp(meta.greeting?.deadline_at) ?? after(meta.greeting?.started_at, GREETING_TIMEOUT_MS)
      ?? (started === null ? null : started + GREETING_TIMEOUT_MS), "greeting_overdue");
  }
  if (session.state === "ringing") add(timestamp(meta.ring?.step_deadline_at), "ringing_overdue");
  if (["ivr", "after_hours", "callback_offered", "ringing", "waiting"].includes(session.state)) {
    add(meta.callback?.closing_at ? after(meta.callback.closing_at, 30_000)
      : timestamp(meta.callback?.confirmed ? meta.callback.deadline_at : meta.gather?.deadline_at), "gather_overdue");
  }
  if (session.state === "waiting" || session.state === "parked") {
    const waitingSince = timestamp(meta.waiting?.since) ?? timestamp(session.parked_at) ?? started;
    const tick = timestamp(meta.waiting?.last_tick_at) ?? waitingSince;
    add(tick === null ? null : tick + WAITING_TICK_STALE_MS, "waiting_tick_overdue");
    add(waitingSince === null ? null : waitingSince + (meta.waiting?.max_minutes ?? parkMaxMinutes) * 60_000, "waiting_limit_exceeded");
  }
  // Older rows may have no deadline metadata. Their immutable start is a
  // conservative fallback; unrelated calls cannot refresh it.
  if (!deadlines.length && started !== null) add(started, "progress_overdue");
  const overdue = deadlines.sort((a, b) => a.at - b.at)[0];
  if (!overdue || now.getTime() <= overdue.at) return null;
  return { sessionId: session.id, state: session.state, reason: overdue.reason,
    deadlineAt: new Date(overdue.at).toISOString(), overdueMs: now.getTime() - overdue.at };
}

/** Provider facts are observations of a leg, never proof of two-way audio. */
export type ProviderObservation = {
  sessionId: string;
  state: SessionRow["state"];
  legId?: string;
  role?: string;
  verdict: "alive" | "ended" | "unavailable" | "unknown";
  checkedAt: string;
  reason?: string;
  reconciled?: boolean;
  error?: string;
};

export type ProviderVerification = {
  checkedAt: string;
  entries: ProviderObservation[];
  remaining: number;
  error: string | null;
  skipped?: string;
};
