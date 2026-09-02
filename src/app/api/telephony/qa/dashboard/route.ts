import { requireDefaultMotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const QA_ACCESS_ROLES = ["senior_dispatcher", "manager", "admin"] as const;
const LOOKBACK_DAYS = 90;

export async function GET() {
  try {
    const actor = await requireDefaultMotoristActor([...QA_ACCESS_ROLES]);
    const supabase = createSupabaseAdminClient();
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const transcripts = await supabase
      .from("motorist_call_transcripts")
      .select("id, call_id, qa_score, summary, created_at")
      .eq("organization_id", actor.organizationId)
      .not("qa_score", "is", null)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(500);

    if (transcripts.error) {
      throw new MutationError(transcripts.error.message, 500);
    }

    const rows = transcripts.data ?? [];
    const callIds = [...new Set(rows.map((row) => row.call_id))];
    const callsById = new Map<string, { operator_id: string | null; caller_number: string | null; started_at: string | null }>();

    if (callIds.length > 0) {
      const calls = await supabase
        .from("motorist_calls")
        .select("id, operator_id, caller_number, started_at")
        .eq("organization_id", actor.organizationId)
        .in("id", callIds);

      if (calls.error) {
        throw new MutationError(calls.error.message, 500);
      }

      for (const call of calls.data ?? []) {
        callsById.set(call.id, call);
      }
    }

    const operatorIds = [...new Set([...callsById.values()].map((call) => call.operator_id).filter((id): id is string => Boolean(id)))];
    const operatorNames = new Map<string, string>();

    if (operatorIds.length > 0) {
      const profiles = await supabase
        .from("motorist_profiles")
        .select("id, display_name")
        .eq("organization_id", actor.organizationId)
        .in("id", operatorIds);

      if (!profiles.error) {
        for (const profile of profiles.data ?? []) {
          operatorNames.set(profile.id, profile.display_name);
        }
      }
    }

    const perOperator = new Map<string, { name: string; scores: number[] }>();
    const perWeek = new Map<string, number[]>();
    const scored: Array<{ callId: string; score: number; summary: string | null; operator: string; callerNumber: string | null; startedAt: string | null }> = [];

    for (const row of rows) {
      const call = callsById.get(row.call_id);
      const operatorKey = call?.operator_id ?? "unassigned";
      const operatorName = call?.operator_id ? (operatorNames.get(call.operator_id) ?? "Neznámy") : "Nepriradené";
      const score = Number(row.qa_score);

      const operatorBucket = perOperator.get(operatorKey) ?? { name: operatorName, scores: [] };
      operatorBucket.scores.push(score);
      perOperator.set(operatorKey, operatorBucket);

      const week = isoWeek(call?.started_at ?? row.created_at);
      perWeek.set(week, [...(perWeek.get(week) ?? []), score]);

      scored.push({
        callId: row.call_id,
        score,
        summary: row.summary,
        operator: operatorName,
        callerNumber: call?.caller_number ?? null,
        startedAt: call?.started_at ?? null,
      });
    }

    return Response.json({
      totalScored: rows.length,
      lookbackDays: LOOKBACK_DAYS,
      operators: [...perOperator.values()]
        .map((bucket) => ({ name: bucket.name, calls: bucket.scores.length, avgScore: average(bucket.scores) }))
        .sort((left, right) => right.calls - left.calls),
      weeklyTrend: [...perWeek.entries()]
        .map(([week, scores]) => ({ week, calls: scores.length, avgScore: average(scores) }))
        .sort((left, right) => left.week.localeCompare(right.week)),
      worstCalls: scored.sort((left, right) => left.score - right.score).slice(0, 5),
    });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    const message = error instanceof Error ? error.message : "QA prehľad sa nepodarilo načítať.";
    return Response.json({ error: message }, { status: 500 });
  }
}

function average(scores: number[]) {
  return scores.length === 0 ? null : Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length);
}

function isoWeek(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "?";
  }

  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((target.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
