import "server-only";
import { MutationError } from "@/server/mutation-error";

/** Bound bytes before decoding JSON, including requests without Content-Length. */
export async function readMobileJsonBody(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new MutationError("Očakáva sa JSON formulár.", 400);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new MutationError("Chýba formulár.", 400);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 64_000) { await reader.cancel(); throw new MutationError("Formulár je príliš veľký.", 400); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new MutationError("Neplatný JSON formulár.", 400); }
}
