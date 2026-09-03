import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { callbackUrgency, type CallbackStatus } from "@/lib/telephony/callback-queue";
import {
  aggregateCallStats,
  deriveCallMetrics,
  sumCallStats,
  toCallStatsRow,
  type CallStatsRow,
  type RawCallRow,
  type WallboardOperator,
  type WallboardPayload,
  type WallboardWaitingCall,
} from "@/lib/telephony/wallboard";
import { localDateKey, resolveReportRange } from "@/lib/reporting";

import { deviceIsLive } from "./operator-devices";
import { effectivePresenceStatus } from "./presence-service";
import { ACTIVE_SESSION_STATES, readMeta, TALKING_STATES, WAITING_STATES, type DeviceRow, type PresenceRow, type SessionRow } from "./state/types";

/**
 * Call-centre statistics behind `GET /api/telephony/stats` (design §4 Phase 4).
 *
 * One payload feeds both the full-screen wallboard and the widgets in the
 * reports view. It is deliberately **actor-independent** — no "mine" flags, no
 * per-operator redaction — because that is what makes it safe to answer every
 * reader from one cached snapshot instead of one database pass per open
 * screen. The role check lives in the route.
 *
 * The daily numbers come from `motorist_call_stats_daily` and
 * `motorist_operator_status_durations` (migration `20260921100000`). Both are
 * read with a fallback: while the migration is not applied the views simply
 * do not exist, and a wallboard that answers 500 until an
 * operations task lands is worse than one that computes the same numbers from
 * the raw rows for a day at a time. `source` in the payload says which path
 * answered, and the screen says so too.
 */

type AdminClient = SupabaseClient<Database>;

export type TelephonyStatsDeps = {
  admin: AdminClient;
  organizationId: string;
  now?: () => Date;
  logger?: (entry: Record<string, unknown>) => void;
};

/**
 * How long one snapshot serves every reader.
 *
 * A wall display polls to look alive, not because the underlying counters move
 * that fast: today's totals change a few times an hour and the live queue is
 * re-derived in the browser from timestamps in the payload. Five seconds keeps
 * "callers waiting" honest while collapsing N screens × the poll rate down to
 * one database pass per five seconds per organisation.
 */
export const STATS_CACHE_TTL_MS = 5_000;

type CacheEntry = { at: number; payload: WallboardPayload };
const cache = new Map<string, CacheEntry>();

/** Test seam: drops the per-instance snapshot cache. */
export function resetTelephonyStatsCache(): void {
  cache.clear();
}

function nowOf(deps: TelephonyStatsDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

/**
 * PostgREST answers a missing relation with `42P01` from Postgres or, more
 * often, with its own `PGRST205` after failing to find it in the schema cache.
 * Anything else is a real failure and must not be papered over.
 */
function isMissingRelation(error: { code?: string | null; message?: string | null } | null): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  if (code === "42P01" || code === "PGRST205" || code === "PGRST202") return true;
  const message = error.message ?? "";
  return /schema cache/i.test(message) || /does not exist/i.test(message);
}

// ---------------------------------------------------------------------------
// Daily call statistics
// ---------------------------------------------------------------------------

async function loadCallStats(
  deps: TelephonyStatsDeps,
  range: { day: string; from: string; to: string },
): Promise<{ rows: CallStatsRow[]; source: "view" | "fallback" }> {
  const view = await deps.admin
    .from("motorist_call_stats_daily")
    .select("day, direction, operator_id, calls, answered, unanswered, system_handled, abandoned, answered_with_wait, answered_within_20s, answer_seconds_total, talk_seconds")
    .eq("organization_id", deps.organizationId)
    .eq("day", range.day);

  if (!view.error) {
    const rows = ((view.data ?? []) as Array<Record<string, unknown>>).map(toCallStatsRow).filter((row): row is CallStatsRow => row !== null);
    return { rows, source: "view" };
  }
  if (!isMissingRelation(view.error)) throw new Error(`call stats load failed: ${view.error.message}`);
  deps.logger?.({ level: "warn", scope: "stats", note: "motorist_call_stats_daily missing, falling back to raw calls" });

  const raw = await deps.admin
    .from("motorist_calls")
    .select("direction, operator_id, started_at, answered_at, ended_at, end_reason, wait_seconds, duration_seconds")
    .eq("organization_id", deps.organizationId)
    .gte("started_at", range.from)
    .lt("started_at", range.to);
  if (raw.error) throw new Error(`call stats fallback failed: ${raw.error.message}`);

  return { rows: aggregateCallStats((raw.data ?? []) as RawCallRow[], range.day), source: "fallback" };
}

// ---------------------------------------------------------------------------
// Operator status durations
// ---------------------------------------------------------------------------

type StatusSeconds = Map<string, Map<string, number>>;

function addSeconds(into: StatusSeconds, profileId: string, status: string, seconds: number): void {
  const byStatus = into.get(profileId) ?? new Map<string, number>();
  byStatus.set(status, (byStatus.get(status) ?? 0) + Math.max(0, seconds));
  into.set(profileId, byStatus);
}

async function loadStatusDurations(
  deps: TelephonyStatsDeps,
  range: { day: string; from: string; to: string },
  now: Date,
): Promise<StatusSeconds> {
  const result: StatusSeconds = new Map();

  const view = await deps.admin
    .from("motorist_operator_status_durations")
    .select("profile_id, status, seconds")
    .eq("organization_id", deps.organizationId)
    .eq("day", range.day);

  if (!view.error) {
    for (const row of (view.data ?? []) as Array<Record<string, unknown>>) {
      if (typeof row.profile_id !== "string" || typeof row.status !== "string") continue;
      addSeconds(result, row.profile_id, row.status, Number(row.seconds) || 0);
    }
    return result;
  }
  if (!isMissingRelation(view.error)) throw new Error(`status durations load failed: ${view.error.message}`);

  const raw = await deps.admin
    .from("motorist_operator_statuses")
    .select("profile_id, status, started_at, ended_at")
    .eq("organization_id", deps.organizationId)
    .gte("started_at", range.from)
    .lt("started_at", range.to);
  if (raw.error) throw new Error(`status durations fallback failed: ${raw.error.message}`);

  for (const row of raw.data ?? []) {
    const started = Date.parse(row.started_at);
    if (!Number.isFinite(started)) continue;
    const endedRaw = row.ended_at ? Date.parse(row.ended_at) : now.getTime();
    const ended = Number.isFinite(endedRaw) ? endedRaw : now.getTime();
    addSeconds(result, row.profile_id, row.status, (ended - started) / 1_000);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export async function loadTelephonyStats(deps: TelephonyStatsDeps, options: { configured?: boolean } = {}): Promise<WallboardPayload> {
  const now = nowOf(deps);
  const { admin, organizationId } = deps;
  const reportRange = resolveReportRange("today", now);
  const range = { day: localDateKey(now.toISOString()) ?? reportRange.from.slice(0, 10), from: reportRange.from, to: reportRange.to };

  const [sessionsResult, presenceResult, devicesResult, linesResult, profilesResult, pauseResult, callbacksResult] = await Promise.all([
    admin.from("motorist_call_sessions").select("*").eq("organization_id", organizationId).in("state", [...ACTIVE_SESSION_STATES]),
    admin.from("motorist_operator_presence").select("*").eq("organization_id", organizationId),
    admin.from("motorist_operator_devices").select("*").eq("organization_id", organizationId),
    admin.from("motorist_telephony_lines").select("id, label, partner_name").eq("organization_id", organizationId),
    admin.from("motorist_profiles").select("id, display_name").eq("organization_id", organizationId),
    admin.from("motorist_pause_reasons").select("id, label").eq("organization_id", organizationId),
    admin
      .from("motorist_callback_requests")
      .select("id, status, claimed_by, created_at, due_at")
      .eq("organization_id", organizationId)
      .in("status", ["open", "scheduled"]),
  ]);

  for (const [label, result] of [
    ["sessions", sessionsResult],
    ["presence", presenceResult],
    ["devices", devicesResult],
    ["lines", linesResult],
    ["profiles", profilesResult],
    ["pause reasons", pauseResult],
    ["callbacks", callbacksResult],
  ] as const) {
    if (result.error) throw new Error(`${label} load failed: ${result.error.message}`);
  }

  const [stats, durations] = await Promise.all([loadCallStats(deps, range), loadStatusDurations(deps, range, now)]);

  const nameById = new Map(((profilesResult.data ?? []) as Array<{ id: string; display_name: string }>).map((row) => [row.id, row.display_name]));
  const lineById = new Map(((linesResult.data ?? []) as Array<{ id: string; label: string; partner_name: string | null }>).map((row) => [row.id, row]));
  const pauseLabelById = new Map(((pauseResult.data ?? []) as Array<{ id: string; label: string }>).map((row) => [row.id, row.label]));

  // --- live queue ----------------------------------------------------------
  const sessions = (sessionsResult.data ?? []) as SessionRow[];
  const waiting: WallboardWaitingCall[] = [];
  let ringing = 0;
  let talking = 0;
  let parked = 0;

  for (const session of sessions) {
    if (TALKING_STATES.has(session.state)) {
      talking += 1;
      continue;
    }
    if (session.state === "ringing") ringing += 1;
    if (!WAITING_STATES.has(session.state)) continue;
    const meta = readMeta(session);
    const parkedBy = meta.park?.by ?? null;
    if (session.state === "parked") parked += 1;
    const line = session.line_id ? lineById.get(session.line_id) : undefined;
    waiting.push({
      sessionId: session.id,
      callerNumber: session.caller_number,
      lineLabel: line?.label ?? meta.line_label ?? null,
      state: session.state,
      since: meta.waiting?.since ?? session.parked_at ?? session.started_at,
      parkedByName: parkedBy ? nameById.get(parkedBy) ?? null : null,
    });
  }
  waiting.sort((left, right) => Date.parse(left.since) - Date.parse(right.since));

  // --- operators -----------------------------------------------------------
  const answeredByOperator = new Map<string, { answered: number; talkSeconds: number }>();
  for (const row of stats.rows) {
    if (!row.operatorId) continue;
    const bucket = answeredByOperator.get(row.operatorId) ?? { answered: 0, talkSeconds: 0 };
    bucket.answered += row.answered;
    bucket.talkSeconds += row.talkSeconds;
    answeredByOperator.set(row.operatorId, bucket);
  }

  const devicesByProfile = new Map<string, DeviceRow>();
  for (const device of (devicesResult.data ?? []) as DeviceRow[]) {
    // One row per environment; a phone alive in either of them is a phone
    // ringing on somebody's desk, which is what the wallboard reports.
    const current = devicesByProfile.get(device.profile_id);
    if (!current || deviceIsLive(device, now)) devicesByProfile.set(device.profile_id, device);
  }

  const operators: WallboardOperator[] = ((presenceResult.data ?? []) as PresenceRow[])
    .map((row) => {
      const totals = answeredByOperator.get(row.profile_id) ?? { answered: 0, talkSeconds: 0 };
      const byStatus = durations.get(row.profile_id);
      return {
        profileId: row.profile_id,
        name: nameById.get(row.profile_id) ?? "Neznámy operátor",
        state: effectivePresenceStatus(row, now),
        since: row.status_since,
        registered: deviceIsLive(devicesByProfile.get(row.profile_id) ?? null, now),
        pauseReason: row.pause_reason_id ? pauseLabelById.get(row.pause_reason_id) ?? null : null,
        answeredToday: totals.answered,
        talkSecondsToday: Math.round(totals.talkSeconds),
        availableSecondsToday: Math.round(byStatus?.get("available") ?? 0),
        pausedSecondsToday: Math.round(byStatus?.get("paused") ?? 0),
      } satisfies WallboardOperator;
    })
    .sort((left, right) => left.name.localeCompare(right.name, "sk"));

  // --- callbacks -----------------------------------------------------------
  const callbackRows = (callbacksResult.data ?? []) as Array<{ id: string; status: CallbackStatus; claimed_by: string | null; created_at: string; due_at: string | null }>;
  let overdue = 0;
  let unclaimed = 0;
  let oldestSince: string | null = null;
  for (const row of callbackRows) {
    if (!row.claimed_by) unclaimed += 1;
    // Reuses the queue's own ageing rule so the wallboard and the callback
    // panel cannot disagree about which promise is broken.
    const urgency = callbackUrgency({ status: row.status, createdAt: row.created_at, dueAt: row.due_at }, now.getTime());
    if (urgency === "overdue") overdue += 1;
    if (!oldestSince || Date.parse(row.created_at) < Date.parse(oldestSince)) oldestSince = row.created_at;
  }

  const inbound = stats.rows.filter((row) => row.direction === "inbound");
  const totals = deriveCallMetrics(sumCallStats(inbound));

  return {
    checkedAt: now.toISOString(),
    day: range.day,
    configured: options.configured ?? true,
    source: stats.source,
    live: { waiting, ringing, talking, parked },
    today: {
      ...totals,
      outbound: stats.rows.filter((row) => row.direction === "outbound").reduce((sum, row) => sum + row.calls, 0),
      internal: stats.rows.filter((row) => row.direction === "internal").reduce((sum, row) => sum + row.calls, 0),
    },
    operators,
    callbacks: { open: callbackRows.length, unclaimed, overdue, oldestSince },
  };
}

/**
 * The cached read every screen uses. The cache is per serverless instance and
 * per organisation, and it stores a payload nobody's identity influenced.
 */
export async function loadTelephonyStatsCached(deps: TelephonyStatsDeps, options: { configured?: boolean } = {}): Promise<WallboardPayload> {
  const now = nowOf(deps).getTime();
  const key = `${deps.organizationId}:${options.configured ?? true}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < STATS_CACHE_TTL_MS && now >= hit.at) return hit.payload;

  const payload = await loadTelephonyStats(deps, options);
  cache.set(key, { at: now, payload });
  return payload;
}
