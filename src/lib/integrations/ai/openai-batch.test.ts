import { afterEach, describe, expect, it, vi } from "vitest";
import { openAIBatchClient, readBoundedResponse } from "./openai-batch";

const job = "11111111-1111-4111-8111-111111111111";
const filename = `recording-${job}.jsonl`;
const jsonl = "{\"custom_id\":\"synthetic\"}\n";
const file = () => ({ id: "file-input", filename, created_at: 1_700_000_000, expires_at: 1_700_172_800, bytes: new TextEncoder().encode(jsonl).length });
const batch = () => ({ id: "batch_one", status: "validating", input_file_id: "file-input", output_file_id: null, error_file_id: null, metadata: { recording_job_id: job }, created_at: 1_700_000_000 });
function setup(response: unknown = batch(), status = 200) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response, { status }));
  const signal = new AbortController().signal;
  return { fetcher, signal, client: openAIBatchClient({ apiKey: "synthetic-test-key", signal, fetch: fetcher }) };
}
afterEach(() => vi.unstubAllEnvs());

describe("OpenAI Batch transport boundaries", () => {
  it("uses a fixed TLS origin, the caller deadline, no redirects/cache, and no retries", async () => {
    const { client, fetcher, signal } = setup();
    await client.create("file-input", job);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/batches");
    expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store", signal });
    expect(JSON.parse(init!.body as string)).toEqual({ input_file_id: "file-input", endpoint: "/v1/responses", completion_window: "24h", output_expires_after: { anchor: "created_at", seconds: 172800 }, metadata: { recording_job_id: job } });
  });
  it("uploads one bounded technical JSONL filename with explicit two-day expiry", async () => {
    const { client, fetcher } = setup(file()); await client.upload(filename, jsonl);
    const [url, init] = fetcher.mock.calls[0]; expect(url).toBe("https://api.openai.com/v1/files");
    const body = init!.body as FormData;
    expect(body.get("purpose")).toBe("batch"); expect(body.get("expires_after[anchor]")).toBe("created_at"); expect(body.get("expires_after[seconds]")).toBe("172800");
    const upload = body.get("file") as File; expect(upload.name).toBe(filename); expect(await upload.text()).toBe(jsonl);
    expect(init!.headers).not.toHaveProperty("Content-Type");
  });
  it("does not contact a provider with absent/blank credentials", () => {
    vi.stubEnv("OPENAI_API_KEY", " "); expect(() => openAIBatchClient({ signal: AbortSignal.timeout(1000) })).toThrow("openai_not_configured");
    expect(() => openAIBatchClient({ signal: AbortSignal.timeout(1000), apiKey: " " })).toThrow("openai_not_configured");
  });
  it("does not dispatch when its deadline was already aborted", async () => {
    const controller = new AbortController(); controller.abort(); const fetcher = vi.fn<typeof fetch>();
    const client = openAIBatchClient({ apiKey: "synthetic-test-key", signal: controller.signal, fetch: fetcher });
    await expect(client.create("file-input", job)).rejects.toMatchObject({ code: "openai_deadline" }); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 404, 408, 429, 500, 502, 503])("never retries HTTP%s, and request timeouts/server failures are uncertain", async (status) => {
    const { client, fetcher } = setup({ error: "sensitive upstream body must not escape" }, status);
    await expect(client.create("file-input", job)).rejects.toMatchObject({ code: `openai_http_${status}`, status, uncertain: status === 408 || status >= 500 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("keeps an upload408 unresolved while a read408 is not a paid submission", async () => {
    const upload = setup({}, 408);
    await expect(upload.client.upload(filename, jsonl)).rejects.toMatchObject({ code: "openai_http_408", uncertain: true });
    expect(upload.fetcher).toHaveBeenCalledOnce();
    const read = setup({}, 408);
    await expect(read.client.retrieve("batch_one")).rejects.toMatchObject({ code: "openai_http_408", uncertain: false });
    expect(read.fetcher).toHaveBeenCalledOnce();
  });
  it("marks unknown POST transport outcomes uncertain without leaking provider error text", async () => {
    const { client, fetcher } = setup(); fetcher.mockRejectedValueOnce(new Error("Bearer sensitive-provider-content"));
    await expect(client.create("file-input", job)).rejects.toMatchObject({ message: "openai_transport_failed", uncertain: true }); expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each(["{broken", "null", "[]", "{}", JSON.stringify({ ...batch(), id: undefined }), JSON.stringify({ ...batch(), id: "../wrong" }), JSON.stringify({ ...batch(), output_file_id: "https://other.invalid/data" })])("treats malformed successful POST replies as uncertain (%s)", async (raw) => {
    const { client, fetcher } = setup(); fetcher.mockResolvedValueOnce(new Response(raw));
    await expect(client.create("file-input", job)).rejects.toMatchObject({ uncertain: true }); expect(fetcher).toHaveBeenCalledOnce();
  });
  it("keeps successful POST response size/empty-body failures uncertain", async () => {
    for (const response of [new Response("x", { headers: { "content-length": "300000" } }), new Response(null, { status: 204 })]) {
      const { client, fetcher } = setup(); fetcher.mockResolvedValueOnce(response);
      await expect(client.create("file-input", job)).rejects.toMatchObject({ uncertain: true }); expect(fetcher).toHaveBeenCalledOnce();
    }
  });
  it("does not label failed reads as unknown paid submissions", async () => {
    const { client, fetcher } = setup(); fetcher.mockRejectedValueOnce(new Error("network"));
    await expect(client.retrieve("batch_one")).rejects.toMatchObject({ uncertain: false });
  });
  it("rejects path/query injection, invalid job IDs and oversized UTF-8 before any request", async () => {
    const { client, fetcher } = setup();
    await expect(client.retrieve("batch_one/../../files")).rejects.toMatchObject({ code: "openai_invalid_id" });
    await expect(client.content("file-input?other=1")).rejects.toMatchObject({ code: "openai_invalid_id" });
    await expect(client.listFiles("file-input&limit=999")).rejects.toMatchObject({ code: "openai_invalid_id" });
    await expect(client.create("file-input", "foreign")).rejects.toMatchObject({ code: "openai_invalid_job_id" });
    await expect(client.upload("customer-name.jsonl", jsonl)).rejects.toMatchObject({ code: "openai_invalid_input" });
    await expect(client.upload(filename, "ž".repeat(500001))).rejects.toMatchObject({ code: "openai_invalid_input" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("provider object identity and cleanup safety", () => {
  it.each([{ input_file_id: "file-foreign" }, { metadata: { recording_job_id: "different-job" } }])("does not acknowledge a created batch with another correlation (%j)", async (patch) => {
    const { client } = setup({ ...batch(), ...patch }); await expect(client.create("file-input", job)).rejects.toMatchObject({ uncertain: true });
  });
  it("rejects upload metadata which cannot establish requested content/expiry", async () => {
    for (const patch of [{ filename: "foreign.jsonl" }, { bytes: 0 }, { expires_at: undefined }, { expires_at: file().created_at + 172801 }]) {
      const { client } = setup({ ...file(), ...patch }); await expect(client.upload(filename, jsonl)).rejects.toMatchObject({ uncertain: true });
    }
  });
  it("binds retrieved file/batch and cancelled batch IDs to the exact requested object", async () => {
    const r = setup({ ...batch(), id: "batch_other" }); await expect(r.client.retrieve("batch_one")).rejects.toThrow();
    const c = setup({ ...batch(), id: "batch_other" }); await expect(c.client.cancel("batch_one")).rejects.toMatchObject({ uncertain: true });
    const f = setup({ ...file(), id: "file-other" }); await expect(f.client.file("file-input")).rejects.toThrow();
  });
  it.each([{ created_at: -1 }, { created_at: 1.25 }, { bytes: -1 }, { expires_at: "never" }, { expires_at: 1 }])("rejects malformed file timestamps/size (%j)", async (patch) => {
    const { client } = setup({ ...file(), ...patch }); await expect(client.file("file-input")).rejects.toThrow();
  });
  it.each([{ created_at: -1 }, { status: "future-state" }, { output_file_id: "" }, { output_file_id: undefined }, { error_file_id: 8 }, { metadata: { recording_job_id: 123 } }])("rejects ambiguous batch state/IDs/metadata (%j)", async (patch) => {
    const { client } = setup({ ...batch(), ...patch }); await expect(client.retrieve("batch_one")).rejects.toThrow();
  });
  it("does not let an apparently completed batch conceal all result files during cleanup", async () => {
    await expect(setup({ ...batch(), status: "completed" }).client.retrieve("batch_one")).rejects.toMatchObject({ code: "openai_completed_files_unknown" });
    const completed = { ...batch(), status: "completed", output_file_id: "file-output", error_file_id: "file-errors" };
    expect(await setup(completed).client.retrieve("batch_one")).toMatchObject({ output_file_id: "file-output", error_file_id: "file-errors" });
    expect(await setup({ ...completed, output_file_id: null }).client.retrieve("batch_one")).toMatchObject({ error_file_id: "file-errors" });
  });
  it("requires a confirmed exact-ID deletion and sends DELETE once", async () => {
    const { client, fetcher } = setup({ id: "file-input", deleted: true }); await client.deleteFile("file-input");
    expect(fetcher.mock.calls[0]).toEqual(["https://api.openai.com/v1/files/file-input", expect.objectContaining({ method: "DELETE" })]); expect(fetcher).toHaveBeenCalledOnce();
    for (const result of [{ id: "file-input", deleted: false }, { id: "file-other", deleted: true }, { id: "file-input" }, null]) await expect(setup(result).client.deleteFile("file-input")).rejects.toThrow();
  });
  it("leaves a missing file as explicit404 for cleanup's idempotence decision", async () => {
    await expect(setup({}, 404).client.deleteFile("file-input")).rejects.toMatchObject({ status: 404, uncertain: false });
  });
  it("uses validated bounded pagination and rejects duplicate/ambiguous pages", async () => {
    const { client, fetcher } = setup({ data: [batch()], has_more: true });
    expect(await client.listBatches("batch_previous")).toMatchObject({ hasMore: true }); expect(fetcher.mock.calls[0][0]).toBe("https://api.openai.com/v1/batches?limit=100&after=batch_previous");
    for (const data of [{ data: [batch(), batch()], has_more: false }, { data: [], has_more: true }, { data: [batch()], has_more: "false" }]) await expect(setup(data).client.listBatches()).rejects.toThrow();
    const f = setup({ data: [file()], has_more: false }); await f.client.listFiles("file-previous"); expect(f.fetcher.mock.calls[0][0]).toBe("https://api.openai.com/v1/files?purpose=batch&limit=100&order=desc&after=file-previous");
  });
});

describe("bounded provider bodies", () => {
  it("limits actual streamed bytes even without a content-length", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(3)); controller.enqueue(new Uint8Array(3)); }, cancel() { cancelled = true; } });
    await expect(readBoundedResponse(new Response(body), 5)).rejects.toMatchObject({ code: "openai_response_too_large" }); expect(cancelled).toBe(true);
  });
  it("decodes multibyte characters across chunks and rejects invalid UTF-8", async () => {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([0xc5])); c.enqueue(new Uint8Array([0xbe])); c.close(); } });
    expect(await readBoundedResponse(new Response(body), 2)).toBe("ž");
    await expect(readBoundedResponse(new Response(new Uint8Array([0xc5])), 2)).rejects.toThrow();
  });
  it("bounds downloadable model output independently from control JSON", async () => {
    const { client, fetcher } = setup(); fetcher.mockResolvedValueOnce(new Response("x".repeat(2_000_001)));
    await expect(client.content("file-output")).rejects.toMatchObject({ code: "openai_response_too_large", uncertain: false });
  });
});
