import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Json } from "@/lib/supabase/database.types";
import { qualityModelOutputFixture, qualitySourceFixture } from "@/test/quality-source-fixture";
import type { RecordingJobContext } from "./recording-jobs";
const io = vi.hoisted(() => ({ client: Object.fromEntries(["upload", "create", "retrieve", "file", "content", "deleteFile", "listFiles", "listBatches", "cancel"].map((key) => [key, vi.fn()])), load: vi.fn(), build: vi.fn(), restricted: vi.fn(), budget: vi.fn() }));
vi.mock("@/lib/integrations/ai/openai-batch", async (original) => ({ ...await original<typeof import("@/lib/integrations/ai/openai-batch")>(), openAIBatchClient: () => io.client }));
vi.mock("./recording-source", () => ({ loadRecordingSourceRows: io.load, buildQualitySource: io.build, sourceRestricted: io.restricted }));
vi.mock("./recording-jobs", async (original) => ({ ...await original<typeof import("./recording-jobs")>(), reserveRecordingBudget: io.budget }));
import { processRecordingAnalysisCleanupJob, processRecordingAnalysisJob } from "./recording-analysis-process";
import { OpenAIBatchError } from "@/lib/integrations/ai/openai-batch";
const jobId = "11111111-1111-4111-8111-111111111111";
const inputLine = "synthetic-input\n";
const inputHash = createHash("sha256").update(inputLine).digest("hex");
function context(checkpoint: Json = {}, ids: Json = {}) {
  checkpoint = { input_file_sha256: inputHash, input_file_bytes: Buffer.byteLength(inputLine), ...checkpoint as object };
  const rpc = vi.fn(() => ({ abortSignal: vi.fn().mockResolvedValue({ data: "analysis-id", error: null }) }));
  const ctx = { admin: { rpc }, organizationId: "org", job: { id: jobId, call_id: "call", input_revision: 1, checkpoint, provider_ids: ids, lease_token: "lease", lease_epoch: 3 },
    policy: { analysis_enabled: true, approved_at: "2026-09-06", quality_enabled: true, quality_legal_basis: "approved" }, signal: AbortSignal.timeout(10000), deadline: Date.now() + 10000 } as unknown as RecordingJobContext;
  ctx.checkpoint = vi.fn(async (patch, _paid, providerIds) => { ctx.job.checkpoint = { ...ctx.job.checkpoint as object, ...patch as object }; ctx.job.provider_ids = { ...ctx.job.provider_ids as object, ...providerIds as object }; return true; });
  return ctx;
}
const batch = (status = "completed") => ({ id: "batch_test", status, input_file_id: "file-input", output_file_id: "file-output", error_file_id: null, metadata: { recording_job_id: jobId }, created_at: 1 });
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("RECORDING_PROCESSING_ENABLED", "true"); vi.stubEnv("AI_TRANSCRIPT_ENABLED", "true"); vi.stubEnv("OPENAI_CALL_ANALYSIS_MODEL", "gpt-5.6-luna");
  io.load.mockResolvedValue({ call: { recording_source_revision: 1, ended_at: "2026-09-06" }, recordings: [{ id: "r", source_revision: 1, status: "available" }], transcripts: [{ recording_id: "r", audio_source_revision: 1, status: "complete" }] });
  io.build.mockReturnValue(qualitySourceFixture()); io.restricted.mockReturnValue(false); io.budget.mockResolvedValue(true);
  io.client.file.mockResolvedValue({ filename: `recording-${jobId}.jsonl`, bytes: Buffer.byteLength(inputLine), expires_at: Math.floor(Date.now() / 1000) + 172800 });
  io.client.upload.mockResolvedValue({ id: "file-input" }); io.client.create.mockResolvedValue(batch("validating")); io.client.retrieve.mockResolvedValue(batch());
  io.client.deleteFile.mockResolvedValue(undefined); io.client.listFiles.mockResolvedValue({ data: [], hasMore: false }); io.client.listBatches.mockResolvedValue({ data: [], hasMore: false });
  io.client.content.mockResolvedValue(JSON.stringify({ custom_id: `call-${jobId}`, error: null, response: { status_code: 200, body: { status: "completed", model: "gpt-5.6-luna", usage: { input_tokens: 50, output_tokens: 100 }, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(qualityModelOutputFixture()) }] }] } } }));
});
describe("durable GPT analysis", () => {
  it("performs no provider work with disabled policy, restricted source or obsolete revision", async () => {
    const ctx = context(); ctx.policy.analysis_enabled = false;
    expect(await processRecordingAnalysisJob(ctx)).toMatchObject({ state: "waiting", errorCode: "analysis_disabled" });
    ctx.policy.analysis_enabled = true; io.restricted.mockReturnValue(true);
    expect(await processRecordingAnalysisJob(ctx)).toMatchObject({ state: "cancelled" });
    io.restricted.mockReturnValue(false); ctx.job.input_revision = 2;
    expect(await processRecordingAnalysisJob(ctx)).toMatchObject({ state: "cancelled" });
    expect(io.client.upload).not.toHaveBeenCalled(); expect(io.client.create).not.toHaveBeenCalled();
  });
  it("reserves bounded spend and persists upload intent before a single upload", async () => {
    const ctx = context(); expect(await processRecordingAnalysisJob(ctx)).toMatchObject({ state: "queued" });
    expect(io.budget).toHaveBeenCalledOnce(); expect(io.client.upload).toHaveBeenCalledOnce(); expect(io.client.create).not.toHaveBeenCalled();
    expect(vi.mocked(ctx.checkpoint).mock.invocationCallOrder[0]).toBeLessThan(io.client.upload.mock.invocationCallOrder[0]);
    expect(ctx.job.provider_ids).toMatchObject({ openai_input_file_id: "file-input" });
  });
  it("leaves a lost upload acknowledgement unknown and never uploads again", async () => {
    const ctx = context(); io.client.upload.mockRejectedValueOnce(new OpenAIBatchError("openai_transport_failed", 502, true));
    expect(await processRecordingAnalysisJob(ctx)).toMatchObject({ state: "submission_unknown" });
    expect(await processRecordingAnalysisJob(ctx)).toMatchObject({ state: "submission_unknown", errorCode: "analysis_upload_unconfirmed" });
    expect(io.client.upload).toHaveBeenCalledOnce();
  });
  it("reconciles unknown input by exact job filename and persists an exhausted cursor reset", async () => {
    const ctx = context({ analysis_stage: "uploading", files_cursor: "file-old" });
    expect(await processRecordingAnalysisJob(ctx)).toMatchObject({ state: "submission_unknown" });
    expect(ctx.job.checkpoint).toMatchObject({ files_cursor: null });
    io.client.listFiles.mockResolvedValueOnce({ data: [{ id: "file-found", filename: `recording-${jobId}.jsonl` }], hasMore: true });
    expect(await processRecordingAnalysisJob(ctx)).toMatchObject({ state: "queued" }); expect(ctx.job.provider_ids).toMatchObject({ openai_input_file_id: "file-found" });
    expect(io.client.upload).not.toHaveBeenCalled();
  });
  it("cannot create a24h batch from an input with less than25h remaining", async () => {
    io.client.file.mockResolvedValueOnce({ expires_at: Math.floor(Date.now()/1000)+24*3600 });
    expect(await processRecordingAnalysisJob(context({ analysis_stage: "uploaded" }, { openai_input_file_id: "file-input" }))).toMatchObject({ state: "failed", errorCode: "analysis_input_expiry_insufficient" });
    expect(io.client.create).not.toHaveBeenCalled();
  });
  it("persists paid intent before creating one batch and resumes polling by durable ID", async () => {
    const ctx = context({ analysis_stage: "uploaded" }, { openai_input_file_id: "file-input" });
    io.client.content.mockResolvedValueOnce(inputLine);
    expect(await processRecordingAnalysisJob(ctx)).toMatchObject({ state: "waiting" });
    expect(ctx.checkpoint).toHaveBeenCalledWith({ analysis_stage: "creating_batch" }, true, {});
    expect(ctx.job.provider_ids).toMatchObject({ openai_batch_id: "batch_test" }); expect(io.client.create).toHaveBeenCalledOnce();
  });
  it("keeps an accepted paid batch unknown if its acknowledgement checkpoint fails", async () => {
    const ctx = context({ analysis_stage: "uploaded" }, { openai_input_file_id: "file-input" });
    io.client.content.mockResolvedValueOnce(inputLine);
    const persist = vi.mocked(ctx.checkpoint).getMockImplementation()!;
    vi.mocked(ctx.checkpoint).mockImplementationOnce(persist).mockRejectedValueOnce(new Error("checkpoint_failed"));
    expect(await processRecordingAnalysisJob(ctx)).toMatchObject({ state: "submission_unknown", errorCode: "analysis_checkpoint_unconfirmed" });
    expect(io.client.create).toHaveBeenCalledOnce();
  });
  it("keeps a lost upload checkpoint unknown whether the database committed or not", async () => {
    for (const committed of [false, true]) {
      const ctx = context();
      const persist = vi.mocked(ctx.checkpoint).getMockImplementation()!;
      vi.mocked(ctx.checkpoint).mockImplementationOnce(persist).mockImplementationOnce(async (...args) => { if (committed) await persist(...args); throw new Error("checkpoint_failed"); });
      expect(await processRecordingAnalysisJob(ctx)).toMatchObject({ state: "submission_unknown", errorCode: "analysis_checkpoint_unconfirmed" });
    }
  });
  it("refuses a matching filename containing another input before paid submission", async () => {
    io.client.content.mockResolvedValueOnce("different-content");
    expect(await processRecordingAnalysisJob(context({ analysis_stage: "uploaded" }, { openai_input_file_id: "file-input" }))).toMatchObject({ state: "failed", errorCode: "analysis_input_binding_failed" });
    expect(io.client.create).not.toHaveBeenCalled();
  });
  it("reconciles unknown batch by input AND source job, with no resubmission after empty listing", async () => {
    const ctx = context({ analysis_stage: "creating_batch", batches_cursor: "batch_old" }, { openai_input_file_id: "file-input" });
    expect(await processRecordingAnalysisJob(ctx)).toMatchObject({ state: "submission_unknown" }); expect(ctx.job.checkpoint).toMatchObject({ batches_cursor: null });
    io.client.listBatches.mockResolvedValueOnce({ data: [batch("validating")], hasMore: false });
    expect(await processRecordingAnalysisJob(ctx)).toMatchObject({ state: "queued" }); expect(io.client.create).not.toHaveBeenCalled();
  });
  it("rejects a mismatched provider object before reading content", async () => {
    io.client.retrieve.mockResolvedValueOnce({ ...batch(), metadata: { recording_job_id: "other-job" } });
    expect(await processRecordingAnalysisJob(context({}, { openai_input_file_id: "file-input", openai_batch_id: "batch_test" }))).toMatchObject({ errorCode: "analysis_batch_binding_failed" });
    expect(io.client.content).not.toHaveBeenCalled();
  });
  it("publishes validated content only through source and lease fenced RPC", async () => {
    const ctx = context({ model: "gpt-5.6-luna" }, { openai_input_file_id: "file-input", openai_batch_id: "batch_test" });
    expect(await processRecordingAnalysisJob(ctx)).toMatchObject({ state: "complete" });
    expect(ctx.admin.rpc).toHaveBeenCalledWith("motorist_recording_publish_analysis", expect.objectContaining({ p_lease_token: "lease", p_lease_epoch: 3, p_rubric_version: "motorist-quality-v1", p_result: expect.objectContaining({ operators: [expect.objectContaining({ score: 100 })] }) }));
  });
});
describe("provider erasure reconciliation", () => {
  it("does not claim erased while an unknown upload or batch has no match", async () => {
    for (const stage of ["uploading", "creating_batch"]) {
      const ctx = context({ analysis_stage: stage, source_job_id: jobId }, stage === "uploading" ? {} : { openai_input_file_id: "file-input" });
      expect(await processRecordingAnalysisCleanupJob(ctx)).toMatchObject({ state: "waiting" });
    }
    expect(io.client.deleteFile).not.toHaveBeenCalled();
  });
  it("cancels running batch and waits for terminal status before deleting any file", async () => {
    io.client.retrieve.mockResolvedValueOnce(batch("in_progress"));
    const ctx = context({ source_job_id: jobId }, { openai_input_file_id: "file-input", openai_batch_id: "batch_test" });
    expect(await processRecordingAnalysisCleanupJob(ctx)).toMatchObject({ state: "waiting" });
    expect(io.client.cancel).toHaveBeenCalledWith("batch_test"); expect(io.client.deleteFile).not.toHaveBeenCalled();
    expect(await processRecordingAnalysisCleanupJob(ctx)).toMatchObject({ state: "complete" });
    expect(io.client.deleteFile.mock.calls.map(([id]) => id)).toEqual(["file-input", "file-output"]);
  });
  it("does not cancel or delete provider objects belonging to another job", async () => {
    io.client.retrieve.mockResolvedValueOnce({ ...batch(), metadata: { recording_job_id: "other-job" } });
    expect(await processRecordingAnalysisCleanupJob(context({ source_job_id: jobId }, { openai_batch_id: "batch_test" }))).toMatchObject({ state: "waiting" });
    expect(io.client.cancel).not.toHaveBeenCalled(); expect(io.client.deleteFile).not.toHaveBeenCalled();
  });
  it("stops cleanup mutations when checkpoint lease has been lost", async () => {
    const ctx = context({ source_job_id: jobId }, { openai_batch_id: "batch_test" }); vi.mocked(ctx.checkpoint).mockResolvedValue(false);
    expect(await processRecordingAnalysisCleanupJob(ctx)).toMatchObject({ state: "waiting" }); expect(io.client.deleteFile).not.toHaveBeenCalled();
  });
});
