import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Json } from "@/lib/supabase/database.types";
import { createFakeSupabase } from "@/test/fake-supabase";
import { qualitySourceFixture } from "@/test/quality-source-fixture";
import { assertTestProcessingJob, beginTestProcessing, checkpointTestProcessing } from "./recording-test-provenance";
import { record, type RecordingJob, type RecordingJobContext, type RecordingRow } from "./recording-jobs";
import { acceptScribeWebhook, processRecordingAsrJob, processScribeCleanupJob } from "./recording-asr";
import { processRecordingAnalysisCleanupJob, processRecordingAnalysisJob } from "./recording-analysis-process";
vi.mock("./recording-storage", () => ({ signedRecordingSource: async () => "https://test.invalid/owned-audio" }));
const analysis = vi.hoisted(() => ({ load: vi.fn(), build: vi.fn() }));
vi.mock("./recording-source", () => ({ loadRecordingSourceRows: analysis.load, buildQualitySource: analysis.build, sourceRestricted: () => false }));
const TABLE = "motorist_call_processing_jobs";
const sourceId = "11111111-1111-4111-8111-111111111111";
const at = "2026-09-30T10:00:00.000Z";
function environment() {
  const env = {
    MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev", VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk",
    APP_BASE_URL: "https://test.dispecing.linkapomoci.sk", SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co", NEXT_PUBLIC_SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co",
    MOTORIST_TEST_LIVE_INTEGRATIONS: "true", MOTORIST_TEST_ALLOWED_NUMBERS: "+421900111222", MOTORIST_TEST_FROM_NUMBERS: "+421900333444",
    TELNYX_API_KEY: "synthetic", TELNYX_CALL_CONTROL_APP_ID: "test-app", TELNYX_CREDENTIAL_CONNECTION_ID: "test-sip",
    RECORDINGS_SYNC_SECRET: "synthetic-private-test-signing-key-123456789", ELEVENLABS_API_KEY: "synthetic", ELEVENLABS_SCRIBE_WEBHOOK_ID: "test-hook", ELEVENLABS_SCRIBE_WEBHOOK_SECRET: "synthetic-hook-secret",
    OPENAI_API_KEY: "synthetic", RECORDING_PROCESSING_ENABLED: "true", TRANSCRIPTS_ENABLED: "true", AI_TRANSCRIPT_ENABLED: "true",
  };
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
}
beforeEach(environment);
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function fixture(kind: "asr" | "analysis" = "asr") {
  const f = createFakeSupabase();
  const recording = { id: "recording", organization_id: "org", call_id: "call", provider_recording_id: "recording-test", provider_session_id: "session-test", started_at: at, ended_at: "2026-09-30T10:00:20Z", duration_seconds: 20, status: "available", storage_path: "owned.wav", participant_manifest: {}, metadata: {} } as RecordingRow;
  const job = { id: sourceId, kind, organization_id: "org", call_id: "call", recording_id: kind === "asr" ? "recording" : null, input_revision: 1, correlation_token: "22222222-2222-4222-8222-222222222222", checkpoint: {}, provider_ids: {}, paid_submit_started: false, updated_at: at, state: "processing", lease_token: "lease", dedupe_key: "original" } as RecordingJob;
  f.db.seed(TABLE, [job]); f.db.seed("motorist_call_recordings", [recording]); f.db.seed("motorist_calls", [{ id: "call", organization_id: "org", started_at: at }]);
  const ctx = { admin: f.admin, organizationId: "org", job, recording, recordings: [recording], policy: { transcription_enabled: true, analysis_enabled: true, approved_at: at, max_segment_seconds: 1800 }, signal: AbortSignal.timeout(10000), deadline: Date.now() + 10000 } as RecordingJobContext;
  ctx.checkpoint = vi.fn(async (patch, paid, ids) => {
    const current = f.db.find(TABLE, row => row.id === job.id)!;
    job.checkpoint = { ...record(job.checkpoint), ...record(patch) }; job.provider_ids = { ...record(job.provider_ids), ...record(ids) }; job.paid_submit_started = !!paid;
    f.db.update(TABLE, { checkpoint: { ...record(current.checkpoint), ...record(patch) }, provider_ids: { ...record(current.provider_ids), ...record(ids) }, paid_submit_started: !!paid }, row => row.id === job.id); return true;
  });
  f.db.registerRpc("motorist_recording_reserve_budget", () => true);
  f.db.registerRpc("motorist_recording_bind_scribe_ack", args => {
    f.db.update(TABLE, { provider_ids: { ...record(job.provider_ids), scribe_request_id: args.p_request_id, ...(args.p_provider_transcript_id ? { scribe_transcript_id: args.p_provider_transcript_id } : {}) } }, row => row.id === sourceId); return true;
  });
  f.db.registerRpc("motorist_recording_accept_scribe", args => {
    const current = f.db.find(TABLE, row => row.id === sourceId)!;
    f.db.update(TABLE, { provider_ids: { ...record(current.provider_ids), scribe_request_id: args.p_request_id, ...(args.p_provider_transcript_id ? { scribe_transcript_id: args.p_provider_transcript_id } : {}) }, state: "complete" }, row => row.id === sourceId); return true;
  });
  const wire = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api.telnyx.com")) return Response.json({ data: { id: "recording-test", connection_id: "test-app", call_session_id: "session-test" } });
    if (url.endsWith("/speech-to-text") && init?.method === "POST") return Response.json({ request_id: "request-test", transcription_id: "transcript-test" });
    if (init?.method === "DELETE") return url.includes("openai") ? Response.json({ id: url.split("/").at(-1), deleted: true }) : new Response(null, { status: 204 });
    throw new Error("Unexpected synthetic provider request");
  });
  vi.stubGlobal("fetch", wire);
  function cleanup() {
    const result = { ...ctx, job: { ...job, id: "33333333-3333-4333-8333-333333333333", kind: "delete", dedupe_key: `${kind === "asr" ? "scribe" : "provider"}-cleanup:${sourceId}`, checkpoint: kind === "asr" ? { scope: "scribe_provider_only" } : { ...record(job.checkpoint), scope: "analysis_provider_only", source_job_id: sourceId }, provider_ids: { ...record(job.provider_ids) } } } as RecordingJobContext;
    result.checkpoint = vi.fn(async (patch, _paid, ids) => { result.job.checkpoint = { ...record(result.job.checkpoint), ...record(patch) }; result.job.provider_ids = { ...record(result.job.provider_ids), ...record(ids) }; return true; });
    return result;
  }
  return { ...f, ctx, wire, cleanup };
}
function callback(job: RecordingJob, requestId = "request-test", transcriptId = "transcript-test") {
  const raw = JSON.stringify({ type: "speech_to_text_transcription", data: { request_id: requestId, transcription_id: transcriptId, webhook_metadata: { correlation_token: job.correlation_token }, transcription: { text: "Synthetic", words: [], language_code: "slk" } } });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = `t=${timestamp},v0=${createHmac("sha256", process.env.ELEVENLABS_SCRIBE_WEBHOOK_SECRET!).update(`${timestamp}.${raw}`).digest("hex")}`;
  return { raw, signature };
}
async function prove(f: ReturnType<typeof fixture>, ids: Json) {
  await beginTestProcessing(f.ctx, f.ctx.recordings);
  await checkpointTestProcessing(f.ctx, {}, false, ids);
  f.wire.mockClear();
}
describe("TEST recording provider provenance", () => {
  it("rejects copied ASR IDs on resume, cleanup and correctly signed callback before any provider action or accepting RPC", async () => {
    const f = fixture(); f.ctx.job.provider_ids = { scribe_request_id: "copied-request", scribe_transcript_id: "copied-transcript" };
    f.db.update(TABLE, { provider_ids: f.ctx.job.provider_ids }, () => true);
    await expect(processRecordingAsrJob(f.ctx)).rejects.toThrow("test_processing_provider_boundary");
    await expect(processScribeCleanupJob(f.cleanup())).rejects.toThrow("test_processing_provider_boundary");
    const event = callback(f.ctx.job);
    await expect(acceptScribeWebhook(f.admin, event.raw, event.signature, f.ctx.signal)).rejects.toThrow("test_processing_provider_boundary");
    expect(f.wire).not.toHaveBeenCalled(); expect(f.db.log.some(row => row.kind === "rpc")).toBe(false);
  });
  it("rejects copied OpenAI IDs before polling, cancel or delete even with creation enabled", async () => {
    const f = fixture("analysis"); f.ctx.job.provider_ids = { openai_batch_id: "batch_copied", openai_input_file_id: "file-copied" };
    f.db.update(TABLE, { provider_ids: f.ctx.job.provider_ids }, () => true);
    await expect(processRecordingAnalysisJob(f.ctx)).rejects.toThrow("test_processing_provider_boundary");
    await expect(processRecordingAnalysisCleanupJob(f.cleanup())).rejects.toThrow("test_processing_provider_boundary");
    expect(f.wire).not.toHaveBeenCalled();
  });
  it("submits new owned ASR, persists returned IDs, resumes without resubmission and cleans up after kill-off", async () => {
    const f = fixture();
    expect(await processRecordingAsrJob(f.ctx)).toMatchObject({ state: "waiting", providerIds: { scribe_request_id: "request-test", scribe_transcript_id: "transcript-test" } });
    expect(() => assertTestProcessingJob(f.ctx.job)).not.toThrow();
    f.wire.mockClear();
    expect(await processRecordingAsrJob(f.ctx)).toMatchObject({ state: "waiting" }); expect(f.wire).not.toHaveBeenCalled();
    vi.stubEnv("MOTORIST_TEST_LIVE_INTEGRATIONS", "false"); vi.stubEnv("TRANSCRIPTS_ENABLED", "false"); vi.stubEnv("RECORDING_PROCESSING_ENABLED", "false");
    expect(await processScribeCleanupJob(f.cleanup())).toMatchObject({ state: "complete" });
    expect(f.wire).toHaveBeenCalledExactlyOnceWith("https://api.elevenlabs.io/v1/speech-to-text/transcripts/transcript-test", expect.objectContaining({ method: "DELETE" }));
  });
  it("does not sign a pristine copied recording before checking actual TEST ownership", async () => {
    const f = fixture(); f.wire.mockResolvedValueOnce(Response.json({ data: { id: "recording-test", connection_id: "production-app", call_session_id: "session-test" } }));
    await expect(beginTestProcessing(f.ctx, f.ctx.recordings)).rejects.toThrow("test_recording_provider_boundary");
    expect(f.ctx.checkpoint).not.toHaveBeenCalled(); expect(f.wire).toHaveBeenCalledOnce();
  });
  it.each(["old intent", "old resources"])("never backfills unsigned %s", async scenario => {
    const f = fixture();
    if (scenario === "old intent") f.ctx.job.checkpoint = { submit_started_at: at }; else f.ctx.job.provider_ids = { scribe_transcript_id: "copied" };
    await expect(beginTestProcessing(f.ctx, f.ctx.recordings)).rejects.toThrow("test_processing_provider_boundary"); expect(f.wire).not.toHaveBeenCalled();
  });
  it.each(["scribe_transcript_id", "scribe_request_id"])("rejects a substituted %s inside a proven source and cleanup", async field => {
    const f = fixture(); await prove(f, { scribe_request_id: "request-test", scribe_transcript_id: "transcript-test" });
    const cleanup = f.cleanup(); cleanup.job.provider_ids = { ...record(cleanup.job.provider_ids), [field]: "foreign" };
    await expect(processScribeCleanupJob(cleanup)).rejects.toThrow("test_processing_provider_boundary");
    f.ctx.job.provider_ids = { ...record(f.ctx.job.provider_ids), [field]: "foreign" };
    expect(() => assertTestProcessingJob(f.ctx.job)).toThrow("test_processing_provider_boundary"); expect(f.wire).not.toHaveBeenCalled();
  });
  it("binds proof to original job, organization, call and key", async () => {
    const f = fixture(); await prove(f, { scribe_transcript_id: "transcript-test" });
    for (const patch of [{ id: "other-job" }, { call_id: "other-call" }, { organization_id: "other-org" }, { input_revision: 2 }]) expect(() => assertTestProcessingJob({ ...f.ctx.job, ...patch })).toThrow("test_processing_provider_boundary");
    vi.stubEnv("RECORDINGS_SYNC_SECRET", "different-private-test-signing-key-123456789");
    await expect(processScribeCleanupJob(f.cleanup())).rejects.toThrow("test_processing_provider_boundary"); expect(f.wire).not.toHaveBeenCalled();
  });
  it("accepts an early signed callback only for our submitted source and binds its exact transcript before persistence", async () => {
    const f = fixture(); await beginTestProcessing(f.ctx, f.ctx.recordings); await checkpointTestProcessing(f.ctx, { submit_started_at: at }, true);
    const event = callback(f.ctx.job); f.wire.mockClear();
    expect(await acceptScribeWebhook(f.admin, event.raw, event.signature, f.ctx.signal)).toBe("accepted");
    Object.assign(f.ctx.job, f.db.find(TABLE, row => row.id === sourceId));
    expect(() => assertTestProcessingJob(f.ctx.job)).not.toThrow();
    vi.stubEnv("MOTORIST_TEST_LIVE_INTEGRATIONS", "false");
    expect(await processScribeCleanupJob(f.cleanup())).toMatchObject({ state: "complete" });
    const foreign = callback(f.ctx.job, "foreign-request", "foreign-transcript"); const calls = f.db.log.filter(row => row.kind === "rpc").length;
    await expect(acceptScribeWebhook(f.admin, foreign.raw, foreign.signature, f.ctx.signal)).rejects.toThrow("test_processing_provider_boundary");
    expect(f.db.log.filter(row => row.kind === "rpc")).toHaveLength(calls);
  });
  it("preserves callback transcript proof when callback CAS wins between ACK bind and the lease checkpoint", async () => {
    const f = fixture();
    const wire = f.wire.getMockImplementation()!;
    f.wire.mockImplementation(async (url, init) => String(url).endsWith("/speech-to-text") && init?.method === "POST" ? Response.json({ request_id: "request-test" }) : wire(url, init));
    let entered!: () => void, release!: () => void;
    const callbackEntered = new Promise<void>(resolve => { entered = resolve; });
    const callbackRelease = new Promise<void>(resolve => { release = resolve; });
    let eventTask: Promise<string> | undefined;
    f.db.registerRpc("motorist_recording_accept_scribe", async args => {
      entered(); await callbackRelease;
      const current = f.db.find(TABLE, row => row.id === sourceId)!;
      f.db.update(TABLE, { provider_ids: { ...record(current.provider_ids), scribe_request_id: args.p_request_id, scribe_transcript_id: args.p_provider_transcript_id }, state: "complete" }, row => row.id === sourceId);
      return true;
    });
    f.db.registerRpc("motorist_recording_bind_scribe_ack", async args => {
      const event = callback(f.ctx.job);
      eventTask = acceptScribeWebhook(f.admin, event.raw, event.signature, f.ctx.signal);
      await callbackEntered;
      const current = f.db.find(TABLE, row => row.id === sourceId)!;
      f.db.update(TABLE, { provider_ids: { ...record(current.provider_ids), scribe_request_id: args.p_request_id } }, row => row.id === sourceId);
      return true;
    });
    expect(await processRecordingAsrJob(f.ctx)).toMatchObject({ state: "waiting" });
    release(); expect(await eventTask).toBe("accepted");
    Object.assign(f.ctx.job, f.db.find(TABLE, row => row.id === sourceId));
    expect(() => assertTestProcessingJob(f.ctx.job)).not.toThrow();
    vi.stubEnv("MOTORIST_TEST_LIVE_INTEGRATIONS", "false");
    expect(await processScribeCleanupJob(f.cleanup())).toMatchObject({ state: "complete" });
  });
  it("cleans proven OpenAI files after kill-off and rejects replacement IDs before a provider GET", async () => {
    const f = fixture("analysis"); await prove(f, { openai_input_file_id: "file-test" });
    vi.stubEnv("MOTORIST_TEST_LIVE_INTEGRATIONS", "false"); vi.stubEnv("AI_TRANSCRIPT_ENABLED", "false");
    const foreign = f.cleanup(); foreign.job.provider_ids = { openai_input_file_id: "file-production" };
    await expect(processRecordingAnalysisCleanupJob(foreign)).rejects.toThrow("test_processing_provider_boundary"); expect(f.wire).not.toHaveBeenCalled();
    expect(await processRecordingAnalysisCleanupJob(f.cleanup())).toMatchObject({ state: "complete" });
    expect(f.wire).toHaveBeenCalledExactlyOnceWith("https://api.openai.com/v1/files/file-test", expect.objectContaining({ method: "DELETE" }));
  });
  it("signs new OpenAI upload and batch ACKs, resumes them, then cancels and erases only their files after kill-off", async () => {
    const f = fixture("analysis");
    analysis.load.mockResolvedValue({ call: { recording_source_revision: 1, ended_at: at }, recordings: [{ ...f.ctx.recording, source_revision: 1 }], transcripts: [{ recording_id: "recording", audio_source_revision: 1, status: "complete" }] });
    analysis.build.mockReturnValue(qualitySourceFixture());
    let input = "", status = "validating";
    const batch = () => ({ id: "batch_test", status, input_file_id: "file-test", output_file_id: null, error_file_id: null, metadata: { recording_job_id: sourceId }, created_at: 1 });
    const file = () => ({ id: "file-test", filename: `recording-${sourceId}.jsonl`, created_at: Math.floor(Date.now()/1000), bytes: Buffer.byteLength(input), expires_at: Math.floor(Date.now()/1000) + 172800 });
    f.wire.mockImplementation(async (raw, init) => {
      const url = String(raw);
      if (url.includes("api.telnyx.com")) return Response.json({ data: { id: "recording-test", connection_id: "test-app", call_session_id: "session-test" } });
      if (url.endsWith("/files") && init?.method === "POST") { input = await ((init.body as FormData).get("file") as File).text(); return Response.json(file()); }
      if (url.endsWith("/files/file-test/content")) return new Response(input);
      if (url.endsWith("/files/file-test")) return init?.method === "DELETE" ? Response.json({ id: "file-test", deleted: true }) : Response.json(file());
      if (url.endsWith("/batches/batch_test/cancel")) { status = "cancelled"; return Response.json(batch()); }
      if (url.endsWith("/batches") || url.endsWith("/batches/batch_test")) return Response.json(batch());
      throw new Error("Unexpected synthetic provider request");
    });
    expect(await processRecordingAnalysisJob(f.ctx)).toEqual({ state: "queued", nextAttemptAt: expect.any(String) });
    expect(f.ctx.job.provider_ids).toMatchObject({ openai_input_file_id: "file-test" });
    expect(await processRecordingAnalysisJob(f.ctx)).toMatchObject({ state: "waiting" });
    expect(f.ctx.job.provider_ids).toMatchObject({ openai_batch_id: "batch_test" });
    expect(await processRecordingAnalysisJob(f.ctx)).toMatchObject({ state: "waiting" });
    expect(f.wire.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
    vi.stubEnv("MOTORIST_TEST_LIVE_INTEGRATIONS", "false"); vi.stubEnv("AI_TRANSCRIPT_ENABLED", "false");
    const cleanup = f.cleanup();
    expect(await processRecordingAnalysisCleanupJob(cleanup)).toMatchObject({ state: "waiting" });
    expect(await processRecordingAnalysisCleanupJob(cleanup)).toMatchObject({ state: "complete" });
    expect(f.wire.mock.calls.filter(([, init]) => init?.method === "DELETE").map(([url]) => url)).toEqual(["https://api.openai.com/v1/files/file-test"]);
  });
  it("reconciles our ambiguous upload once, signs the found file ID, then cleans it without another upload", async () => {
    const f = fixture("analysis"); await prove(f, {}); await checkpointTestProcessing(f.ctx, { analysis_stage: "uploading" });
    const cleanup = f.cleanup();
    f.wire.mockResolvedValueOnce(Response.json({ data: [{ id: "file-found", filename: `recording-${sourceId}.jsonl`, created_at: 1, bytes: 10 }], has_more: false }));
    expect(await processRecordingAnalysisCleanupJob(cleanup)).toMatchObject({ state: "queued" });
    expect(await processRecordingAnalysisCleanupJob(cleanup)).toMatchObject({ state: "complete" });
    expect(f.wire.mock.calls.map(([,init]) => init?.method)).toEqual(["GET", "DELETE"]);
  });
  it.each(["preview", "missing key"])("fails closed for %s before any fresh source lookup", async scenario => {
    const f = fixture(); if (scenario === "preview") vi.stubEnv("VERCEL_ENV", "preview"); else vi.stubEnv("RECORDINGS_SYNC_SECRET", "");
    await expect(beginTestProcessing(f.ctx, f.ctx.recordings)).rejects.toThrow("test_processing_provider_boundary"); expect(f.wire).not.toHaveBeenCalled();
  });
  it("leaves production cleanup unchanged without new provenance, TEST key or DB lookup", async () => {
    const f = fixture(); vi.stubEnv("MOTORIST_APP_ENV", "production"); vi.stubEnv("VERCEL_GIT_COMMIT_REF", "main"); vi.stubEnv("APP_BASE_URL", "https://dispecing.linkapomoci.sk"); vi.stubEnv("RECORDINGS_SYNC_SECRET", "");
    for (const name of ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"]) vi.stubEnv(name, "https://ifpaeegaesdmljfkdvcn.supabase.co");
    f.ctx.job.provider_ids = { scribe_transcript_id: "existing-production" };
    expect(await processScribeCleanupJob(f.cleanup())).toMatchObject({ state: "complete" }); expect(f.db.log).toEqual([]); expect(f.wire).toHaveBeenCalledOnce();
  });
});
