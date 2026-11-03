import { sessionOwnership } from "@/server/telephony/ownership";

/** Extra time allowed to verify one transient database read, once per operation. */
export const TRANSIENT_READ_RETRY_MS = 1_000;

type ReadResult = { error: { message: string; code?: string } | null };

function isTransientReadError(error: ReadResult["error"]): boolean {
  if (!error) return false;
  // SQLSTATE/PostgREST failures are actionable even if their text mentions a
  // timeout. A user's cancellation is not authority to start another request.
  if (error.code && !["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(error.code)) return false;
  return /^AbortError: un-owned read exceeded \d+ ms$/.test(error.message) ||
    /^(?:TypeError: )?(?:fetch failed|Failed to fetch|NetworkError when attempting to fetch resource\.?)$/.test(error.message);
}

/**
 * Use only around SELECT/HEAD queries or a verified read-only RPC. Share one
 * allowance across the operation so an outage cannot add a retry for every
 * query. Failed verification stays an error; no empty or stale fallback.
 * Never wrap writes, provider actions or an operation holding a session lease.
 * Attach the supplied signal on each fresh builder before .maybeSingle().
 */
export function createTransientReadRetry() {
  let retried = false;
  return async function read<T extends ReadResult>(query: (signal: AbortSignal) => PromiseLike<T>): Promise<T> {
    const initial = await query(new AbortController().signal);
    if (retried || sessionOwnership.getStore() || !isTransientReadError(initial.error)) return initial;
    retried = true;
    const controller = new AbortController();
    // AbortError also stops postgrest-js from retrying a GET internally.
    const timer = setTimeout(() => controller.abort(new DOMException("Read verification exceeded its deadline", "AbortError")), TRANSIENT_READ_RETRY_MS);
    try { return await query(controller.signal); }
    finally { clearTimeout(timer); }
  };
}
