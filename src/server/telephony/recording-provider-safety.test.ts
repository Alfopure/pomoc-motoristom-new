import { afterEach, describe, expect, it, vi } from "vitest";
import { assertRecordingProviderAccess } from "./recording-provider-safety";
import { deleteRecordingJob } from "./recording-processing";
import { processRecordingImport, refreshRecordingSource } from "./recording-storage";
import type { RecordingJobContext } from "./recording-jobs";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function fixture(data: object = {}) {
  const env = {
    MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
    VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk", APP_BASE_URL: "https://test.dispecing.linkapomoci.sk",
    SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co", NEXT_PUBLIC_SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co",
    MOTORIST_TEST_LIVE_INTEGRATIONS: "true", MOTORIST_TEST_ALLOWED_NUMBERS: "+421900111222", MOTORIST_TEST_FROM_NUMBERS: "+421900333444",
    TELNYX_API_KEY: "synthetic", TELNYX_CALL_CONTROL_APP_ID: "test-app", TELNYX_CREDENTIAL_CONNECTION_ID: "test-sip",
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const from = vi.fn();
  const fetch = vi.fn(async () => Response.json({ data })); vi.stubGlobal("fetch", fetch);
  const ctx = { admin: { from }, organizationId: "test-org", recording: { organization_id: "test-org", provider_recording_id: "recording", provider_session_id: "provider-session" },
    job: { lease_token: "lease", checkpoint: {} }, signal: AbortSignal.timeout(5000) } as unknown as RecordingJobContext;
  return { ctx, from, fetch };
}
describe("recording provider TEST ownership", () => {
  const owned = { id: "recording", connection_id: "test-app", call_session_id: "provider-session", status: "completed", download_urls: { wav: "https://recordings.telnyx.com/audio" } };
  it("rejects copied recording rows before audio import, storage work or provider DELETE", async () => {
    const { ctx, fetch, from } = fixture({ ...owned, connection_id: "production-app" });
    const download = vi.fn();
    for (const operation of [refreshRecordingSource, (context: RecordingJobContext) => processRecordingImport(context, { downloadChunk: download }), deleteRecordingJob]) {
      await expect(operation(ctx)).rejects.toThrow("test_recording_provider_boundary");
    }
    expect(download).not.toHaveBeenCalled(); expect(from).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [url, options] of fetch.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(url).toBe("https://api.telnyx.com/v2/recordings/recording"); expect(options.method).toBeUndefined();
    }
  });
  it.each([{ ...owned, id: "other" }, { ...owned, call_session_id: "other" }, { ...owned, connection_id: undefined }])("rejects missing or mismatching provider metadata", async data => {
    await expect(assertRecordingProviderAccess(fixture(data).ctx, "delete")).rejects.toThrow("test_recording_provider_boundary");
  });
  it("accepts provider proof after ledger retention without a DB lookup and uses its verified download URL", async () => {
    const { ctx, fetch, from } = fixture(owned);
    await expect(refreshRecordingSource(ctx)).resolves.toBe("https://recordings.telnyx.com/audio");
    expect(fetch).toHaveBeenCalledTimes(1); expect(from).not.toHaveBeenCalled();
  });
  it("allows kill-off cleanup of proven TEST recordings, but blocks imports and Preview cleanup", async () => {
    const { ctx, fetch } = fixture(owned);
    vi.stubEnv("MOTORIST_TEST_LIVE_INTEGRATIONS", "false");
    await expect(assertRecordingProviderAccess(ctx, "delete")).resolves.toMatchObject(owned);
    await expect(assertRecordingProviderAccess(ctx, "import")).rejects.toThrow("test_recording_provider_boundary");
    vi.stubEnv("VERCEL_ENV", "preview");
    await expect(assertRecordingProviderAccess(ctx, "delete")).rejects.toThrow("test_recording_provider_boundary");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("treats provider 404 as already removed only for cleanup", async () => {
    const { ctx, fetch } = fixture(); fetch.mockImplementation(async () => new Response(null, { status: 404 }));
    await expect(assertRecordingProviderAccess(ctx, "delete")).resolves.toBeNull();
    await expect(assertRecordingProviderAccess(ctx, "import")).rejects.toThrow("test_recording_provider_boundary");
  });
  it("adds no lookup to the unchanged production path", async () => {
    const { ctx, from, fetch } = fixture();
    vi.stubEnv("MOTORIST_APP_ENV", "production"); vi.stubEnv("VERCEL_GIT_COMMIT_REF", "main");
    vi.stubEnv("APP_BASE_URL", "https://dispecing.linkapomoci.sk");
    for (const key of ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"]) vi.stubEnv(key, "https://ifpaeegaesdmljfkdvcn.supabase.co");
    await expect(assertRecordingProviderAccess(ctx, "delete")).resolves.toBeUndefined();
    expect(from).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});
