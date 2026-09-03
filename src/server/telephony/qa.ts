import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { CallOutcome } from "@/data/dispatch-types";
import type { Database } from "@/lib/supabase/database.types";
import type { CallbackSource, CallbackStatus } from "@/lib/telephony/callback-queue";
import { CALLBACK_OVERDUE_MINUTES } from "@/lib/telephony/callback-queue";
import {
  aggregateCallQuality,
  aggregateCallbackCompliance,
  aggregateQaOperators,
  isCallOutcomeValue,
  QA_LOOKBACK_DAYS,
  type QaCallbackInput,
  type QaCallInput,
  type QaDashboardPayload,
} from "@/lib/telephony/qa-metrics";

/**
 * The QA dashboard without recordings or transcripts (plan "Fáza 4", QA bez
 * prepisov).
 *
 * The previous version read `motorist_call_transcripts.qa_score`, a table this
 * copy of the application never writes: recording and transcription are out of
 * scope by the owner's decision, so the panel rendered `null` and hid itself
 * forever. Rather than leave a dead screen behind, it now measures the two
 * things the dispatchers actually control and the application actually records:
 *
 * * **documentation** — every finished call can carry an outcome
 *   (`setCallOutcome` writes it into `raw_latest_payload`); the share that does
 *   is the closest thing to a quality signal we have without audio;
 * * **callback compliance** — a caller who pressed 1 was promised a call back
 *   within thirty minutes, and `motorist_callback_requests` knows whether that
 *   promise was kept.
 *
 * The reads are deliberately plain and bounded: this is a manager's screen
 * opened a few times a day, not a poller.
 */

type AdminClient = SupabaseClient<Database>;

export type TelephonyQaDeps = {
  admin: AdminClient;
  organizationId: string;
  now?: () => Date;
};

/** A hard ceiling so one busy month cannot turn a report into a table scan dump. */
const MAX_ROWS = 2_000;

function readOutcome(payload: unknown): CallOutcome | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>).outcome;
  return isCallOutcomeValue(value) ? value : null;
}

export async function loadQaDashboard(deps: TelephonyQaDeps, options: { lookbackDays?: number } = {}): Promise<QaDashboardPayload> {
  const now = (deps.now ?? (() => new Date()))();
  const lookbackDays = options.lookbackDays ?? QA_LOOKBACK_DAYS;
  const since = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1_000).toISOString();

  const [callsResult, callbacksResult, profilesResult] = await Promise.all([
    deps.admin
      .from("motorist_calls")
      .select("id, operator_id, case_id, ended_at, raw_latest_payload")
      .eq("organization_id", deps.organizationId)
      .gte("started_at", since)
      .order("started_at", { ascending: false })
      .limit(MAX_ROWS),
    deps.admin
      .from("motorist_callback_requests")
      .select("id, status, source, claimed_by, created_at, due_at, resolved_at")
      .eq("organization_id", deps.organizationId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(MAX_ROWS),
    deps.admin.from("motorist_profiles").select("id, display_name").eq("organization_id", deps.organizationId),
  ]);

  for (const [label, result] of [
    ["calls", callsResult],
    ["callbacks", callbacksResult],
    ["profiles", profilesResult],
  ] as const) {
    if (result.error) throw new Error(`qa ${label} load failed: ${result.error.message}`);
  }

  const nameById = new Map(((profilesResult.data ?? []) as Array<{ id: string; display_name: string }>).map((row) => [row.id, row.display_name]));

  const calls: QaCallInput[] = ((callsResult.data ?? []) as Array<{ operator_id: string | null; case_id: string | null; ended_at: string | null; raw_latest_payload: unknown }>).map((row) => ({
    operatorId: row.operator_id,
    caseId: row.case_id,
    completed: Boolean(row.ended_at),
    outcome: readOutcome(row.raw_latest_payload),
  }));

  const callbacks: QaCallbackInput[] = ((callbacksResult.data ?? []) as Array<{
    status: CallbackStatus;
    source: CallbackSource;
    claimed_by: string | null;
    created_at: string;
    due_at: string | null;
    resolved_at: string | null;
  }>).map((row) => ({
    status: row.status,
    source: row.source,
    claimedBy: row.claimed_by,
    createdAt: row.created_at,
    dueAt: row.due_at,
    resolvedAt: row.resolved_at,
  }));

  return {
    checkedAt: now.toISOString(),
    lookbackDays,
    // Stated, not implied: the screen shows why there is no audio here.
    recordingEnabled: false,
    transcriptsEnabled: false,
    promiseMinutes: CALLBACK_OVERDUE_MINUTES,
    calls: aggregateCallQuality(calls),
    callbacks: aggregateCallbackCompliance(callbacks, now.getTime()),
    operators: aggregateQaOperators({ calls, callbacks, nameOf: (profileId) => nameById.get(profileId) ?? "Neznámy operátor" }),
  };
}
