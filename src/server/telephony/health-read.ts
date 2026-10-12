/** Extra time allowed to verify one transient monitoring read, once per report. */
export const HEALTH_READ_RETRY_MS = 1_000;

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
 * Use only around SELECT/HEAD monitoring queries. One briefly delayed database
 * response should be checked before it becomes an email. The shared allowance
 * prevents a database outage from adding a retry for every check or session;
 * failed verification stays an error. Never wrap writes or provider actions.
 * Attach the supplied signal on each fresh builder before .maybeSingle().
 */
export function createHealthReadRetry() {
  let retried = false;
  return async function read<T extends ReadResult>(query: (signal: AbortSignal) => PromiseLike<T>): Promise<T> {
    const initial = await query(new AbortController().signal);
    if (retried || !isTransientReadError(initial.error)) return initial;
    retried = true;
    const controller = new AbortController();
    // AbortError also stops postgrest-js from retrying a GET internally.
    const timer = setTimeout(() => controller.abort(new DOMException("Monitoring read retry exceeded its deadline", "AbortError")), HEALTH_READ_RETRY_MS);
    try { return await query(controller.signal); }
    finally { clearTimeout(timer); }
  };
}
