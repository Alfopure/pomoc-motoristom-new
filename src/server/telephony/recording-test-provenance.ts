import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Json } from "@/lib/supabase/database.types";
import { getTestProviderSafety } from "./telnyx/test-safety";
import { assertRecordingProviderAccess } from "./recording-provider-safety";
import { record, RecordingProcessingError, type RecordingAdmin, type RecordingJob, type RecordingJobContext, type RecordingRow } from "./recording-jobs";

const ORIGIN = "test_processing_origin";
const PROOFS = "test_processing_resources";
const FIELDS = ["scribe_request_id", "scribe_transcript_id", "openai_input_file_id", "openai_batch_id", "openai_output_file_id", "openai_error_file_id"] as const;
const denied = () => new RecordingProcessingError("test_processing_provider_boundary");
const restricted = () => getTestProviderSafety().restricted;

function key() {
  const value = process.env.RECORDINGS_SYNC_SECRET?.trim();
  if (!getTestProviderSafety().deploymentAllowed || !value || value.length < 32) throw denied();
  return value;
}
function signature(job: RecordingJob, field: string, id: string) {
  if (![job.id, job.organization_id, job.call_id, job.correlation_token].every(value => typeof value === "string" && value.length > 0)) throw denied();
  return createHmac("sha256", key()).update(JSON.stringify([
    "motorist-test-processing-v1", job.kind, job.organization_id, job.id, job.call_id,
    job.recording_id, job.input_revision, job.correlation_token, field, id,
  ])).digest("hex");
}
function matches(actual: unknown, expected: string) {
  return typeof actual === "string" && /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}
function proofs(job: RecordingJob) { return record(record(job.checkpoint)[PROOFS]); }
function assertOrigin(job: RecordingJob) {
  if (!["asr", "analysis"].includes(job.kind) || !matches(record(job.checkpoint)[ORIGIN], signature(job, "origin", "v1"))) throw denied();
}
function assertIds(job: RecordingJob, ids: Json, evidence = proofs(job)) {
  for (const field of FIELDS) {
    const id = record(ids)[field];
    if (id == null) continue;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw denied();
    const proof = record(evidence[field]);
    if (proof.id !== id || !matches(proof.signature, signature(job, field, id))) throw denied();
  }
}

/** Production has no extra DB/provider work. TEST never adopts old in-progress jobs. */
export function assertTestProcessingJob(job: RecordingJob) {
  if (!restricted()) return;
  assertOrigin(job);
  assertIds(job, job.provider_ids);
}
export function assertTestProcessingResume(job: RecordingJob) {
  if (!restricted()) return;
  const cp = record(job.checkpoint);
  if (Object.keys(record(job.provider_ids)).length || cp.analysis_stage || cp.submit_started_at || cp[ORIGIN]) assertTestProcessingJob(job);
}
export async function beginTestProcessing(ctx: RecordingJobContext, recordings: RecordingRow[]) {
  if (!restricted()) return;
  if (process.env.MOTORIST_TEST_LIVE_INTEGRATIONS !== "true" || ctx.organizationId !== ctx.job.organization_id) throw denied();
  key();
  const cp = record(ctx.job.checkpoint);
  if (cp[ORIGIN]) { assertTestProcessingJob(ctx.job); return; }
  if (Object.keys(record(ctx.job.provider_ids)).length || cp.analysis_stage || cp.submit_started_at || ctx.job.paid_submit_started || !recordings.length) throw denied();
  // A pristine copied job is still not a TEST source. Verify actual ownership
  // before signing its first submission, without downloading provider audio.
  for (const recording of recordings) {
    if (recording.call_id !== ctx.job.call_id || recording.organization_id !== ctx.organizationId) throw denied();
    if (!await assertRecordingProviderAccess({ ...ctx, recording }, "import")) throw denied();
  }
  if (!await ctx.checkpoint({ [ORIGIN]: signature(ctx.job, "origin", "v1") })) throw denied();
}

/** Call only with resource IDs just returned by a bound provider response. */
function resourceCheckpoint(job: RecordingJob, patch: Json, ids: Json, owner = job): Json {
  if (!restricted()) return patch;
  assertOrigin(owner);
  const evidence = { ...proofs(owner), ...proofs(job) };
  assertIds(owner, owner.provider_ids);
  assertIds(owner, job.provider_ids, evidence);
  for (const field of FIELDS) {
    const id = record(ids)[field];
    if (id == null) continue;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) throw denied();
    const previous = record(evidence[field]);
    if (previous.id != null && (previous.id !== id || !matches(previous.signature, signature(owner, field, id)))) throw denied();
    evidence[field] = { id, signature: signature(owner, field, id) };
  }
  return { ...record(patch), [PROOFS]: evidence };
}
export async function checkpointTestProcessing(ctx: RecordingJobContext, patch: Json, paid = false, ids: Json = {}, owner = ctx.job) {
  return ctx.checkpoint(resourceCheckpoint(ctx.job, patch, ids, owner), paid, ids);
}

/** Scribe callbacks can win the lease race. CAS only our proof fields before
 * the existing atomic bind/accept RPC; never overwrite a concurrent checkpoint. */
export async function bindTestScribeResources(admin: RecordingAdmin, job: RecordingJob, ids: Json, signal: AbortSignal) {
  if (!restricted()) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    const read = await admin.from("motorist_call_processing_jobs").select("*").eq("id", job.id).eq("organization_id", job.organization_id).abortSignal(signal).maybeSingle();
    if (read.error || !read.data) throw denied();
    const current = read.data;
    assertTestProcessingJob(current);
    const checkpoint = resourceCheckpoint(current, current.checkpoint, ids);
    const write = await admin.from("motorist_call_processing_jobs").update({ checkpoint })
      .eq("id", current.id).eq("organization_id", current.organization_id)
      .eq("updated_at", current.updated_at).eq("checkpoint", JSON.stringify(current.checkpoint))
      .select("id").abortSignal(signal);
    if (write.error) throw denied();
    if (write.data?.length) { job.checkpoint = checkpoint; return; }
  }
  throw denied();
}

/** Cleanup remains possible after creation flags are off, but copied IDs,
 * substituted resources, another job's proof and unproven callbacks fail closed. */
export async function testCleanupSource(ctx: RecordingJobContext, kind: "asr" | "analysis"): Promise<RecordingJob | undefined> {
  if (!restricted()) return;
  key();
  const cp = record(ctx.job.checkpoint);
  const match = /^(?:scribe-cleanup|provider-cleanup):([0-9a-f-]{36})$/i.exec(ctx.job.dedupe_key);
  const sourceId = typeof cp.source_job_id === "string" ? cp.source_job_id : match?.[1];
  if (!sourceId || (match && sourceId !== match[1]) || ctx.job.organization_id !== ctx.organizationId) throw denied();
  const read = await ctx.admin.from("motorist_call_processing_jobs").select("*").eq("id", sourceId).eq("organization_id", ctx.organizationId).abortSignal(ctx.signal).maybeSingle();
  const source = read.data;
  if (read.error || !source || source.kind !== kind || source.call_id !== ctx.job.call_id || source.recording_id !== ctx.job.recording_id || source.input_revision !== ctx.job.input_revision) throw denied();
  assertTestProcessingJob(source);
  assertIds(source, ctx.job.provider_ids, { ...proofs(source), ...proofs(ctx.job) });
  return source;
}
