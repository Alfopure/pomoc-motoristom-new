import "server-only";


import { type ScribeWord } from "@/lib/integrations/asr/scribe-client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

type Tables = Database["public"]["Tables"];
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

/** Compatibility endpoint: durable enqueue only. Paid ASR/AI runs exclusively through the fenced coordinator. */
export async function processTranscripts(options: { maxItems?: number; dryRun?: boolean } = {}): Promise<TranscriptsProcessSummary> {
 const summary: TranscriptsProcessSummary = { status: "disabled", organizationId: null, candidates: 0, processed: 0, failed: 0, skipped: 0, aiProcessed: 0, aiFailed: 0, aiSkipped: 0, errors: [] };
 if (process.env.RECORDING_PROCESSING_ENABLED !== "true" || process.env.TRANSCRIPTS_ENABLED !== "true") return summary;
 const admin = createSupabaseAdminClient();
 const org = await admin.from("motorist_organizations").select("id").eq("slug", DEFAULT_ORGANIZATION_SLUG).maybeSingle();
 if (org.error || !org.data) throw new TranscriptsProcessError("Organization unavailable.");
 summary.organizationId = org.data.id;
 const policy = await admin.from("motorist_call_recording_policies").select("approved_at,recording_enabled,transcription_enabled").eq("organization_id", org.data.id).maybeSingle();
 if (!policy.data?.approved_at || !policy.data.recording_enabled || !policy.data.transcription_enabled) return summary;
 const sources = await admin.from("motorist_call_recordings").select("id,call_id,source_revision").eq("organization_id", org.data.id).eq("status", "available").is("deleted_at", null).is("restricted_at", null).order("fetched_at").limit(resolveProcessLimits(options.maxItems).transcriptItems);
 if (sources.error) throw new TranscriptsProcessError("Recording queue unavailable.");
 summary.status = "ok"; summary.candidates = sources.data.length;
 for (const r of sources.data) {
  if (!r.call_id || options.dryRun) continue;
  const queued = await admin.from("motorist_call_processing_jobs").upsert({ organization_id: org.data.id,call_id: r.call_id,recording_id:r.id,kind:"asr",input_revision:r.source_revision,dedupe_key:`asr:${r.id}:${r.source_revision}` }, { onConflict:"organization_id,dedupe_key", ignoreDuplicates:true });
  if (queued.error) { summary.failed++; summary.errors.push("Recording enqueue failed."); } else summary.processed++;
 }
 return summary;
}

// Legacy display helpers retained for historical transcripts. These heuristics are never identity proof for QA.
export function resolveProcessLimits(maxItems?: number) {
  const transcriptItems = Math.max(1, Math.min(maxItems ?? MAX_ITEMS_PER_RUN, MAX_ITEMS_PER_RUN));

  return {
    transcriptItems,
    aiItems: maxItems === undefined ? MAX_AI_PER_RUN : Math.min(transcriptItems, MAX_AI_PER_RUN),
  };
}

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

function retryCount(transcript: TranscriptRow) { const fields = transcript.extracted_fields; return fields && typeof fields === "object" && !Array.isArray(fields) && typeof fields.retry_count === "number" ? fields.retry_count : 0; }
