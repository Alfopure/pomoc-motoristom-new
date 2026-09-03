/**
 * Wallboard and call-centre statistics (design §4 Phase 4, plan "wallboard
 * ... + widgety v reportoch").
 *
 * Two jobs in one module, both pure and free of DOM/server imports:
 *
 * 1. The *definitions*. `motorist_call_stats_daily` (migration
 *    `20260921100000`) is the fast path, but the views are read through a
 *    fallback while the migration is not applied yet, and a fallback that
 *    counted "answered" differently from the view would quietly print two
 *    different numbers on two screens. `aggregateCallStats` therefore
 *    re-implements the view's arithmetic over raw `motorist_calls` rows, and
 *    `stats.test.ts` holds the two side by side.
 *
 * 2. The *presentation rules*. Elapsed times are re-derived in the browser
 *    against its own clock (the server answer is up to a cache interval old,
 *    and a wall display that freezes a "čaká 0:12" for ten seconds is worse
 *    than one that never showed it), and the colour thresholds are named once
 *    so the wallboard and the report widget cannot disagree about what "red"
 *    means.
 */

import type { TelephonyPresenceStatus } from "@/lib/telephony/presence";

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export type CallDirection = "inbound" | "outbound" | "internal";

/** One row of `motorist_call_stats_daily`, already coerced to numbers. */
export type CallStatsRow = {
  day: string;
  direction: CallDirection;
  operatorId: string | null;
  calls: number;
  answered: number;
  /** Ended without ever being answered. */
  unanswered: number;
  /** Unanswered on purpose: after hours, callback offered, IVR message, all busy. */
  systemHandled: number;
  /** Unanswered because the caller gave up while we were still trying. */
  abandoned: number;
  /** Answered calls with a usable time-to-answer (the ASA denominator). */
  answeredWithWait: number;
  answeredWithin20s: number;
  answerSecondsTotal: number;
  talkSeconds: number;
};

export type CallStatsTotals = Omit<CallStatsRow, "day" | "direction" | "operatorId">;

export type CallStatsMetrics = CallStatsTotals & {
  /** Answered / (answered + abandoned); a caller we closed on purpose is not a failure. */
  answerRate: number | null;
  abandonRate: number | null;
  /** Average speed of answer, seconds. */
  averageAnswerSeconds: number | null;
  /** Share of answered calls picked up within 20 s. */
  serviceLevel: number | null;
  averageTalkSeconds: number | null;
};

export type WallboardWaitingCall = {
  sessionId: string;
  callerNumber: string | null;
  lineLabel: string | null;
  /** `waiting`, `parked`, `ringing`… — what the caller is doing right now. */
  state: string;
  /** Since when the caller has been waiting for a human. */
  since: string;
  /** Who put the caller in the waiting room, when anybody did. */
  parkedByName: string | null;
};

export type WallboardOperator = {
  profileId: string;
  name: string;
  state: TelephonyPresenceStatus;
  /** When the operator entered this state; the browser measures from here. */
  since: string | null;
  registered: boolean;
  pauseReason: string | null;
  /** Calls this operator answered today. */
  answeredToday: number;
  talkSecondsToday: number;
  /** Time spent available today, from `motorist_operator_status_durations`. */
  availableSecondsToday: number;
  pausedSecondsToday: number;
};

export type WallboardPayload = {
  checkedAt: string;
  /** Local (Europe/Bratislava) calendar day the "today" numbers cover. */
  day: string;
  configured: boolean;
  /** `view` = the Phase 4 views answered; `fallback` = they are not applied yet. */
  source: "view" | "fallback";
  live: {
    waiting: WallboardWaitingCall[];
    ringing: number;
    talking: number;
    /** Callers in the waiting room specifically because an operator parked them. */
    parked: number;
  };
  today: CallStatsMetrics & { outbound: number; internal: number };
  operators: WallboardOperator[];
  callbacks: {
    open: number;
    unclaimed: number;
    /** Past the 30-minute promise. */
    overdue: number;
    oldestSince: string | null;
  };
};

export const EMPTY_CALL_TOTALS: CallStatsTotals = {
  calls: 0,
  answered: 0,
  unanswered: 0,
  systemHandled: 0,
  abandoned: 0,
  answeredWithWait: 0,
  answeredWithin20s: 0,
  answerSecondsTotal: 0,
  talkSeconds: 0,
};

export const EMPTY_WALLBOARD: WallboardPayload = {
  checkedAt: "",
  day: "",
  configured: false,
  source: "fallback",
  live: { waiting: [], ringing: 0, talking: 0, parked: 0 },
  today: { ...EMPTY_CALL_TOTALS, answerRate: null, abandonRate: null, averageAnswerSeconds: null, serviceLevel: null, averageTalkSeconds: null, outbound: 0, internal: 0 },
  operators: [],
  callbacks: { open: 0, unclaimed: 0, overdue: 0, oldestSince: null },
};

// ---------------------------------------------------------------------------
// Definitions shared with the SQL views
// ---------------------------------------------------------------------------

/**
 * `end_reason` values that mean the application closed the call itself. The
 * same list is spelled out in `motorist_call_stats_daily`; a value added on
 * one side and not the other turns served callers into abandonment.
 */
export const SYSTEM_HANDLED_END_REASONS: readonly string[] = ["after_hours", "callback_requested", "ivr_message", "all_busy"];

/** The plan's service level: answered within twenty seconds. */
export const SERVICE_LEVEL_SECONDS = 20;

/** Raw `motorist_calls` columns the fallback aggregation needs. */
export type RawCallRow = {
  direction: string;
  operator_id: string | null;
  started_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  wait_seconds: number | null;
  duration_seconds: number | null;
};

function toNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isCallDirection(value: unknown): value is CallDirection {
  return value === "inbound" || value === "outbound" || value === "internal";
}

/** Coerces one PostgREST row of the view; unknown directions are dropped by the caller. */
export function toCallStatsRow(row: Record<string, unknown>): CallStatsRow | null {
  const direction = row.direction;
  if (!isCallDirection(direction)) return null;
  return {
    day: typeof row.day === "string" ? row.day : "",
    direction,
    operatorId: typeof row.operator_id === "string" ? row.operator_id : null,
    calls: toNumber(row.calls),
    answered: toNumber(row.answered),
    unanswered: toNumber(row.unanswered),
    systemHandled: toNumber(row.system_handled),
    abandoned: toNumber(row.abandoned),
    answeredWithWait: toNumber(row.answered_with_wait),
    answeredWithin20s: toNumber(row.answered_within_20s),
    answerSecondsTotal: toNumber(row.answer_seconds_total),
    talkSeconds: toNumber(row.talk_seconds),
  };
}

/**
 * Time to answer, in seconds. Prefers the timestamps and only falls back to
 * the stored `wait_seconds`, exactly like `callWaitSeconds` in
 * `src/lib/reporting.ts` and the `answer_seconds` expression in the view:
 * `wait_seconds` is rewritten at several points in a call's life and a stale
 * zero would make the ASA look perfect.
 */
export function callAnswerSeconds(row: RawCallRow): number | null {
  const answered = parseTime(row.answered_at);
  if (answered === null) return null;
  const started = parseTime(row.started_at);
  if (started !== null && answered >= started) return (answered - started) / 1_000;
  const stored = Math.max(0, toNumber(row.wait_seconds));
  return stored === 0 ? null : stored;
}

/**
 * The fallback path: the same grouping and the same definitions as
 * `motorist_call_stats_daily`, over raw rows already restricted to one local
 * day by the caller.
 */
export function aggregateCallStats(rows: RawCallRow[], day: string): CallStatsRow[] {
  const groups = new Map<string, CallStatsRow>();

  for (const row of rows) {
    if (!row.started_at || !isCallDirection(row.direction)) continue;
    const operatorId = row.operator_id ?? null;
    const key = `${row.direction}|${operatorId ?? ""}`;
    const group = groups.get(key) ?? { day, direction: row.direction, operatorId, ...EMPTY_CALL_TOTALS };

    const answered = Boolean(row.answered_at);
    const completed = Boolean(row.ended_at);
    group.calls += 1;

    if (answered) {
      group.answered += 1;
      group.talkSeconds += Math.max(0, toNumber(row.duration_seconds));
      const answerSeconds = callAnswerSeconds(row);
      if (answerSeconds !== null) {
        group.answeredWithWait += 1;
        group.answerSecondsTotal += answerSeconds;
        if (answerSeconds <= SERVICE_LEVEL_SECONDS) group.answeredWithin20s += 1;
      }
    } else if (completed) {
      group.unanswered += 1;
      if (SYSTEM_HANDLED_END_REASONS.includes(row.end_reason ?? "")) group.systemHandled += 1;
      else group.abandoned += 1;
    }

    groups.set(key, group);
  }

  return [...groups.values()];
}

export function sumCallStats(rows: CallStatsRow[]): CallStatsTotals {
  const totals: CallStatsTotals = { ...EMPTY_CALL_TOTALS };
  for (const row of rows) {
    totals.calls += row.calls;
    totals.answered += row.answered;
    totals.unanswered += row.unanswered;
    totals.systemHandled += row.systemHandled;
    totals.abandoned += row.abandoned;
    totals.answeredWithWait += row.answeredWithWait;
    totals.answeredWithin20s += row.answeredWithin20s;
    totals.answerSecondsTotal += row.answerSecondsTotal;
    totals.talkSeconds += row.talkSeconds;
  }
  return totals;
}

function percentage(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

/**
 * The rates on top of the totals.
 *
 * Denominator choice matters and is deliberate: the answer and abandonment
 * rates are measured against `answered + abandoned`, so a caller the app
 * closed on purpose (after hours, callback promised, IVR message) neither
 * inflates the abandonment rate nor is silently forgiven — those are counted
 * separately as `systemHandled`.
 */
export function deriveCallMetrics(totals: CallStatsTotals): CallStatsMetrics {
  const offered = totals.answered + totals.abandoned;
  return {
    ...totals,
    answerRate: percentage(totals.answered, offered),
    abandonRate: percentage(totals.abandoned, offered),
    averageAnswerSeconds: totals.answeredWithWait > 0 ? Math.round(totals.answerSecondsTotal / totals.answeredWithWait) : null,
    serviceLevel: percentage(totals.answeredWithin20s, totals.answeredWithWait),
    averageTalkSeconds: totals.answered > 0 ? Math.round(totals.talkSeconds / totals.answered) : null,
  };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export const WALLBOARD_STATE_LABELS: Record<TelephonyPresenceStatus, string> = {
  available: "Voľný",
  ringing: "Zvoní",
  on_call: "Na hovore",
  after_call_work: "Po hovore",
  paused: "Pauza",
  offline: "Odhlásený",
};

export type WallboardTone = "ok" | "warn" | "alert" | "idle";

export const WALLBOARD_STATE_TONES: Record<TelephonyPresenceStatus, WallboardTone> = {
  available: "ok",
  ringing: "warn",
  on_call: "warn",
  after_call_work: "idle",
  paused: "idle",
  offline: "idle",
};

/** Amber once the caller passed the service level, red at a minute. */
export const WAIT_WARN_SECONDS = SERVICE_LEVEL_SECONDS;
export const WAIT_ALERT_SECONDS = 60;

export function waitTone(seconds: number): WallboardTone {
  if (seconds >= WAIT_ALERT_SECONDS) return "alert";
  if (seconds >= WAIT_WARN_SECONDS) return "warn";
  return "ok";
}

/** Service level: green from 80 %, amber from 60 %, red below. */
export function serviceLevelTone(value: number | null): WallboardTone {
  if (value === null) return "idle";
  if (value >= 80) return "ok";
  if (value >= 60) return "warn";
  return "alert";
}

/** Abandonment: green to 5 %, amber to 10 %, red above. */
export function abandonTone(value: number | null): WallboardTone {
  if (value === null) return "idle";
  if (value <= 5) return "ok";
  if (value <= 10) return "warn";
  return "alert";
}

/** Seconds elapsed since an ISO timestamp, never negative, `0` when unparsable. */
export function elapsedSeconds(since: string | null | undefined, now: number): number {
  const parsed = parseTime(since);
  if (parsed === null) return 0;
  return Math.max(0, Math.floor((now - parsed) / 1_000));
}

/** "0:42", "12:05", "1:02:33" — a wall display reads a clock, not "42 s". */
export function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3_600);
  const minutes = Math.floor((safe % 3_600) / 60);
  const rest = safe % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

/** The longest wait among the callers on screen, in seconds. */
export function longestWaitSeconds(waiting: WallboardWaitingCall[], now: number): number {
  let longest = 0;
  for (const call of waiting) longest = Math.max(longest, elapsedSeconds(call.since, now));
  return longest;
}
