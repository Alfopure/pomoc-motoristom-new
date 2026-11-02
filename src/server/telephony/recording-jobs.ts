import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import { sessionApiRegion } from "./latency-flags";
import { CLOUDFLARE_SIGNATURE_BANNED_CODE, cloudflareSignatureBanned } from "./telnyx/client";
import { apiBaseUrlFor, getTelnyxConfig, TELNYX_DEFAULT_API_BASE_URL, TELNYX_DEFAULT_EU_API_BASE_URL } from "./telnyx/env";

export type RecordingAdmin = SupabaseClient<Database>;
export type RecordingJob = Database["public"]["Tables"]["motorist_call_processing_jobs"]["Row"];
export type RecordingRow = Database["public"]["Tables"]["motorist_call_recordings"]["Row"];
export type RecordingPolicy = Database["public"]["Tables"]["motorist_call_recording_policies"]["Row"];
export type RecordingJobOutcome = {
  state: "queued" | "waiting" | "submission_unknown" | "complete" | "failed" | "cancelled";
  checkpoint?: Json; providerIds?: Json; nextAttemptAt?: string; errorCode?: string;
};
export type RecordingJobContext = {
  admin: RecordingAdmin; organizationId: string; job: RecordingJob;
  recording: RecordingRow | null; recordings: RecordingRow[]; policy: RecordingPolicy;
  signal: AbortSignal; deadline: number;
  checkpoint: (patch: Json, paidSubmit?: boolean, providerIds?: Json) => Promise<boolean>;
};
export class RecordingProcessingError extends Error {
  constructor(readonly code: string, readonly retryable = false) { super(code); this.name = "RecordingProcessingError"; }
}
export function record(value: unknown): Record<string, Json | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, Json | undefined> : {};
}
/**
 * Call-speed S5: the Telnyx REST base for this recording's GET and DELETE. A
 * recording lives in the API region of the session that created it
 * (`metadata.start_mode.apiRegion`); no session, or one from before S5, is
 * `us`. An unreadable session fails the step for a retry rather than guessing:
 * cleanup would take the wrong region's 404 for "already removed".
 */
export async function recordingApiBaseUrl(ctx: Pick<RecordingJobContext, "admin" | "organizationId" | "recording" | "signal">): Promise<string> {
  const config = getTelnyxConfig();
  const bases = config.configured ? config : { apiBaseUrl: TELNYX_DEFAULT_API_BASE_URL, euApiBaseUrl: TELNYX_DEFAULT_EU_API_BASE_URL };
  const sessionId = ctx.recording?.session_id;
  if (!sessionId) return apiBaseUrlFor(bases, "us");
  const session = await ctx.admin.from("motorist_call_sessions").select("metadata").eq("organization_id", ctx.organizationId)
    .eq("id", sessionId).abortSignal(ctx.signal).maybeSingle();
  if (session.error) throw new RecordingProcessingError("recording_region_unavailable", true);
  return apiBaseUrlFor(bases, sessionApiRegion(session.data?.metadata));
}
/**
 * `GET`/`DELETE /recordings/:id` in the recording's region. A Cloudflare 1010
 * refusal (S5) never reached Telnyx: it is our User-Agent, so it is logged as
 * a configuration error and fails the step without a retry of its own, rather
 * than reading as a denied, missing or unconfirmed recording.
 */
export async function fetchTelnyxRecording(ctx: Pick<RecordingJobContext, "admin" | "organizationId" | "recording" | "signal">, recordingId: string, init: RequestInit): Promise<Response> {
  const base = await recordingApiBaseUrl(ctx);
  const response = await fetch(`${base}/recordings/${encodeURIComponent(recordingId)}`, init);
  if (response.status !== 403) return response;
  const text = await response.clone().text().catch(() => "");
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* A text body is checked as text. */ }
  if (!cloudflareSignatureBanned(403, body)) return response;
  await response.body?.cancel();
  console.error(JSON.stringify({ scope: "recording", level: "error", code: CLOUDFLARE_SIGNATURE_BANNED_CODE, method: init.method ?? "GET", host: new URL(base).hostname }));
  throw new RecordingProcessingError(CLOUDFLARE_SIGNATURE_BANNED_CODE);
}
export async function enqueueSavedRecording(admin: RecordingAdmin, input: {
  organizationId: string; callId: string; sessionId: string; providerRecordingId: string;
  recorderId?: string | null; providerSessionId?: string | null; startedAt?: string | null; endedAt?: string | null;
  durationSeconds?: number | null; sourceUrl?: string | null; participantManifest?: Json;
}) {
  const { data, error } = await admin.rpc("motorist_recording_enqueue_saved", {
    p_organization_id: input.organizationId, p_call_id: input.callId, p_session_id: input.sessionId,
    p_provider_recording_id: input.providerRecordingId, p_metadata: {
      recorderId: input.recorderId ?? null, providerSessionId: input.providerSessionId ?? null, startedAt: input.startedAt ?? null,
      endedAt: input.endedAt ?? null, durationSeconds: input.durationSeconds == null ? null : Math.ceil(input.durationSeconds),
      sourceUrl: input.sourceUrl ?? null, participantManifest: input.participantManifest ?? {},
    },
  });
  if (error || !data) throw new RecordingProcessingError("recording_enqueue_failed", true);
  return data;
}
export async function checkpointRecordingJob(ctx: Omit<RecordingJobContext, "checkpoint">, patch: Json, paidSubmit = false, providerIds: Json = {}) {
  if (ctx.signal.aborted || Date.now() >= ctx.deadline || !ctx.job.lease_token) return false;
  const { data, error } = await ctx.admin.rpc("motorist_recording_checkpoint_job", {
    p_job_id: ctx.job.id, p_lease_token: ctx.job.lease_token, p_lease_epoch: ctx.job.lease_epoch,
    p_checkpoint: patch, p_provider_ids: providerIds, p_paid_submit: paidSubmit,
  }).abortSignal(ctx.signal);
  if (error) throw new RecordingProcessingError("checkpoint_failed", true);
  if (data) {
    ctx.job.checkpoint = { ...record(ctx.job.checkpoint), ...record(patch) };
    ctx.job.provider_ids = { ...record(ctx.job.provider_ids), ...record(providerIds) };
    ctx.job.paid_submit_started = paidSubmit;
  }
  return data;
}
export async function reserveRecordingBudget(ctx: RecordingJobContext, usd: number) {
  if (!ctx.job.lease_token) return false;
  const { data, error } = await ctx.admin.rpc("motorist_recording_reserve_budget", {
    p_job_id: ctx.job.id, p_lease_token: ctx.job.lease_token, p_lease_epoch: ctx.job.lease_epoch, p_amount: usd,
  }).abortSignal(ctx.signal);
  if (error) throw new RecordingProcessingError("budget_reservation_failed", true);
  return data;
}
