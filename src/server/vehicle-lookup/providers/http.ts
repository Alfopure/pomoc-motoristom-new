/** Fixed provider URLs only. Bound time AND decoded response size. */
export async function providerText(url: string, options: { timeoutMs?: number; headers?: Record<string, string> } = {}) {
  const response = await fetch(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 9_000), headers: options.headers });
  if (!response.ok) throw new ProviderHttpError(response.status);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty_body");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 500_000) throw new Error("response_too_large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString("utf8");
}
export class ProviderHttpError extends Error {
  constructor(public status: number) { super("provider_http_error"); }
}
