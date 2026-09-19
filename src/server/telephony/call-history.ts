import "server-only";

import { mapCallCenterCall } from "@/data/dispatch-repository";
import type { CallCenterCall } from "@/data/dispatch-types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/mutation-error";
import { encodeHistoryCursor, type CallHistoryQuery } from "@/lib/telephony/call-history-query";
import type { Database } from "@/lib/supabase/database.types";

type CallEventRow = Database["public"]["Tables"]["motorist_call_events"]["Row"];

const DEFAULT_HISTORY_LIMIT = 50;

export async function loadTelephonyCallHistory(
  organizationId: string,
  limit = DEFAULT_HISTORY_LIMIT,
  supabase: SupabaseClient<Database> = createSupabaseAdminClient(),
): Promise<CallCenterCall[]> {
  const callsResult = await supabase
    .from("motorist_calls")
    .select("*")
    .eq("organization_id", organizationId)
    .order("started_at", { ascending: false, nullsFirst: false })
    .limit(Math.max(1, Math.min(limit, 100)));

  if (callsResult.error) {
    throw new Error(`Telephony call history could not be loaded: ${callsResult.error.message}`);
  }

  return hydrateHistory(supabase, organizationId, callsResult.data ?? []);
}

type CallRow = Database["public"]["Tables"]["motorist_calls"]["Row"];
async function hydrateHistory(supabase: SupabaseClient<Database>, organizationId: string, calls: CallRow[]): Promise<CallCenterCall[]> {
  if (calls.length === 0) return [];

  const callIds = calls.map((call) => call.id);
  const caseIds = [...new Set(calls.map((call) => call.case_id).filter((id): id is string => Boolean(id)))];
  const [eventsResult, linesResult, queuesResult, profilesResult, casesResult, recordingsResult] = await Promise.all([
    supabase
      .from("motorist_call_events")
      .select("*")
      .eq("organization_id", organizationId)
      .in("call_id", callIds)
      .order("received_at", { ascending: true }),
    supabase.from("motorist_telephony_lines").select("*").eq("organization_id", organizationId),
    supabase.from("motorist_telephony_queues").select("*").eq("organization_id", organizationId),
    supabase.from("motorist_profiles").select("*").eq("organization_id", organizationId),
    caseIds.length > 0
      ? supabase.from("motorist_cases").select("id, case_number").eq("organization_id", organizationId).in("id", caseIds)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from("motorist_call_recordings")
      .select("id, call_id, created_at")
      .eq("organization_id", organizationId)
      .eq("status", "available")
      .is("deleted_at", null)
      .is("restricted_at", null)
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
      .in("call_id", callIds)
      .order("created_at", { ascending: false }),
  ]);

  // Preview shares the live database and can precede an explicitly approved migration.
  // Missing recording schema means no badge; never retry without the privacy filters.
  const recordingSchemaMissing = recordingsResult.error !== null
    && ["42703", "PGRST204", "42P01", "PGRST205"].includes(recordingsResult.error.code);
  const recordingRows = recordingSchemaMissing ? [] : recordingsResult.data ?? [];

  const error =
    eventsResult.error ??
    linesResult.error ??
    queuesResult.error ??
    profilesResult.error ??
    casesResult.error ??
    (recordingSchemaMissing ? null : recordingsResult.error);
  if (error) {
    throw new Error(`Telephony call history relations could not be loaded: ${error.message}`);
  }

  const eventsByCallId = new Map<string, CallEventRow[]>();
  for (const event of eventsResult.data ?? []) {
    if (!event.call_id) continue;
    const events = eventsByCallId.get(event.call_id) ?? [];
    events.push(event);
    eventsByCallId.set(event.call_id, events);
  }

  const recordingIdByCallId = new Map<string, string>();
  for (const recording of recordingRows) {
    if (recording.call_id && !recordingIdByCallId.has(recording.call_id)) {
      recordingIdByCallId.set(recording.call_id, recording.id);
    }
  }

  const linesById = new Map((linesResult.data ?? []).map((line) => [line.id, line]));
  const queuesById = new Map((queuesResult.data ?? []).map((queue) => [queue.id, queue]));
  const profilesById = new Map((profilesResult.data ?? []).map((profile) => [profile.id, profile]));
  const caseNumberById = new Map((casesResult.data ?? []).map((caseRow) => [caseRow.id, caseRow.case_number]));

  return calls.map((call) =>
    mapCallCenterCall({
      call,
      callEvents: eventsByCallId.get(call.id) ?? [],
      caseNumberById,
      linesById,
      profilesById,
      queuesById,
      recordingIdByCallId,
    }),
  );
}


/** Search is executed before LIMIT, over the complete organization history. */
export async function searchTelephonyCallHistory(
  actor: Pick<MotoristActor, "organizationId" | "profileId">,
  query: CallHistoryQuery,
  supabase: SupabaseClient<Database> = createSupabaseAdminClient(),
) {
  const rpc = supabase.rpc.bind(supabase) as unknown as (name: string, args: Record<string, unknown>) => PromiseLike<{ data: CallRow[] | null; error: { code?: string; message: string } | null }>;
  const result = await rpc("motorist_search_call_history", {
    p_organization_id: actor.organizationId, p_actor_id: actor.profileId,
    p_query: query.q, p_from: query.from, p_to: query.to,
    p_direction: query.direction, p_outcome: query.outcome,
    p_operator_id: query.operatorId, p_line_id: query.lineId,
    p_cursor_at: query.cursor?.startedAt ?? null, p_cursor_id: query.cursor?.id ?? null,
    p_limit: query.limit + 1,
  });
  if (result.error) {
    if (["PGRST202", "42883"].includes(result.error.code ?? "")) {
      return { searchAvailable: false, calls: await loadTelephonyCallHistory(actor.organizationId, DEFAULT_HISTORY_LIMIT, supabase), nextCursor: null, filters: { lines: [], operators: [] } };
    }
    if (result.error.code === "42501") throw new MutationError("Nemáte prístup k histórii hovorov.", 403);
    throw new Error("Call history search failed");
  }
  const rows = (result.data ?? []).slice(0, query.limit);
  const last = rows.at(-1);
  const [calls, lines, operators] = await Promise.all([
    hydrateHistory(supabase, actor.organizationId, rows),
    supabase.from("motorist_telephony_lines").select("id,label").eq("organization_id", actor.organizationId).order("label"),
    supabase.from("motorist_profiles").select("id,display_name").eq("organization_id", actor.organizationId).order("display_name"),
  ]);
  if (lines.error || operators.error) throw new Error("History filters unavailable");
  return { searchAvailable: true, calls, nextCursor: (result.data?.length ?? 0) > query.limit && last
    ? encodeHistoryCursor({ id: last.id, startedAt: last.started_at }) : null,
    filters: { lines: lines.data ?? [], operators: (operators.data ?? []).map(p => ({ id: p.id, name: p.display_name })) } };
}
