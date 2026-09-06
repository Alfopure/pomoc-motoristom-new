import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";

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
