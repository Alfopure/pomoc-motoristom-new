import "server-only";

import { mapCallCenterCall } from "@/data/dispatch-repository";
import type { CallCenterCall } from "@/data/dispatch-types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/mutation-error";
import { encodeHistoryCursor, isHistoryTimestamp, type CallHistoryQuery, type HistoryCursor } from "@/lib/telephony/call-history-query";
import type { Database } from "@/lib/supabase/database.types";
import { isUuid } from "@/lib/telephony/uuid";

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
  const sessionIds = [...new Set(calls.map((call) => call.session_id).filter((id): id is string => Boolean(id)))];
  const [eventsResult, linesResult, queuesResult, profilesResult, casesResult, recordingsResult, callbacksResult] = await Promise.all([
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
    sessionIds.length ? supabase.from("motorist_callback_requests")
      .select("id,session_id,status,claimed_by,due_at,created_at")
      .eq("organization_id", organizationId).in("session_id", sessionIds)
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1000)
      : Promise.resolve({data:[],error:null}),
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
    (recordingSchemaMissing ? null : recordingsResult.error) ?? callbacksResult.error;
  if (error) {
    throw new Error(`Telephony call history relations could not be loaded: ${error.message}`);
  }
  // Do not silently label omitted sessions as having no callback if PostgREST's
  // result cap is reached. Ordinary pages have at most 100 distinct sessions.
  if ((callbacksResult.data?.length ?? 0) >= 1000) throw new Error("History callback lookup exceeded its safe result bound");

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
  const callbackBySession = new Map<string, NonNullable<CallCenterCall["callback"]>>();
  for (const callback of callbacksResult.data ?? []) {
    if (!callback.session_id || callbackBySession.has(callback.session_id)) continue;
    callbackBySession.set(callback.session_id, {status:callback.status,
      ...(callback.claimed_by && profilesById.get(callback.claimed_by)?.display_name ? {claimedByName:profilesById.get(callback.claimed_by)!.display_name} : {}),
      ...(callback.due_at ? {dueAt:callback.due_at} : {}),
    });
  }

  return calls.map((call) => ({
    ...mapCallCenterCall({
      call,
      callEvents: eventsByCallId.get(call.id) ?? [],
      caseNumberById,
      linesById,
      profilesById,
      queuesById,
      recordingIdByCallId,
    }),
    endReason: call.end_reason ?? undefined,
    waitSecondsKnown: typeof call.wait_seconds === "number" && Number.isFinite(call.wait_seconds) && call.wait_seconds >= 0,
    ...(call.session_id && callbackBySession.has(call.session_id) ? {callback:callbackBySession.get(call.session_id)} : {}),
  }));
}


type HistoryRpc = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: CallRow[] | null; error: { code?: string; message: string } | null }>;
class HistoryRpcUnavailable extends Error {}
const MISSED_BATCH_SIZE = 101;
const MAX_MISSED_BATCH_READS = 8;
const MISSED_SYSTEM_REASONS = new Set(["callback_requested", "after_hours", "ivr_message"]);

/** PostgreSQL timestamps keep microseconds. Date.parse alone loses their order. */
function historyMicros(value: string): bigint {
  if (!isHistoryTimestamp(value)) throw new Error("Invalid history timestamp");
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? "";
  return BigInt(Date.parse(value)) * BigInt(1000) + BigInt(fraction.padEnd(6, "0").slice(3, 6));
}
function compareHistory(left: Pick<CallRow, "id" | "started_at">, right: Pick<CallRow, "id" | "started_at">): number {
  if (left.started_at === null && right.started_at !== null) return 1;
  if (left.started_at !== null && right.started_at === null) return -1;
  if (left.started_at !== null && right.started_at !== null) {
    const a = historyMicros(left.started_at), b = historyMicros(right.started_at);
    if (a !== b) return a > b ? -1 : 1;
  }
  const a = left.id.toLowerCase(), b = right.id.toLowerCase();
  return a === b ? 0 : a > b ? -1 : 1;
}
function cursorFor(row: CallRow): HistoryCursor { return { id: row.id, startedAt: row.started_at }; }
function isMissedHistoryCall(call: CallRow): boolean {
  const raw = call.raw_latest_payload && typeof call.raw_latest_payload === "object" && !Array.isArray(call.raw_latest_payload) ? call.raw_latest_payload : {};
  const callback = raw.callback && typeof raw.callback === "object" && !Array.isArray(raw.callback) ? raw.callback : {};
  return call.direction === "inbound" && call.answered_at === null && Boolean(call.ended_at) &&
    ["missed", "abandoned_queue"].includes(call.status) && !MISSED_SYSTEM_REASONS.has(call.end_reason ?? "") &&
    callback.confirmed !== true && callback.kind !== "requested";
}

/** Search is executed before LIMIT, over the complete organization history. */
export async function searchTelephonyCallHistory(
  actor: Pick<MotoristActor, "organizationId" | "profileId">,
  query: CallHistoryQuery,
  supabase: SupabaseClient<Database> = createSupabaseAdminClient(),
) {
  const rpc = supabase.rpc.bind(supabase) as unknown as HistoryRpc;
  const read = async (direction: CallHistoryQuery["direction"], outcome: string | null, cursor: HistoryCursor | null, limit: number): Promise<CallRow[]> => {
    const result = await rpc("motorist_search_call_history", {
      p_organization_id: actor.organizationId, p_actor_id: actor.profileId,
      p_query: query.q, p_from: query.from, p_to: query.to,
      p_direction: direction, p_outcome: outcome,
      p_operator_id: query.operatorId, p_line_id: query.lineId,
      p_cursor_at: cursor?.startedAt ?? null, p_cursor_id: cursor?.id ?? null,
      p_limit: limit,
    });
    if (result.error) {
      if (result.error.code === "42501") throw new MutationError("Nemáte prístup k histórii hovorov.", 403);
      if (["PGRST202", "42883"].includes(result.error.code ?? "")) throw new HistoryRpcUnavailable();
      throw new Error("Call history search failed");
    }
    const batch = result.data ?? [];
    if (!Array.isArray(batch) || batch.length > limit) throw new Error("Invalid history page");
    let previous = cursor ? { id: cursor.id, started_at: cursor.startedAt } : null;
    for (const row of batch) {
      if (!row || !isUuid(row.id) || row.organization_id !== actor.organizationId || !(row.started_at === null || typeof row.started_at === "string")) throw new Error("Invalid history row");
      if (row.started_at !== null) historyMicros(row.started_at);
      if (previous && compareHistory(previous, row) >= 0) throw new Error("History page did not advance");
      previous = row;
    }
    return batch;
  };

  let rows: CallRow[] = [];
  let nextCursor: string | null = null;
  let scanLimited = false;
  try {
    if (query.category === "missed") {
      // Each stream is ordered independently by the existing authorized RPC.
      // Refill every empty head before consuming the global newest row. Reading
      // both batches and advancing to their oldest row would skip unseen rows
      // in the other stream, especially when one status is much more common.
      const streams = ["missed", "abandoned_queue"].map(outcome => ({outcome, cursor:query.cursor, batch:[] as CallRow[], index:0, exhausted:false}));
      let reads = 0;
      let lastScanned: CallRow | null = null;
      const collected = new Set<string>();
      while (rows.length <= query.limit) {
        const needed = streams.filter(stream => stream.index === stream.batch.length && !stream.exhausted);
        if (reads + needed.length > MAX_MISSED_BATCH_READS) { scanLimited = true; break; }
        const results = await Promise.allSettled(needed.map(async stream => {
          reads += 1;
          const batch = await read("inbound", stream.outcome, stream.cursor, MISSED_BATCH_SIZE);
          stream.batch = batch; stream.index = 0; stream.exhausted = batch.length < MISSED_BATCH_SIZE;
          if (batch.length) stream.cursor = cursorFor(batch[batch.length - 1]);
        }));
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
        // An authorization/server failure must win over a simultaneous missing
        // schema response; never downgrade denial to the recent-history fallback.
        const failure = failures.find(error => !(error instanceof HistoryRpcUnavailable)) ?? failures[0];
        if (failure) throw failure;
        const heads = streams.filter(stream => stream.index < stream.batch.length);
        if (!heads.length) break;
        heads.sort((a,b) => compareHistory(a.batch[a.index], b.batch[b.index]));
        const row = heads[0].batch[heads[0].index];
        for (const stream of heads) if (stream.batch[stream.index].id === row.id) stream.index += 1;
        lastScanned = row;
        if (!collected.has(row.id) && isMissedHistoryCall(row)) { rows.push(row); collected.add(row.id); }
      }
      if (rows.length > query.limit) {
        rows = rows.slice(0, query.limit);
        nextCursor = encodeHistoryCursor(cursorFor(rows[rows.length - 1]));
      } else if (scanLimited && lastScanned) {
        // A short/empty page is resumable. Advancing past only examined rows
        // guarantees no loss or duplicates while bounding work per request.
        nextCursor = encodeHistoryCursor(cursorFor(lastScanned));
      }
    } else {
      const direction = query.category === "outbound" ? "outbound" : query.category === "received" ? "inbound" : query.direction;
      const outcome = query.category === "received" ? "answered" : query.outcome;
      const batch = await read(direction, outcome, query.cursor, query.limit + 1);
      rows = batch.slice(0, query.limit);
      if (batch.length > query.limit && rows.length) nextCursor = encodeHistoryCursor(cursorFor(rows[rows.length - 1]));
    }
  } catch (error) {
    if (error instanceof HistoryRpcUnavailable) {
      return { searchAvailable:false, scanLimited:false, calls:await loadTelephonyCallHistory(actor.organizationId,DEFAULT_HISTORY_LIMIT,supabase), nextCursor:null, filters:{lines:[],operators:[]} };
    }
    throw error;
  }
  const [calls, lines, operators] = await Promise.all([
    hydrateHistory(supabase, actor.organizationId, rows),
    supabase.from("motorist_telephony_lines").select("id,label").eq("organization_id", actor.organizationId).order("label"),
    supabase.from("motorist_profiles").select("id,display_name").eq("organization_id", actor.organizationId).order("display_name"),
  ]);
  if (lines.error || operators.error) throw new Error("History filters unavailable");
  return { searchAvailable:true, scanLimited, calls, nextCursor,
    filters:{lines:lines.data ?? [],operators:(operators.data ?? []).map(p=>({id:p.id,name:p.display_name}))} };
}
