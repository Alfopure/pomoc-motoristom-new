import "server-only";
import type { Json } from '@/lib/supabase/database.types';
import type { TelephonyCronJobResult } from './cron-jobs';
import { checkpointRecordingJob, record, RecordingProcessingError, type RecordingAdmin, type RecordingJob, type RecordingJobContext, type RecordingJobOutcome, type RecordingPolicy } from './recording-jobs';
import { deleteRecordingStorage, processRecordingImport } from './recording-storage';
import { processRecordingAsrJob, processScribeCleanupJob } from './recording-asr';

export const RECORDING_PROCESSING_BUDGET_MS = 15_000;
export function recordingProcessingDeadline(startedAt: number, now = Date.now()) { return Math.min(now + RECORDING_PROCESSING_BUDGET_MS, startedAt + 50_000); }
export function recordingJobEnabled(kind: string, policy: RecordingPolicy | null, env: Readonly<Record<string, string | undefined>> = process.env) {
  if (kind === 'delete' || kind === 'reconcile') return true;
  if (env.RECORDING_PROCESSING_ENABLED !== 'true' || !policy?.approved_at || !policy.recording_enabled) return false;
  if (kind === 'asr') return env.TRANSCRIPTS_ENABLED === 'true' && policy.transcription_enabled;
  if (kind === 'analysis') return env.AI_TRANSCRIPT_ENABLED === 'true' && policy.analysis_enabled;
  return kind === 'import';
}
async function deleteRecordingJob(ctx: RecordingJobContext): Promise<RecordingJobOutcome> {
  if (!ctx.recording) return { state: 'complete' };
  const originals = await ctx.admin.from('motorist_call_processing_jobs').select('checkpoint').eq('recording_id', ctx.recording.id).eq('organization_id', ctx.organizationId).eq('kind', 'import').abortSignal(ctx.signal);
  if (originals.error) throw new RecordingProcessingError('cleanup_lookup_failed', true);
  for (const row of originals.data ?? []) {
    const checkpoint = record(row.checkpoint);
    if (checkpoint.upload_url) await deleteRecordingStorage({ ...ctx, job: { ...ctx.job, checkpoint } });
  }
  await deleteRecordingStorage(ctx);
  const unresolvedUpload=(originals.data??[]).some(row=>record(row.checkpoint).upload_create_started_at&&!record(row.checkpoint).upload_url);
  const id = ctx.recording.provider_recording_id, key = process.env.TELNYX_API_KEY?.trim();
  if (id) {
    if (!key) throw new RecordingProcessingError('recording_provider_not_configured', true);
    const response = await fetch(`https://api.telnyx.com/v2/recordings/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${key}` }, cache: 'no-store', redirect: 'error', signal: ctx.signal });
    if (!response.ok && response.status !== 404) throw new RecordingProcessingError('recording_provider_delete_unconfirmed', true);
  }
  const result = await ctx.admin.from('motorist_call_recordings').update({ status: 'deleted', storage_path: null, metadata: { deleted: true } }).eq('id', ctx.recording.id).eq('organization_id', ctx.organizationId).not('deleted_at', 'is', null).abortSignal(ctx.signal);
  if (result.error) throw new RecordingProcessingError('recording_delete_persist_failed', true);
  if(unresolvedUpload)return {state:'waiting',errorCode:'upload_orphan_cleanup_unconfirmed',checkpoint:{local_audio_removed:true,provider_audio_removed:true,residual_retention:true}};
  return { state: 'complete', checkpoint: { local_deleted_at: new Date().toISOString(), provider_deleted_at: new Date().toISOString() } };
}
async function handleJob(ctx: RecordingJobContext): Promise<RecordingJobOutcome> {
  if (ctx.job.kind === 'import') return processRecordingImport(ctx);
  if (ctx.job.kind === 'asr') return processRecordingAsrJob(ctx);
  if (ctx.job.kind === 'analysis') return (await import('./recording-analysis-process')).processRecordingAnalysisJob(ctx);
  const scope = record(ctx.job.checkpoint).scope;
  if (scope === 'analysis_provider_only') return (await import('./recording-analysis-process')).processRecordingAnalysisCleanupJob(ctx);
  if (scope === 'scribe_provider_only') return processScribeCleanupJob(ctx);
  if (ctx.job.kind === 'delete' && scope === 'recording') return deleteRecordingJob(ctx);
  return { state: 'submission_unknown', errorCode: 'provider_reconciliation_required' };
}
export function failedRecordingOutcome(job: RecordingJob, error: unknown): RecordingJobOutcome {
  // Any failure after the durable paid marker leaves an unknown submission.
  if (job.paid_submit_started) return { state: 'submission_unknown', errorCode: 'paid_submit_ack_unknown' };
  const code = error instanceof RecordingProcessingError ? error.code : 'recording_processing_failed';
  const retryable = error instanceof RecordingProcessingError && error.retryable;
  const cleanup = job.kind === 'delete' || job.kind === 'reconcile';
  return { state: (cleanup || retryable && job.attempt < 3) ? 'waiting' : 'failed', errorCode: code, nextAttemptAt: new Date(Date.now() + Math.min(3600_000, 300_000 * 2 ** Math.min(job.attempt, 4))).toISOString() };
}
export async function runRecordingProcessing(input: { admin: RecordingAdmin; organizationId: string; cronStartedAt: number; handler?: (ctx: RecordingJobContext) => Promise<RecordingJobOutcome> }): Promise<TelephonyCronJobResult> {
  const jobName = 'telephony.recordings.process', deadline = recordingProcessingDeadline(input.cronStartedAt);
  if (deadline - Date.now() < 5_000) return { job: jobName, status: 'skipped', detail: { reason: 'live_safety_budget' } };
  const signal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  let processed = 0, failed = 0;
  try {
    // Read schema readiness without mutating a pre-migration deployment. Cleanup is independent of feature flags.
    const policyResult = await input.admin.from('motorist_call_recording_policies').select('*').eq('organization_id', input.organizationId).abortSignal(signal).maybeSingle();
    if (policyResult.error) return { job: jobName, status: 'skipped', detail: { reason: 'recording_schema_unavailable' } };
    const policy = policyResult.data;
    const swept = await input.admin.rpc('motorist_recording_sweep', { p_organization_id: input.organizationId }).abortSignal(signal);
    if (swept.error) throw new RecordingProcessingError('recording_sweep_failed', true);
    while (deadline - Date.now() >= 5_000 && processed < 10) {
      const claimed = await input.admin.rpc('motorist_recording_claim_job', { p_organization_id: input.organizationId, p_lease_seconds: Math.ceil((deadline - Date.now()) / 1000) + 5 }).abortSignal(signal);
      if (claimed.error) throw new RecordingProcessingError('recording_claim_failed', true);
      const job = claimed.data?.[0]; if (!job) break;
      let outcome: RecordingJobOutcome;
      if (!recordingJobEnabled(job.kind, policy)) outcome = { state: 'waiting', errorCode: 'recording_feature_disabled' };
      else {
        const rows = await input.admin.from('motorist_call_recordings').select('*').eq('organization_id', input.organizationId).eq('call_id', job.call_id).abortSignal(signal);
        if (rows.error) throw new RecordingProcessingError('recording_source_lookup_failed', true);
        const recordings = rows.data ?? [];
        const contextBase = { admin: input.admin, organizationId: input.organizationId, job, recording: recordings.find(r => r.id === job.recording_id) ?? null, recordings, policy: policy ?? { recording_enabled: false, transcription_enabled: false, analysis_enabled: false, quality_enabled: false } as RecordingPolicy, signal, deadline };
        const ctx: RecordingJobContext = { ...contextBase, checkpoint: (patch: Json, paid?: boolean, ids?: Json) => checkpointRecordingJob(contextBase, patch, paid, ids) };
        try { outcome = await (input.handler ?? handleJob)(ctx); } catch (error) { outcome = failedRecordingOutcome(job, error); }
      }
      // Reserve the final milliseconds for the fenced completion write; a timeout simply leaves the lease recoverable.
      const finished = await input.admin.rpc('motorist_recording_finish_job', { p_job_id: job.id, p_lease_token: job.lease_token!, p_lease_epoch: job.lease_epoch, p_state: outcome.state, p_checkpoint: outcome.checkpoint ?? {}, p_provider_ids: outcome.providerIds ?? {}, p_error_code: outcome.errorCode ?? null, p_next_attempt_at: outcome.nextAttemptAt ?? new Date(Date.now() + 300_000).toISOString() }).abortSignal(signal);
      if (finished.error) throw new RecordingProcessingError('recording_finish_failed', true);
      processed++; if (outcome.state === 'failed' || outcome.state === 'submission_unknown') failed++;
    }
    return { job: jobName, status: failed ? 'failed' : 'ok', detail: { processed, failed, expired: swept.data, deadlineMs: RECORDING_PROCESSING_BUDGET_MS } };
  } catch (error) {
    return { job: jobName, status: signal.aborted ? 'skipped' : 'failed', detail: { processed, failed }, error: signal.aborted ? 'recording_budget_exhausted' : error instanceof RecordingProcessingError ? error.code : 'recording_processing_failed' };
  }
}
