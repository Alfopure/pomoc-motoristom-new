import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { RecordingTranscriptSpan } from "@/lib/telephony/recording-quality";
import { unionIntervals, type QualitySource, type TimeInterval } from "@/lib/telephony/quality-scoring";

type Tables = Database["public"]["Tables"];
export type RecordingCall = Tables["motorist_calls"]["Row"];
export type RecordingSourceRows = {
  call: RecordingCall;
  recordings: Tables["motorist_call_recordings"]["Row"][];
  transcripts: Tables["motorist_call_transcripts"]["Row"][];
  intervals: Tables["motorist_call_participant_intervals"]["Row"][];
  profiles: Array<{ id: string; display_name: string }>;
  sessionRecordingSuppressed?: boolean;
};
export const jsonObject = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const dateMilliseconds = (value: string | null | undefined): number | null => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
export function sourceRestricted(rows: Pick<RecordingSourceRows, "recordings" | "transcripts" | "sessionRecordingSuppressed">, now = Date.now()): boolean {
  return rows.sessionRecordingSuppressed === true || rows.recordings.some((r) => r.deleted_at || r.restricted_at || r.status === "deleted" || r.expires_at && Date.parse(r.expires_at) <= now)
    || rows.transcripts.some((t) => t.deleted_at || t.status === "restricted" || t.expires_at && Date.parse(t.expires_at) <= now);
}
export async function loadRecordingSourceRows(admin: SupabaseClient<Database>, organizationId: string, callId: string, signal = AbortSignal.timeout(12_000)): Promise<RecordingSourceRows | null> {
  const results = await Promise.all([
    admin.from("motorist_calls").select("*").eq("organization_id", organizationId).eq("id", callId).abortSignal(signal).maybeSingle(),
    admin.from("motorist_call_recordings").select("*").eq("organization_id", organizationId).eq("call_id", callId).order("started_at").abortSignal(signal),
    admin.from("motorist_call_transcripts").select("*").eq("organization_id", organizationId).eq("call_id", callId).order("created_at").abortSignal(signal),
    admin.from("motorist_call_participant_intervals").select("*").eq("organization_id", organizationId).eq("call_id", callId).order("started_at").abortSignal(signal),
    admin.from("motorist_profiles").select("id,display_name").eq("organization_id", organizationId).abortSignal(signal),
  ]);
  if (results.some((r) => r.error)) throw new Error("recording_source_unavailable");
  if (!results[0].data) return null;
  const session = results[0].data.session_id ? await admin.from("motorist_call_sessions").select("metadata")
    .eq("organization_id", organizationId).eq("id", results[0].data.session_id).abortSignal(signal).maybeSingle() : { data: null, error: null };
  if (session.error) throw new Error("recording_source_unavailable");
  return { call: results[0].data, recordings: results[1].data ?? [], transcripts: results[2].data ?? [], intervals: results[3].data ?? [], profiles: results[4].data ?? [],
    sessionRecordingSuppressed: jsonObject(jsonObject(session.data?.metadata).recording).suppressionReason === "objection" };
}

export function buildQualitySource(rows: RecordingSourceRows): QualitySource {
  const { call } = rows;
  const callStart = dateMilliseconds(call.started_at) ?? 0;
  const callEnd = dateMilliseconds(call.ended_at);
  const duration = callEnd !== null && callStart > 0 ? Math.max(0, (callEnd - callStart) / 1000) : Math.max(0, call.duration_seconds ?? 0);
  const spans: RecordingTranscriptSpan[] = [];
  let invalidSource = false;
  const seenIds = new Set<string>();
  for (const transcript of rows.transcripts) {
    if (transcript.status !== "complete" || transcript.deleted_at) continue;
    const values = Array.isArray(transcript.speaker_segments) ? transcript.speaker_segments : [];
    values.forEach((item, index) => {
      const value = jsonObject(item), recording = rows.recordings.find((r) => r.id === transcript.recording_id);
      if (!recording || transcript.audio_source_revision !== recording.source_revision || typeof value.text !== "string" || !value.text.trim() || value.text.length > 12_000) { invalidSource = true; return; }
      const start = value.startSeconds ?? value.start, end = value.endSeconds ?? value.end;
      if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration) { invalidSource = true; return; }
      const canonical = typeof value.id === "string" && value.segmentId === recording.id && value.transcriptId === transcript.id;
      const id = canonical ? String(value.id) : `${transcript.id}:${index}`;
      if (seenIds.has(id)) { invalidSource = true; return; }
      seenIds.add(id);
      const candidates = rows.intervals.filter((interval) => interval.verified && interval.audible_to_customer && interval.role === value.role
        && interval.channel === (value.role === "operator" ? 1 : value.role === "customer" ? 0 : -1)
        && (value.role !== "operator" || interval.profile_id === value.operatorId)
        && Date.parse(interval.started_at) <= callStart + start * 1000
        && interval.ended_at !== null && Date.parse(interval.ended_at) >= callStart + end * 1000);
      const verified = canonical && value.identityVerified === true && jsonObject(recording.participant_manifest).channelMappingVerified === true
        && jsonObject(recording.participant_manifest).timingVerified === true && candidates.length === 1;
      const operatorId = verified && typeof value.operatorId === "string" && rows.profiles.some((p) => p.id === value.operatorId) ? value.operatorId : null;
      const role = verified && value.role === "operator" && operatorId ? "operator" : verified && value.role === "customer" ? "customer" : "unknown";
      spans.push({ id, transcriptId: transcript.id, segmentId: recording.id,
        startSeconds: start, endSeconds: end, text: value.text,
        speakerLabel: role === "operator" ? rows.profiles.find((p) => p.id === operatorId)?.display_name ?? "Operátor" : role === "customer" ? "Zákazník" : "Neoverený hovoriaci",
        role, operatorId: role === "operator" ? operatorId : null, identityVerified: verified && role !== "unknown" });
    });
  }
  spans.sort((a, b) => a.startSeconds - b.startSeconds || a.id.localeCompare(b.id));
  const times = (start: string, end: string | null): TimeInterval | null => {
    const a = dateMilliseconds(start), b = dateMilliseconds(end);
    return a !== null && b !== null && b > a ? { start: Math.max(0, (a - callStart) / 1000), end: Math.min(duration, (b - callStart) / 1000) } : null;
  };
  const connected = unionIntervals(rows.intervals.filter((i) => i.audible_to_customer && i.role === "customer").map((i) => times(i.started_at, i.ended_at)).filter((i): i is TimeInterval => i !== null), duration);
  const fallbackConnected = call.answered_at && callEnd !== null ? [{ start: Math.max(0, (Date.parse(call.answered_at) - callStart) / 1000), end: duration }] : [];
  const holds = unionIntervals(rows.intervals.filter((i) => ["hold", "park", "consult", "held", "parked", "consulting"].includes(i.reason)).map((i) => times(i.started_at, i.ended_at)).filter((i): i is TimeInterval => i !== null), duration);
  const gaps = unionIntervals(rows.recordings.flatMap((recording) => {
    const manifest = jsonObject(recording.participant_manifest);
    return (Array.isArray(manifest.gaps) ? manifest.gaps : []).flatMap((gap) => {
      const value = jsonObject(gap);
      return typeof value.startSeconds === "number" && typeof value.endSeconds === "number" ? [{ start: value.startSeconds, end: value.endSeconds }] : [];
    });
  }), duration);
  const manifests = rows.recordings.map((r) => jsonObject(r.participant_manifest));
  const complete = !invalidSource && spans.length > 0 && rows.recordings.length > 0 && callEnd !== null && gaps.length === 0 && !sourceRestricted(rows)
    && rows.recordings.every((r) => r.status === "available" && rows.transcripts.some((t) => t.recording_id === r.id && t.audio_source_revision === r.source_revision && t.status === "complete"))
    && manifests.every((m) => m.conversationComplete === true && m.timingVerified === true);
  const ids = [...new Set(rows.intervals.filter((i) => i.role === "operator" && i.profile_id).map((i) => i.profile_id as string))];
  if (ids.length === 0 && call.operator_id) ids.push(call.operator_id);
  const audibleOperators = rows.intervals.filter((i) => i.role === "operator" && i.audible_to_customer && i.profile_id);
  const firstOperatorAt = Math.min(...audibleOperators.map((i) => Date.parse(i.started_at)));
  const lastOperatorAt = Math.max(...audibleOperators.filter((i) => i.ended_at).map((i) => Date.parse(i.ended_at!)));
  return { callId: call.id, sourceRevision: call.recording_source_revision, spans,
    subjects: ids.map((id) => ({ id, name: rows.profiles.find((p) => p.id === id)?.display_name ?? "Operátor",
      identityVerified: spans.some((s) => s.operatorId === id && s.identityVerified),
      openingComplete: complete && manifests[0]?.openingComplete === true && audibleOperators.some((i) => i.profile_id === id && Date.parse(i.started_at) === firstOperatorAt),
      conversationComplete: complete, closingComplete: complete && manifests.at(-1)?.closingComplete === true && audibleOperators.some((i) => i.profile_id === id && i.ended_at && Date.parse(i.ended_at) === lastOperatorAt),
    })), durationSeconds: duration, connected: connected.length ? connected : fallbackConnected, holds, gaps,
    transferCount: new Set(rows.intervals.filter((i) => ["transfer", "blind_transfer", "attended_transfer"].includes(i.reason)).map((i) => i.source_event_id)).size,
    language: rows.transcripts.find((t) => t.status === "complete")?.language ?? null,
  };
}
