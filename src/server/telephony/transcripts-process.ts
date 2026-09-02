import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { analyzeCallTranscript, isCallAnalysisConfigured, DEFAULT_QA_RUBRIC } from "@/lib/integrations/ai/call-analysis";
import { transcribeWithScribe, ScribeError, type ScribeWord } from "@/lib/integrations/asr/scribe-client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;
type Tables = Database["public"]["Tables"];
type RecordingRow = Tables["motorist_call_recordings"]["Row"];
type TranscriptRow = Tables["motorist_call_transcripts"]["Row"];

export const RECORDINGS_BUCKET = "motorist-call-recordings";

const DEFAULT_ORGANIZATION_SLUG = "pomoc-motoristom";
const MAX_ITEMS_PER_RUN = 3;
const MAX_AI_PER_RUN = 5;
const MAX_RETRIES = 3;
const PROCESSING_LEASE_MS = 15 * 60 * 1000;
// Below this attribution confidence the QA scoring (Phase 3) must not run and the UI
// shows neutral speaker labels — the plan's runtime confidence gate.
export const SPEAKER_CONFIDENCE_THRESHOLD = 0.9;

export type SpeakerSegment = {
  speaker: "dispecer" | "volajuci" | string;
  speakerId: string | null;
  start: number;
  end: number;
  text: string;
};

export type TranscriptsProcessSummary = {
  status: "ok" | "failed" | "disabled";
  organizationId: string | null;
  candidates: number;
  processed: number;
  failed: number;
  skipped: number;
  aiProcessed: number;
  aiFailed: number;
  aiSkipped: number;
  errors: string[];
};

export class TranscriptsProcessError extends Error {
  constructor(message: string, readonly status = 500) {
    super(message);
    this.name = "TranscriptsProcessError";
  }
}

/** @internal exported for unit tests */
export function resolveProcessLimits(maxItems?: number) {
  const transcriptItems = Math.max(1, Math.min(maxItems ?? MAX_ITEMS_PER_RUN, MAX_ITEMS_PER_RUN));

  return {
    transcriptItems,
    aiItems: maxItems === undefined ? MAX_AI_PER_RUN : Math.min(transcriptItems, MAX_AI_PER_RUN),
  };
}

export async function processTranscripts(options: { maxItems?: number; dryRun?: boolean } = {}): Promise<TranscriptsProcessSummary> {
  const supabase = createSupabaseAdminClient();
  const organization = await resolveOrganization(supabase);

  const summary: TranscriptsProcessSummary = {
    status: "ok",
    organizationId: organization.id,
    candidates: 0,
    processed: 0,
    failed: 0,
    skipped: 0,
    aiProcessed: 0,
    aiFailed: 0,
    aiSkipped: 0,
    errors: [],
  };

  try {
    if (!(await transcriptsEnabled(supabase, organization.id))) {
      summary.status = "disabled";
      return summary;
    }

    const recordings = await selectCandidateRecordings(supabase, organization.id);
    const transcriptsByRecording = await loadTranscripts(supabase, organization.id, recordings);
    const limits = resolveProcessLimits(options.maxItems);

    for (const recording of recordings) {
      if (summary.processed + summary.failed >= limits.transcriptItems) {
        break;
      }

      const existing = transcriptsByRecording.get(recording.id);
      const decision = classifyCandidate(existing);

      if (decision === "skip") {
        summary.skipped += 1;
        continue;
      }

      summary.candidates += 1;

      if (options.dryRun) {
        continue;
      }

      const transcript = await claimTranscript(supabase, organization.id, recording, existing);

      if (!transcript) {
        summary.skipped += 1;
        continue;
      }

      try {
        await transcribeRecording(supabase, recording, transcript);
        summary.processed += 1;
      } catch (error) {
        summary.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        summary.errors.push(`${recording.id}: ${message}`);
        await markFailure(supabase, transcript, message);
      }
    }

    // Phase 3: AI summary/extraction/QA over completed transcripts. Strictly best-effort
    // (principle 1 of the plan) — a missing key or an AI failure never touches the
    // transcript status, only leaves the AI fields null for the next run.
    await analyzeCompletedTranscripts(supabase, organization.id, summary, options.dryRun === true, limits.aiItems);
  } catch (error) {
    summary.status = "failed";
    summary.errors.push(error instanceof Error ? error.message : String(error));
  }

  if (!options.dryRun) {
    await writeSummaryEvent(supabase, organization.id, summary);
  }

  return summary;
}

async function transcriptsEnabled(supabase: AdminClient, organizationId: string) {
  if (process.env.TRANSCRIPTS_ENABLED?.trim() === "true") {
    return true;
  }

  const integration = await supabase
    .from("motorist_organization_integrations")
    .select("enabled_features")
    .eq("organization_id", organizationId)
    .eq("provider", "viptel")
    .maybeSingle();
  throwOnError(integration.error);

  return integration.data?.enabled_features?.includes("transcripts") ?? false;
}

async function selectCandidateRecordings(supabase: AdminClient, organizationId: string) {
  const result = await supabase
    .from("motorist_call_recordings")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("status", "available")
    .not("call_id", "is", null)
    .not("storage_path", "is", null)
    .order("fetched_at", { ascending: true })
    .limit(20);
  throwOnError(result.error);
  return result.data ?? [];
}

async function loadTranscripts(supabase: AdminClient, organizationId: string, recordings: RecordingRow[]) {
  const map = new Map<string, TranscriptRow>();

  if (recordings.length === 0) {
    return map;
  }

  const result = await supabase
    .from("motorist_call_transcripts")
    .select("*")
    .eq("organization_id", organizationId)
    .in(
      "recording_id",
      recordings.map((recording) => recording.id),
    );
  throwOnError(result.error);

  for (const row of result.data ?? []) {
    if (row.recording_id) {
      map.set(row.recording_id, row);
    }
  }

  return map;
}

/** @internal exported for unit tests */
export function classifyCandidate(existing: TranscriptRow | undefined): "create" | "retry" | "reclaim" | "skip" {
  if (!existing) {
    return "create";
  }

  if (existing.status === "complete" || existing.status === "restricted" || existing.status === "pending") {
    return "skip";
  }

  if (existing.status === "failed") {
    return retryCount(existing) < MAX_RETRIES ? "retry" : "skip";
  }

  // status === "processing": reclaim only when the lease is stale.
  const updatedAt = Date.parse(existing.updated_at);
  return Number.isFinite(updatedAt) && Date.now() - updatedAt > PROCESSING_LEASE_MS ? "reclaim" : "skip";
}

async function claimTranscript(
  supabase: AdminClient,
  organizationId: string,
  recording: RecordingRow,
  existing: TranscriptRow | undefined,
): Promise<TranscriptRow | null> {
  if (!existing) {
    const created = await supabase
      .from("motorist_call_transcripts")
      .insert({
        organization_id: organizationId,
        call_id: recording.call_id!,
        recording_id: recording.id,
        status: "processing",
        language: "sk",
      })
      .select("*")
      .single();

    if (created.error) {
      // A concurrent run may have inserted the transcript first.
      return null;
    }

    await mirrorCallStatus(supabase, recording.call_id, "pending");
    return created.data;
  }

  const claimed = await supabase
    .from("motorist_call_transcripts")
    .update({ status: "processing" })
    .eq("id", existing.id)
    .eq("status", existing.status)
    .select("*");
  throwOnError(claimed.error);
  return claimed.data?.[0] ?? null;
}

async function transcribeRecording(supabase: AdminClient, recording: RecordingRow, transcript: TranscriptRow) {
  const download = await supabase.storage.from(recording.storage_bucket ?? RECORDINGS_BUCKET).download(recording.storage_path!);

  if (download.error || !download.data) {
    throw new TranscriptsProcessError(`Storage download failed: ${download.error?.message ?? "empty file"}`);
  }

  const call = await supabase.from("motorist_calls").select("id, direction").eq("id", transcript.call_id).maybeSingle();
  throwOnError(call.error);
  const direction = call.data?.direction === "outbound" ? "outbound" : "inbound";

  const transcription = await transcribeWithScribe({
    audio: await download.data.arrayBuffer(),
    mimeType: recording.mime_type,
  });

  const segments = buildSpeakerSegments(transcription.words, direction);
  const confidence = speakerAttributionConfidence(segments, transcription.words);

  if (!transcription.text.trim() && segments.length === 0) {
    throw new TranscriptsProcessError("Scribe returned an empty transcript.");
  }

  const updated = await supabase
    .from("motorist_call_transcripts")
    .update({
      status: "complete",
      transcript_text: transcription.text,
      speaker_segments: segments as unknown as Json,
      language: transcription.languageCode ?? "sk",
      model: "scribe_v2",
    })
    .eq("id", transcript.id);
  throwOnError(updated.error);

  const recordingMeta = await supabase
    .from("motorist_call_recordings")
    .update({
      metadata: {
        ...jsonRecord(recording.metadata),
        speaker_attribution: "asr",
        speaker_confidence: confidence,
        language_probability: transcription.languageProbability ?? null,
      } as Json,
    })
    .eq("id", recording.id);
  throwOnError(recordingMeta.error);

  await mirrorCallStatus(supabase, transcript.call_id, "complete");
}

async function markFailure(supabase: AdminClient, transcript: TranscriptRow, message: string) {
  const retries = retryCount(transcript) + 1;
  const exhausted = retries >= MAX_RETRIES;

  const updated = await supabase
    .from("motorist_call_transcripts")
    .update({
      status: "failed",
      extracted_fields: { ...jsonRecord(transcript.extracted_fields), retry_count: retries, last_error: message.slice(0, 500) } as Json,
    })
    .eq("id", transcript.id);
  throwOnError(updated.error);

  if (exhausted) {
    await mirrorCallStatus(supabase, transcript.call_id, "failed");
  }
}

// motorist_calls.transcript_status only allows not_requested/pending/complete/failed —
// "processing" lives on the transcript row alone (see the plan's enum-mirror warning).
async function mirrorCallStatus(supabase: AdminClient, callId: string | null, status: "pending" | "complete" | "failed") {
  if (!callId) {
    return;
  }

  const updated = await supabase.from("motorist_calls").update({ transcript_status: status }).eq("id", callId);
  throwOnError(updated.error);
}

/** @internal exported for unit tests */
export function buildSpeakerSegments(words: ScribeWord[], direction: "inbound" | "outbound"): SpeakerSegment[] {
  const usable = words.filter((word) => word.type === "word" && word.text?.trim());

  if (usable.length === 0) {
    return [];
  }

  const segments: SpeakerSegment[] = [];
  let current: SpeakerSegment | null = null;

  for (const word of usable) {
    const speakerId = word.speaker_id ?? null;
    const start = Number(word.start ?? 0);
    const end = Number(word.end ?? word.start ?? 0);
    const text = word.text.trim();
    const shouldStart =
      !current || current.speakerId !== speakerId || start - current.end > 2.5 || current.text.length > 480;

    if (shouldStart) {
      current = { speaker: speakerId ?? "speaker_0", speakerId, start, end, text };
      segments.push(current);
    } else {
      current!.text = `${current!.text} ${text}`;
      current!.end = end;
    }
  }

  // Deterministic role mapping heuristic: on inbound calls the dispatcher answers and
  // greets first; on outbound calls the called party speaks first.
  const firstSpeakerId = segments[0]?.speakerId ?? null;
  const firstRole = direction === "inbound" ? "dispecer" : "volajuci";
  const otherRole = firstRole === "dispecer" ? "volajuci" : "dispecer";
  const distinct = new Set(segments.map((segment) => segment.speakerId ?? "none"));

  for (const segment of segments) {
    if (distinct.size > 2) {
      // Conference / transferred calls keep the raw ASR labels.
      segment.speaker = segment.speakerId ?? "speaker_0";
    } else {
      segment.speaker = (segment.speakerId ?? null) === firstSpeakerId ? firstRole : otherRole;
    }
  }

  return segments;
}

/** @internal exported for unit tests */
export function speakerAttributionConfidence(segments: SpeakerSegment[], words: ScribeWord[]): number {
  const usable = words.filter((word) => word.type === "word" && word.text?.trim());
  const speakers = new Map<string, number>();

  for (const word of usable) {
    const key = word.speaker_id ?? "none";
    speakers.set(key, (speakers.get(key) ?? 0) + 1);
  }

  // Exactly two speakers that both actually talk is the expected shape of a call; a
  // single detected speaker or a crowd means the role mapping cannot be trusted.
  if (speakers.size !== 2 || usable.length < 10) {
    return 0.5;
  }

  const counts = [...speakers.values()].sort((left, right) => left - right);
  const minorityShare = counts[0] / usable.length;

  if (minorityShare < 0.05) {
    return 0.6;
  }

  const alternations = segments.length - 1;
  return alternations >= 2 ? 0.95 : 0.75;
}

async function analyzeCompletedTranscripts(
  supabase: AdminClient,
  organizationId: string,
  summary: TranscriptsProcessSummary,
  dryRun: boolean,
  maxItems: number,
) {
  if (!isCallAnalysisConfigured()) {
    summary.aiSkipped += 1;
    return;
  }

  const pendingAnalysis = await supabase
    .from("motorist_call_transcripts")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("status", "complete")
    .is("summary", null)
    .not("transcript_text", "is", null)
    .order("updated_at", { ascending: true })
    .limit(maxItems);
  throwOnError(pendingAnalysis.error);

  if ((pendingAnalysis.data ?? []).length === 0 || dryRun) {
    return;
  }

  const rubric = await loadQaRubric(supabase, organizationId);

  for (const transcript of pendingAnalysis.data ?? []) {
    try {
      const context = await loadAnalysisContext(supabase, transcript);
      const includeQa = context.speakerConfidence >= SPEAKER_CONFIDENCE_THRESHOLD;
      const analysis = await analyzeCallTranscript({
        transcriptText: transcript.transcript_text ?? "",
        segments: parseSegments(transcript.speaker_segments),
        direction: context.direction,
        durationSeconds: context.durationSeconds,
        rubric,
        includeQa,
      });

      const updated = await supabase
        .from("motorist_call_transcripts")
        .update({
          summary: analysis.summary,
          extracted_fields: {
            ...jsonRecord(transcript.extracted_fields),
            ...analysis.extracted_fields,
            qa_breakdown: analysis.qa_breakdown,
            qa_notes: analysis.qa_notes,
            qa_gated: !includeQa,
          } as Json,
          qa_score: analysis.qa_score,
          model: `scribe_v2+${"claude-opus-4-8"}`,
        })
        .eq("id", transcript.id);
      throwOnError(updated.error);

      const call = await supabase.from("motorist_calls").update({ summary: analysis.summary }).eq("id", transcript.call_id);
      throwOnError(call.error);
      summary.aiProcessed += 1;
    } catch (error) {
      summary.aiFailed += 1;
      summary.errors.push(`ai ${transcript.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function loadAnalysisContext(supabase: AdminClient, transcript: TranscriptRow) {
  const call = await supabase.from("motorist_calls").select("direction, duration_seconds").eq("id", transcript.call_id).maybeSingle();
  throwOnError(call.error);

  let speakerConfidence = 0;

  if (transcript.recording_id) {
    const recording = await supabase
      .from("motorist_call_recordings")
      .select("metadata")
      .eq("id", transcript.recording_id)
      .maybeSingle();
    throwOnError(recording.error);
    const metadata = jsonRecord(recording.data?.metadata ?? null);
    speakerConfidence = typeof metadata.speaker_confidence === "number" ? metadata.speaker_confidence : 0;
  }

  return {
    direction: (call.data?.direction === "outbound" ? "outbound" : "inbound") as "inbound" | "outbound",
    durationSeconds: call.data?.duration_seconds ?? null,
    speakerConfidence,
  };
}

async function loadQaRubric(supabase: AdminClient, organizationId: string) {
  const integration = await supabase
    .from("motorist_organization_integrations")
    .select("config")
    .eq("organization_id", organizationId)
    .eq("provider", "viptel")
    .maybeSingle();

  if (integration.error) {
    return DEFAULT_QA_RUBRIC;
  }

  const config = jsonRecord(integration.data?.config ?? null);
  return typeof config.qa_rubric === "string" && config.qa_rubric.trim() ? config.qa_rubric : DEFAULT_QA_RUBRIC;
}

function parseSegments(value: Json): SpeakerSegment[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is SpeakerSegment => Boolean(item && typeof item === "object" && "speaker" in item && "text" in item));
}

async function writeSummaryEvent(supabase: AdminClient, organizationId: string, summary: TranscriptsProcessSummary) {
  const result = await supabase.from("motorist_integration_raw_events").insert({
    organization_id: organizationId,
    provider: "viptel",
    channel: "internal",
    direction: "inbound",
    event_type: "transcripts.process_summary",
    status_code: summary.status === "failed" ? 500 : 200,
    payload: summary as unknown as Json,
  });

  if (result.error) {
    summary.errors.push(`summary event: ${result.error.message}`);
  }
}

function retryCount(transcript: TranscriptRow) {
  const fields = jsonRecord(transcript.extracted_fields);
  return typeof fields.retry_count === "number" ? fields.retry_count : 0;
}

function jsonRecord(value: Json | null): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

async function resolveOrganization(supabase: AdminClient) {
  const organizationId = process.env.MOTORIST_ORGANIZATION_ID?.trim();
  const query = organizationId
    ? supabase.from("motorist_organizations").select("id, active").eq("id", organizationId).maybeSingle()
    : supabase
        .from("motorist_organizations")
        .select("id, active")
        .eq("slug", process.env.MOTORIST_ORGANIZATION_SLUG?.trim() || DEFAULT_ORGANIZATION_SLUG)
        .maybeSingle();
  const result = await query;
  throwOnError(result.error);

  if (!result.data?.active) {
    throw new TranscriptsProcessError("Active organization was not found.", 404);
  }

  return result.data;
}

function throwOnError(error: { message: string } | null): asserts error is null {
  if (error) {
    if (error instanceof ScribeError) {
      throw error;
    }

    throw new TranscriptsProcessError(error.message);
  }
}
