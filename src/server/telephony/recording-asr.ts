import "server-only";
import { deleteScribeTranscript, ScribeAsyncError, scribeAsyncConfigured, submitScribeAsync, verifyScribeSignature } from '@/lib/integrations/asr/scribe-async';
import type { Json } from '@/lib/supabase/database.types';
import type { RecordingTranscriptSpan } from '@/lib/telephony/recording-quality';
import { record, reserveRecordingBudget, RecordingProcessingError, type RecordingAdmin, type RecordingJobContext, type RecordingJobOutcome, type RecordingRow } from './recording-jobs';
import { preserveRecordingAudioProvenance } from './recording-audio-integrity';
import { signedRecordingSource } from './recording-storage';

export function normalizeScribeLanguage(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z]{2,3}$/i.test(value)) return 'und';
  const language = value.toLowerCase();
  // Scribe identifies languages with ISO 639-3; application filters use 639-1.
  const supported: Record<string, string> = { slk: 'sk', slo: 'sk', ces: 'cs', cze: 'cs', eng: 'en', deu: 'de', ger: 'de' };
  return supported[language] ?? language;
}

export function verifiedMultiChannel(manifest: Json) {
  const data = record(manifest); const intervals = Array.isArray(data.intervals) ? data.intervals.map(record) : [];
  return data.timingVerified === true && record(data.audioFormat).channels === 2 && data.channelMappingVerified === true && data.coverage === 'verified' && data.identitySource === 'authenticated_leg_binding' && intervals.length > 0 && intervals.every(i => i.verified === true && (i.channel === 0 || i.channel === 1) && ['customer', 'operator'].includes(String(i.role)));
}
export async function processRecordingAsrJob(ctx: RecordingJobContext): Promise<RecordingJobOutcome> {
  const ids = record(ctx.job.provider_ids), checkpoint = record(ctx.job.checkpoint);
  if (ids.scribe_request_id || checkpoint.submit_started_at) return {
    state: Date.now() - Date.parse(String(checkpoint.submit_started_at)) > 24 * 3600_000 ? 'submission_unknown' : 'waiting',
    nextAttemptAt: new Date(Date.now() + 300_000).toISOString(),
  };
  if (!scribeAsyncConfigured() || process.env.TRANSCRIPTS_ENABLED !== 'true' || !ctx.policy.transcription_enabled) return { state: 'waiting', errorCode: 'scribe_disabled' };
  const r = ctx.recording;
  const measuredDuration = record(r?.participant_manifest).audioDurationSeconds;
  const durationSeconds = Math.max(r?.duration_seconds ?? 0, typeof measuredDuration === 'number' ? measuredDuration : 0);
  if (!r?.storage_path || r.status !== 'available' || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > ctx.policy.max_segment_seconds) throw new RecordingProcessingError('asr_source_invalid');
  if (r.started_at && r.ended_at && r.session_id && typeof record(r.metadata).recorder_id === 'string') {
    const session = await ctx.admin.from('motorist_call_sessions').select('*').eq('id', r.session_id).eq('organization_id', ctx.organizationId).abortSignal(ctx.signal).maybeSingle();
    if (session.error) throw new RecordingProcessingError('participant_refresh_failed', true);
    if (record(record(session.data?.metadata).recording).suppressionReason === 'objection') return {state:'cancelled',errorCode:'recording_objection'};
    if (session.data) {
      const { loadParticipantManifest } = await import('./state/participants');
      const topology = await loadParticipantManifest(ctx.admin, session.data, { startedAt: r.started_at, endedAt: r.ended_at, recorderId: String(record(r.metadata).recorder_id) }, ctx.signal);
      const manifest = preserveRecordingAudioProvenance(r.participant_manifest, topology as unknown as Json);
      const updated = await ctx.admin.from('motorist_call_recordings').update({ participant_manifest: manifest as unknown as Json }).eq('id', r.id).eq('organization_id', ctx.organizationId).is('deleted_at', null).is('restricted_at', null).abortSignal(ctx.signal);
      if (updated.error) throw new RecordingProcessingError('participant_refresh_failed', true);
      r.participant_manifest = manifest as unknown as Json;
    }
  }
  const multiChannel = verifiedMultiChannel(r.participant_manifest);
  // Conservative reserve, not an invoice: $1 per channel-hour bounds the pilot.
  if (!await reserveRecordingBudget(ctx, Math.max(0.01, durationSeconds / 3600 * (multiChannel ? 2 : 1)))) return { state: 'waiting', errorCode: 'daily_budget_exceeded' };
  const sourceUrl = await signedRecordingSource(r.storage_path, ctx.signal);
  if (!await ctx.checkpoint({ submit_started_at: new Date().toISOString(), multi_channel: multiChannel }, true)) return { state: 'cancelled', errorCode: 'lease_lost' };
  try {
    const ack = await submitScribeAsync({ sourceUrl, correlationToken: ctx.job.correlation_token, multiChannel, signal: ctx.signal });
    const binding = await ctx.admin.rpc('motorist_recording_bind_scribe_ack', {p_correlation_token:ctx.job.correlation_token,p_request_id:ack.requestId,p_provider_transcript_id:ack.transcriptionId}).abortSignal(ctx.signal);
    if(binding.error) throw new RecordingProcessingError('scribe_ack_bind_failed',true);
    // An early signed callback may already have completed this job; the CAS then refuses to overwrite it.
    await ctx.checkpoint({}, false, { scribe_request_id: ack.requestId, ...(ack.transcriptionId ? {scribe_transcript_id:ack.transcriptionId} : {}) });
    return { state: 'waiting', providerIds: { scribe_request_id: ack.requestId, ...(ack.transcriptionId ? {scribe_transcript_id:ack.transcriptionId} : {}) }, nextAttemptAt: new Date(Date.now() + 300_000).toISOString() };
  } catch (error) {
    if (error instanceof ScribeAsyncError) return { state: error.ambiguous ? 'submission_unknown' : 'failed', errorCode: error.code };
    throw error;
  }
}
export function parseScribeSpans(value: unknown, recording: RecordingRow, transcriptId: string, callStartedAt: string): RecordingTranscriptSpan[] {
  const transcription = record(value);
  if (!Array.isArray(transcription.words) || transcription.words.length > 100_000) throw new RecordingProcessingError('scribe_words_invalid');
  const start = Date.parse(recording.started_at ?? ''), callStart = Date.parse(callStartedAt);
  if (!Number.isFinite(start) || !Number.isFinite(callStart) || start < callStart) throw new RecordingProcessingError('recording_time_unknown');
  const offset = (start - callStart) / 1000, manifest = record(recording.participant_manifest);
  const intervals = Array.isArray(manifest.intervals) ? manifest.intervals.map(record) : [];
  const trusted = verifiedMultiChannel(recording.participant_manifest);
  const measuredDuration = typeof manifest.audioDurationSeconds === 'number' && Number.isFinite(manifest.audioDurationSeconds) && manifest.audioDurationSeconds > 0 ? manifest.audioDurationSeconds : null;
  const durationLimit = measuredDuration === null ? (recording.duration_seconds ?? 1800) + 1 : measuredDuration + 0.1;
  const spans: RecordingTranscriptSpan[] = [];
  for (const value of transcription.words) {
    const word = record(value); if (word.type !== 'word') continue;
    if (typeof word.text !== 'string' || word.text.length > 2000 || typeof word.start !== 'number' || typeof word.end !== 'number' || !Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < 0 || word.end < word.start || word.end > durationLimit) throw new RecordingProcessingError('scribe_word_invalid');
    const from = start + word.start * 1000, to = start + word.end * 1000;
    const matches = trusted ? intervals.filter(i => i.channel === word.channel_index && i.verified === true && i.audibleToCustomer === true && Date.parse(String(i.startedAt)) <= from && (i.endedAt == null || Date.parse(String(i.endedAt)) >= to)) : [];
    const identity = matches.length === 1 ? matches[0] : null;
    const role = identity?.role === 'customer' ? 'customer' : identity?.role === 'operator' && typeof identity.profileId === 'string' ? 'operator' : 'unknown';
    const operatorId = role === 'operator' ? String(identity!.profileId) : null;
    const label = typeof word.speaker_id === 'string' && /^[a-zA-Z0-9_-]{1,60}$/.test(word.speaker_id) ? word.speaker_id : typeof word.channel_index === 'number' ? `channel_${word.channel_index}` : 'speaker_unknown';
    const previous = spans.at(-1);
    if (previous && previous.speakerLabel === label && previous.role === role && previous.operatorId === operatorId && offset + word.start - previous.endSeconds < 1.5 && previous.text.length < 1200) {
      previous.text += ` ${word.text}`; previous.endSeconds = offset + word.end;
    } else spans.push({ id: `${recording.id}:${spans.length}`, transcriptId, segmentId: recording.id, startSeconds: offset + word.start, endSeconds: offset + word.end, text: word.text, speakerLabel: label, role, operatorId, identityVerified: role !== 'unknown' });
  }
  return spans;
}
export async function acceptScribeWebhook(admin: RecordingAdmin, raw: string, signature: string | null, signal: AbortSignal): Promise<'accepted' | 'ignored'> {
  if (!verifyScribeSignature(raw, signature, process.env.ELEVENLABS_SCRIBE_WEBHOOK_SECRET ?? '')) throw new RecordingProcessingError('scribe_signature_invalid');
  let payload: Record<string, Json | undefined>; try { payload = record(JSON.parse(raw)); } catch { throw new RecordingProcessingError('scribe_payload_invalid'); }
  if (payload.type !== 'speech_to_text_transcription' && payload.type !== 'speech_to_text.completed') return 'ignored';
  const data = record(payload.data), meta = record(data.webhook_metadata), transcript = data.transcription ? record(data.transcription) : data;
  if (typeof data.request_id !== 'string' && typeof data.requestId === 'string') data.request_id = data.requestId;
  const token = meta.correlation_token;
  if (typeof token !== 'string' || !/^[0-9a-f-]{36}$/i.test(token) || typeof data.request_id !== 'string' || data.request_id.length > 200) throw new RecordingProcessingError('scribe_correlation_invalid');
  const jobResult = await admin.from('motorist_call_processing_jobs').select('*').eq('correlation_token', token).eq('kind', 'asr').abortSignal(signal).maybeSingle();
  if (jobResult.error) throw new RecordingProcessingError('scribe_lookup_failed', true);
  const job = jobResult.data; if (!job?.recording_id) return 'ignored';
  const [source, call] = await Promise.all([
    admin.from('motorist_call_recordings').select('*').eq('id', job.recording_id).eq('organization_id', job.organization_id).abortSignal(signal).maybeSingle(),
    admin.from('motorist_calls').select('started_at').eq('id', job.call_id).eq('organization_id', job.organization_id).abortSignal(signal).maybeSingle(),
  ]);
  if (source.error || call.error) throw new RecordingProcessingError('scribe_lookup_failed', true);
  if (!source.data || !call.data?.started_at) return 'ignored';
  const deleted = source.data.deleted_at || source.data.restricted_at;
  const spans = deleted ? [] : parseScribeSpans(transcript, source.data, token, call.data.started_at);
  const text = typeof transcript.text === 'string' ? transcript.text : '';
  if (text.length > 300_000) throw new RecordingProcessingError('scribe_text_limit');
  const transcriptId = typeof transcript.transcription_id === 'string' ? transcript.transcription_id : typeof data.transcription_id === 'string' ? data.transcription_id : typeof record(job.provider_ids).scribe_transcript_id === 'string' ? String(record(job.provider_ids).scribe_transcript_id) : null;
  const result = await admin.rpc('motorist_recording_accept_scribe', { p_correlation_token: token, p_request_id: data.request_id, p_transcript_text: deleted ? '' : text, p_segments: spans as unknown as Json, p_language: normalizeScribeLanguage(transcript.language_code), p_provider_transcript_id: transcriptId }).abortSignal(signal);
  if (result.error) throw new RecordingProcessingError('scribe_persist_failed', true);
  return result.data ? 'accepted' : 'ignored';
}
export async function processScribeCleanupJob(ctx: RecordingJobContext): Promise<RecordingJobOutcome> {
  const id = record(ctx.job.provider_ids).scribe_transcript_id;
  if (typeof id !== 'string') return { state: 'waiting', errorCode: 'scribe_retention_unconfirmed', checkpoint: { residual_retention: true } };
  await deleteScribeTranscript(id, ctx.signal);
  return { state: 'complete', checkpoint: { provider_deleted_at: new Date().toISOString(), residual_retention: false } };
}
