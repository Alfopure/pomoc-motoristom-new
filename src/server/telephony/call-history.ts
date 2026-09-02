import "server-only";

import { mapCallCenterCall } from "@/data/dispatch-repository";
import type { CallCenterCall } from "@/data/dispatch-types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

type CallEventRow = Database["public"]["Tables"]["motorist_call_events"]["Row"];

const DEFAULT_HISTORY_LIMIT = 50;

export async function loadTelephonyCallHistory(
  organizationId: string,
  limit = DEFAULT_HISTORY_LIMIT,
): Promise<CallCenterCall[]> {
  const supabase = createSupabaseAdminClient();
  const callsResult = await supabase
    .from("motorist_calls")
    .select("*")
    .eq("organization_id", organizationId)
    .order("started_at", { ascending: false, nullsFirst: false })
    .limit(Math.max(1, Math.min(limit, 100)));

  if (callsResult.error) {
    throw new Error(`Telephony call history could not be loaded: ${callsResult.error.message}`);
  }

  const calls = callsResult.data ?? [];
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
      .in("call_id", callIds)
      .order("created_at", { ascending: false }),
  ]);

  const error =
    eventsResult.error ??
    linesResult.error ??
    queuesResult.error ??
    profilesResult.error ??
    casesResult.error ??
    recordingsResult.error;
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
  for (const recording of recordingsResult.data ?? []) {
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
