import "server-only";

export type OpenAIBatch = {
  id: string;
  status: "validating" | "failed" | "in_progress" | "finalizing" | "completed" | "expired" | "cancelling" | "cancelled";
  input_file_id: string;
  output_file_id: string | null;
  error_file_id: string | null;
  metadata: Record<string, string>;
  created_at: number;
};
export type OpenAIFile = { id: string; filename: string; created_at: number; expires_at?: number; bytes: number };
export class OpenAIBatchError extends Error {
  constructor(readonly code: string, readonly status = 502, readonly uncertain = false) { super(code); this.name = "OpenAIBatchError"; }
}
type Options = { signal: AbortSignal; fetch?: typeof fetch; apiKey?: string };
const BASE = "https://api.openai.com/v1";
const identifier = (value: string, prefix: string) => {
  if (!new RegExp(`^${prefix}[A-Za-z0-9_-]{1,150}$`).test(value)) throw new OpenAIBatchError("openai_invalid_id", 400);
  return encodeURIComponent(value);
};
export async function readBoundedResponse(response: Response, limit: number): Promise<string> {
  if (!response.body) throw new OpenAIBatchError("openai_empty_response");
  const length = response.headers.get("content-length");
  if (length && Number(length) > limit) { await response.body.cancel(); throw new OpenAIBatchError("openai_response_too_large"); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new OpenAIBatchError("openai_response_too_large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
export function openAIBatchClient(options: Options) {
  const key = (options.apiKey ?? process.env.OPENAI_API_KEY ?? "").trim();
  if (!key) throw new OpenAIBatchError("openai_not_configured", 503);
  const request = async (path: string, method = "GET", body?: FormData | Record<string, unknown>, text = false): Promise<unknown> => {
    const mutation = method === "POST";
    if (options.signal.aborted) throw new OpenAIBatchError("openai_deadline", 502);
    try {
      const multipart = body instanceof FormData;
      const response = await (options.fetch ?? fetch)(BASE + path, {
        method, headers: { Authorization: `Bearer ${key}`, ...(body && !multipart ? { "Content-Type": "application/json" } : {}) },
        body: body ? multipart ? body : JSON.stringify(body) : undefined,
        redirect: "error", signal: options.signal, cache: "no-store",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new OpenAIBatchError(`openai_http_${response.status}`, response.status, mutation && (response.status === 408 || response.status >= 500));
      }
      const raw = await readBoundedResponse(response, text ? 2_000_000 : 256_000);
      if (text) return raw;
      try { return JSON.parse(raw); } catch { throw new OpenAIBatchError("openai_invalid_json", 502, mutation); }
    } catch (error) {
      if (error instanceof OpenAIBatchError) {
        if (mutation && error.status >= 500 && !error.uncertain) throw new OpenAIBatchError(error.code, error.status, true);
        throw error;
      }
      throw new OpenAIBatchError(options.signal.aborted ? "openai_deadline" : "openai_transport_failed", 502, mutation);
    }
  };
  // A successful HTTP status does not establish which paid mutation happened.
  // Object/identity validation failures therefore require reconciliation too.
  const mutationResult = async <T>(pending: Promise<unknown>, parse: (value: unknown) => T): Promise<T> => {
    const value = await pending;
    try { return parse(value); }
    catch (error) { throw new OpenAIBatchError(error instanceof OpenAIBatchError ? error.code : "openai_invalid_response", 502, true); }
  };
  const asObject = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new OpenAIBatchError("openai_invalid_object");
    return value as Record<string, unknown>;
  };
  const file = (value: unknown): OpenAIFile => {
    const row = asObject(value);
    if (typeof row.id !== "string" || typeof row.filename !== "string" || typeof row.created_at !== "number" || !Number.isSafeInteger(row.created_at) || row.created_at <= 0 || typeof row.bytes !== "number" || !Number.isSafeInteger(row.bytes) || row.bytes < 0) throw new OpenAIBatchError("openai_invalid_file");
    if (row.expires_at !== undefined && (typeof row.expires_at !== "number" || !Number.isSafeInteger(row.expires_at) || row.expires_at <= row.created_at)) throw new OpenAIBatchError("openai_invalid_file_expiry");
    identifier(row.id, "file-");
    return { id: row.id, filename: row.filename, created_at: row.created_at, bytes: row.bytes, ...(typeof row.expires_at === "number" ? { expires_at: row.expires_at } : {}) };
  };
  const batch = (value: unknown): OpenAIBatch => {
    const row = asObject(value);
    if (typeof row.id !== "string" || typeof row.input_file_id !== "string" || typeof row.created_at !== "number" || !Number.isSafeInteger(row.created_at) || row.created_at <= 0 || !["validating", "failed", "in_progress", "finalizing", "completed", "expired", "cancelling", "cancelled"].includes(String(row.status))) throw new OpenAIBatchError("openai_invalid_batch");
    identifier(row.id, "batch_"); identifier(row.input_file_id, "file-");
    const optionalFileId = (value: unknown) => {
      if (value === null) return null;
      if (typeof value !== "string") throw new OpenAIBatchError("openai_invalid_batch_file_id");
      identifier(value, "file-"); return value;
    };
    const metadata = asObject(row.metadata ?? {});
    if (Object.values(metadata).some((value) => typeof value !== "string")) throw new OpenAIBatchError("openai_invalid_batch_metadata");
    const outputId = optionalFileId(row.output_file_id), errorId = optionalFileId(row.error_file_id);
    if (row.status === "completed" && !outputId && !errorId) throw new OpenAIBatchError("openai_completed_files_unknown");
    return { id: row.id, status: row.status as OpenAIBatch["status"], input_file_id: row.input_file_id,
      output_file_id: outputId, error_file_id: errorId,
      created_at: row.created_at, metadata: metadata as Record<string, string>,
    };
  };
  const bound = <T extends { id: string }>(row: T, id: string): T => {
    if (row.id !== id) throw new OpenAIBatchError("openai_object_binding_failed");
    return row;
  };
  const page = <T extends { id: string }>(value: unknown, parse: (row: unknown) => T) => {
    const raw = asObject(value);
    if (!Array.isArray(raw.data) || raw.data.length > 100 || typeof raw.has_more !== "boolean" || (raw.has_more && !raw.data.length)) throw new OpenAIBatchError("openai_invalid_list");
    const data = raw.data.map(parse);
    if (new Set(data.map((row) => row.id)).size !== data.length) throw new OpenAIBatchError("openai_invalid_list");
    return { data, hasMore: raw.has_more };
  };
  return {
    async upload(filename: string, jsonl: string): Promise<OpenAIFile> {
      if (!/^recording-[a-f0-9-]{36}\.jsonl$/.test(filename) || new TextEncoder().encode(jsonl).length > 1_000_000) throw new OpenAIBatchError("openai_invalid_input", 400);
      const body = new FormData(); body.set("purpose", "batch");
      body.set("expires_after[anchor]", "created_at"); body.set("expires_after[seconds]", "172800");
      body.set("file", new Blob([jsonl], { type: "application/jsonl" }), filename);
      return mutationResult(request("/files", "POST", body), (value) => {
        const result = file(value);
        if (result.filename !== filename || result.bytes !== new TextEncoder().encode(jsonl).length || result.expires_at === undefined || result.expires_at > result.created_at + 172800) throw new OpenAIBatchError("openai_upload_binding_failed");
        return result;
      });
    },
    async create(inputFileId: string, jobId: string): Promise<OpenAIBatch> {
      identifier(inputFileId, "file-");
      if (!/^[a-f0-9-]{36}$/.test(jobId)) throw new OpenAIBatchError("openai_invalid_job_id", 400);
      return mutationResult(request("/batches", "POST", { input_file_id: inputFileId, endpoint: "/v1/responses", completion_window: "24h",
        output_expires_after: { anchor: "created_at", seconds: 172800 }, metadata: { recording_job_id: jobId } }), (value) => {
          const result = batch(value);
          if (result.input_file_id !== inputFileId || result.metadata.recording_job_id !== jobId) throw new OpenAIBatchError("openai_batch_binding_failed");
          return result;
        });
    },
    async retrieve(batchId: string) { return bound(batch(await request(`/batches/${identifier(batchId, "batch_")}`)), batchId); },
    async cancel(batchId: string) { return mutationResult(request(`/batches/${identifier(batchId, "batch_")}/cancel`, "POST"), (value) => bound(batch(value), batchId)); },
    async file(fileId: string) { return bound(file(await request(`/files/${identifier(fileId, "file-")}`)), fileId); },
    async content(fileId: string) { return await request(`/files/${identifier(fileId, "file-")}/content`, "GET", undefined, true) as string; },
    async deleteFile(fileId: string) {
      const result = asObject(await request(`/files/${identifier(fileId, "file-")}`, "DELETE"));
      if (result.deleted !== true || result.id !== fileId) throw new OpenAIBatchError("openai_delete_unconfirmed");
    },
    async listBatches(after?: string) {
      return page(await request(`/batches?limit=100${after ? `&after=${identifier(after, "batch_")}` : ""}`), batch);
    },
    async listFiles(after?: string) {
      return page(await request(`/files?purpose=batch&limit=100&order=desc${after ? `&after=${identifier(after, "file-")}` : ""}`), file);
    },
  };
}
