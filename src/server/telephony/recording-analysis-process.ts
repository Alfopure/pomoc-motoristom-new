import "server-only";
import { createHash } from "node:crypto";
import type { Json } from "@/lib/supabase/database.types";
import { QUALITY_RUBRIC_VERSION } from "@/lib/telephony/recording-quality";
import { openAIBatchClient, OpenAIBatchError } from "@/lib/integrations/ai/openai-batch";
import { makeQualityAnalysisRequest, parseBatchResponseContent, parseQualityAnalysis } from "@/lib/integrations/ai/quality-analysis";
import { buildQualitySource, loadRecordingSourceRows, sourceRestricted } from "./recording-source";
import { record, reserveRecordingBudget, type RecordingJobContext, type RecordingJobOutcome } from "./recording-jobs";

const str = (value: Json | undefined): string | null => typeof value === "string" && value.length > 0 ? value : null;
const later = (minutes = 5) => new Date(Date.now() + minutes * 60_000).toISOString();
const terminal = new Set(["completed", "failed", "expired", "cancelled"]);
const queued = (): RecordingJobOutcome => ({ state: "queued", nextAttemptAt: new Date().toISOString() });

async function save(ctx: RecordingJobContext, checkpoint: Json, providerIds: Json = {}, paid = false) {
  if (!await ctx.checkpoint(checkpoint, paid, providerIds)) throw new Error("analysis_lease_lost");
}

export async function processRecordingAnalysisJob(ctx: RecordingJobContext): Promise<RecordingJobOutcome> {
  if (process.env.RECORDING_PROCESSING_ENABLED !== "true" || process.env.AI_TRANSCRIPT_ENABLED !== "true" || !ctx.policy.analysis_enabled || !ctx.policy.approved_at) return { state: "waiting", nextAttemptAt: later(), errorCode: "analysis_disabled" };
  const cp = record(ctx.job.checkpoint), ids = record(ctx.job.provider_ids);
  const client = openAIBatchClient({ signal: ctx.signal });
  let submissionAttempted = false;
  try {
    const rows = await loadRecordingSourceRows(ctx.admin, ctx.organizationId, ctx.job.call_id, ctx.signal);
    if (!rows || sourceRestricted(rows) || rows.call.recording_source_revision !== ctx.job.input_revision) return { state: "cancelled", errorCode: "analysis_source_changed" };
    if (!rows.call.ended_at || rows.recordings.length === 0 || rows.recordings.some((r) => r.status !== "available" || !rows.transcripts.some((t) => t.recording_id === r.id && t.audio_source_revision === r.source_revision && t.status === "complete"))) return { state: "waiting", nextAttemptAt: later(), errorCode: "analysis_source_pending" };
    const source = buildQualitySource(rows);
    const includeQuality = ctx.policy.quality_enabled && Boolean(ctx.policy.quality_legal_basis);
    const hash = createHash("sha256").update(JSON.stringify({ spans: source.spans.map(({ speakerLabel: _label, ...span }) => span),
      subjects: source.subjects.map(({ name: _name, ...subject }) => subject), revision: source.sourceRevision,
      gaps: source.gaps, holds: source.holds, quality: includeQuality, rubric: QUALITY_RUBRIC_VERSION })).digest("hex");
    if (str(cp.input_hash) && cp.input_hash !== hash) return { state: "cancelled", errorCode: "analysis_input_changed" };
    const customId = `call-${ctx.job.id}`;
    let inputId = str(ids.openai_input_file_id), batchId = str(ids.openai_batch_id);
    const stage = str(cp.analysis_stage);

    // Unknown uploads are reconciled by the unique technical filename. A page
    // limit is never taken as proof that a provider object does not exist.
    if (!inputId && stage === "uploading") {
      const page = await client.listFiles(str(cp.files_cursor) ?? undefined);
      const match = page.data.filter((f) => f.filename === `recording-${ctx.job.id}.jsonl`);
      if (match.length > 1) return { state: "submission_unknown", errorCode: "analysis_multiple_input_files", nextAttemptAt: later(60) };
      if (match[0]) {
        inputId = match[0].id;
        await save(ctx, { analysis_stage: "uploaded", files_cursor: null }, { openai_input_file_id: inputId });
        return queued();
      }
      if (page.hasMore && page.data.length) { await save(ctx, { files_cursor: page.data.at(-1)!.id }); return queued(); }
      await save(ctx, { files_cursor: null });
      return { state: "submission_unknown", errorCode: "analysis_upload_unconfirmed", nextAttemptAt: later(60) };
    }
    if (!inputId) {
      const body = makeQualityAnalysisRequest(source, includeQuality);
      const line = JSON.stringify({ custom_id: customId, method: "POST", url: "/v1/responses", body }) + "\n";
      const byteCount = new TextEncoder().encode(line).length;
      const terra = body.model === "gpt-5.6-terra";
      // Conservative reservation: one input token per UTF-8 byte plus maximum
      // billed output (including reasoning). Actual usage is kept at publication.
      if (!await reserveRecordingBudget(ctx, (byteCount * (terra ? 1 : 0.1) + 6000 * (terra ? 6 : 0.6)) / 1_000_000)) return { state: "waiting", errorCode: "analysis_budget_reached", nextAttemptAt: later(60) };
      await save(ctx, { analysis_stage: "uploading", input_hash: hash, input_file_sha256: createHash("sha256").update(line).digest("hex"), input_file_bytes: byteCount, custom_id: customId, model: body.model, quality_enabled: includeQuality, requested_at: new Date().toISOString() });
      submissionAttempted = true;
      const file = await client.upload(`recording-${ctx.job.id}.jsonl`, line);
      await save(ctx, { analysis_stage: "uploaded" }, { openai_input_file_id: file.id });
      submissionAttempted = false;
      return queued();
    }
    if (!batchId && stage === "creating_batch") {
      const page = await client.listBatches(str(cp.batches_cursor) ?? undefined);
      const matches = page.data.filter((b) => b.input_file_id === inputId && b.metadata.recording_job_id === ctx.job.id);
      if (matches.length > 1) return { state: "submission_unknown", errorCode: "analysis_multiple_batches", nextAttemptAt: later(60) };
      if (matches[0]) {
        await save(ctx, { analysis_stage: "batch_pending", batches_cursor: null }, { openai_batch_id: matches[0].id }); return queued();
      }
      if (page.hasMore && page.data.length) { await save(ctx, { batches_cursor: page.data.at(-1)!.id }); return queued(); }
      await save(ctx, { batches_cursor: null });
      return { state: "submission_unknown", errorCode: "analysis_submission_unconfirmed", nextAttemptAt: later(60) };
    }
    if (!batchId) {
      const file = await client.file(inputId);
      if (typeof file.expires_at !== "number" || file.expires_at * 1000 - Date.now() < 25 * 60 * 60_000) return { state: "failed", errorCode: "analysis_input_expiry_insufficient" };
      if (file.filename !== `recording-${ctx.job.id}.jsonl` || file.bytes !== cp.input_file_bytes || !str(cp.input_file_sha256)
        || createHash("sha256").update(await client.content(inputId)).digest("hex") !== cp.input_file_sha256) return { state: "failed", errorCode: "analysis_input_binding_failed" };
      await save(ctx, { analysis_stage: "creating_batch" }, {}, true);
      submissionAttempted = true;
      const batch = await client.create(inputId, ctx.job.id);
      batchId = batch.id;
      await save(ctx, { analysis_stage: "batch_pending" }, { openai_batch_id: batchId });
      submissionAttempted = false;
      return { state: "waiting", nextAttemptAt: later() };
    }
    const batch = await client.retrieve(batchId);
    if (batch.input_file_id !== inputId || batch.metadata.recording_job_id !== ctx.job.id) return { state: "failed", errorCode: "analysis_batch_binding_failed" };
    await save(ctx, { analysis_stage: "batch_pending", provider_status: batch.status }, {
      openai_output_file_id: batch.output_file_id, openai_error_file_id: batch.error_file_id,
    });
    if (!terminal.has(batch.status)) return { state: "waiting", nextAttemptAt: later() };
    if (batch.status !== "completed" || !batch.output_file_id) return { state: "failed", errorCode: `analysis_batch_${batch.status}` };
    const response = parseBatchResponseContent(await client.content(batch.output_file_id), customId);
    if (response.model !== cp.model && !response.model.startsWith(`${String(cp.model)}-`)) return { state: "failed", errorCode: "analysis_model_mismatch" };
    const result = parseQualityAnalysis(response.value, source, includeQuality);
    const { data, error } = await ctx.admin.rpc("motorist_recording_publish_analysis", {
      p_job_id: ctx.job.id, p_lease_token: ctx.job.lease_token!, p_lease_epoch: ctx.job.lease_epoch,
      p_input_hash: hash, p_model: response.model, p_rubric_version: QUALITY_RUBRIC_VERSION,
      p_result: result as unknown as Json, p_usage: response.usage as Json,
    }).abortSignal(ctx.signal);
    if (error) return { state: "waiting", errorCode: "analysis_publish_retryable", nextAttemptAt: later() };
    if (!data) return { state: "cancelled", errorCode: "analysis_publication_fenced" };
    return { state: "complete", checkpoint: { analysis_stage: "published", analysis_id: data } };
  } catch (error) {
    if (submissionAttempted && !(error instanceof OpenAIBatchError)) return { state: "submission_unknown", errorCode: "analysis_checkpoint_unconfirmed", nextAttemptAt: later() };
    if (error instanceof OpenAIBatchError) {
      const current = record(ctx.job.checkpoint);
      if (error.uncertain || ["uploading", "creating_batch"].includes(String(current.analysis_stage)) && error.status >= 500) return { state: "submission_unknown", errorCode: error.code, nextAttemptAt: later() };
      if (submissionAttempted && error.status >= 400 && error.status < 500) {
        // A definite provider rejection did not create an object. Preserve the
        // pre-submit stage on rate limiting; other rejections can be explicitly
        // retried as a new attempt without inventing an unknown provider object.
        return error.status === 429
          ? { state: "waiting", errorCode: error.code, checkpoint: { analysis_stage: str(cp.analysis_stage) }, nextAttemptAt: later() }
          : { state: "failed", errorCode: error.code, checkpoint: { analysis_stage: "rejected" } };
      }
      if (error.status === 429 || error.status >= 500) return { state: "waiting", errorCode: error.code, nextAttemptAt: later() };
      return { state: "failed", errorCode: error.code };
    }
    if (ctx.signal.aborted) return { state: "waiting", errorCode: "analysis_deadline", nextAttemptAt: later() };
    if (error instanceof Error && ["checkpoint_failed", "analysis_lease_lost", "recording_source_unavailable", "budget_reservation_failed"].includes(error.message)) return { state: "waiting", errorCode: "analysis_checkpoint_retryable", nextAttemptAt: later() };
    return { state: "failed", errorCode: error instanceof Error && /^(quality_|analysis_)[a-z_]+$/.test(error.message) ? error.message : "analysis_validation_failed" };
  }
}

export async function processRecordingAnalysisCleanupJob(ctx: RecordingJobContext): Promise<RecordingJobOutcome> {
  const client = openAIBatchClient({ signal: ctx.signal }), ids = record(ctx.job.provider_ids), cp = record(ctx.job.checkpoint);
  try {
    const sourceJobId = str(cp.source_job_id);
    const batchId = str(ids.openai_batch_id);
    if (!str(ids.openai_input_file_id) && cp.analysis_stage === "uploading") {
      if (!sourceJobId) throw new Error("analysis_cleanup_missing_correlation");
      const page = await client.listFiles(str(cp.cleanup_files_cursor) ?? undefined);
      const matches = page.data.filter((file) => file.filename === `recording-${sourceJobId}.jsonl`);
      if (matches.length === 1) {
        await save(ctx, { cleanup_files_cursor: null, analysis_stage: "uploaded" }, { openai_input_file_id: matches[0].id });
        return queued();
      }
      await save(ctx, { cleanup_files_cursor: page.hasMore && page.data.length ? page.data.at(-1)!.id : null });
      return { state: "waiting", nextAttemptAt: later(page.hasMore ? 5 : 60), errorCode: matches.length > 1 ? "analysis_cleanup_multiple_files" : "analysis_cleanup_upload_unconfirmed" };
    }
    if (!batchId && cp.analysis_stage === "creating_batch") {
      if (!sourceJobId || !str(ids.openai_input_file_id)) throw new Error("analysis_cleanup_missing_correlation");
      const page = await client.listBatches(str(cp.cleanup_batches_cursor) ?? undefined);
      const matches = page.data.filter((batch) => batch.input_file_id === ids.openai_input_file_id && batch.metadata.recording_job_id === sourceJobId);
      if (matches.length === 1) {
        await save(ctx, { cleanup_batches_cursor: null }, { openai_batch_id: matches[0].id });
        return queued();
      }
      await save(ctx, { cleanup_batches_cursor: page.hasMore && page.data.length ? page.data.at(-1)!.id : null });
      return { state: "waiting", nextAttemptAt: later(page.hasMore ? 5 : 60), errorCode: matches.length > 1 ? "analysis_cleanup_multiple_batches" : "analysis_cleanup_batch_unconfirmed" };
    }
    if (batchId) {
      const batch = await client.retrieve(batchId);
      if (!sourceJobId || batch.metadata.recording_job_id !== sourceJobId || str(ids.openai_input_file_id) && batch.input_file_id !== ids.openai_input_file_id) throw new Error("analysis_cleanup_binding_failed");
      await save(ctx, { cleanup_status: batch.status }, { openai_input_file_id: batch.input_file_id, openai_output_file_id: batch.output_file_id, openai_error_file_id: batch.error_file_id });
      if (!terminal.has(batch.status)) {
        if (batch.status !== "cancelling") await client.cancel(batchId);
        return { state: "waiting", nextAttemptAt: later(), errorCode: "analysis_cleanup_provider_pending" };
      }
    }
    const currentIds = record(ctx.job.provider_ids);
    const files = [...new Set([str(currentIds.openai_input_file_id), str(currentIds.openai_output_file_id), str(currentIds.openai_error_file_id)].filter((id): id is string => Boolean(id)))];
    const deleted = new Set(Array.isArray(cp.deleted_openai_files) ? cp.deleted_openai_files.filter((id): id is string => typeof id === "string") : []);
    for (const fileId of files) {
      if (deleted.has(fileId)) continue;
      try { await client.deleteFile(fileId); } catch (error) { if (!(error instanceof OpenAIBatchError && error.status === 404)) throw error; }
      deleted.add(fileId); await save(ctx, { deleted_openai_files: [...deleted] });
      if (Date.now() + 2000 >= ctx.deadline) return queued();
    }
    return { state: "complete", checkpoint: { cleanup_status: "provider_files_deleted", residual_retention: "Provider contractual metadata and abuse-monitoring retention may remain." } };
  } catch (error) {
    return { state: "waiting", nextAttemptAt: later(), errorCode: error instanceof OpenAIBatchError ? error.code : "analysis_cleanup_failed" };
  }
}
