import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { requireSupabasePublicEnv } from "@/lib/supabase/env";
import { requireMobileActor } from "./auth";

async function boundResponse(response: Response, maxBytes: number): Promise<Response> {
  const reader = response.body?.getReader();
  async function oversized() {
    // Cancellation is cleanup; its failure cannot undo the size rejection.
    try {
      await reader?.cancel();
    } catch {
      // The response is still rejected.
    }
    // PostgREST discards codes from thrown fetch errors. Its HTTP error parser
    // preserves this code, and POST overflow must remain an uncertain result.
    return Response.json({
      code: "MOBILE_RESPONSE_TOO_LARGE",
      message: "Odpoveď je príliš rozsiahla. Výsledok zápisu nie je potvrdený.",
      details: null,
      hint: null,
    }, { status: 503 });
  }
  if (Number(response.headers.get("content-length")) > maxBytes) return oversized();
  if (!reader) return response;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) return oversized();
    chunks.push(value);
  }
  const headers = new Headers(response.headers);
  // fetch has already decoded content encoding; the copied bytes are decoded.
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(new Uint8Array(Buffer.concat(chunks, size)), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** RPCs using auth.uid() receive the verified user token, never a service client. */
export async function requireMobileUser(request: Request, options?: { maxResponseBytes: number }) {
  const actor = await requireMobileActor(request);
  if (options && (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 1)) {
    throw new RangeError("Invalid mobile response limit");
  }
  const { url, publicKey } = requireSupabasePublicEnv();
  const authorization = "Bearer " + request.headers.get("authorization")!.slice(7);
  const client = createClient<Database>(url, publicKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      headers: { Authorization: authorization },
      fetch: async (input, init) => {
        const response = await fetch(input, {
          ...init,
          signal: AbortSignal.any([request.signal, ...(init?.signal ? [init.signal] : []), AbortSignal.timeout(8_000)]),
        });
        return options ? boundResponse(response, options.maxResponseBytes) : response;
      },
    },
  });
  return { actor, client };
}
