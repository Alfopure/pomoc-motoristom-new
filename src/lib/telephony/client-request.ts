import { isMobileApp } from "./phone-platform";
import { beginBrowserCallStep } from "./call-timing";

/**
 * Bounded browser requests for telephony endpoints.
 *
 * Every telephony fetch must be bounded. An unbounded request does not merely
 * spin: it pins whatever UI state was entered before it, and much of the call
 * centre disables its controls while a request is in flight. A single response
 * that never arrives is therefore indistinguishable, to the operator, from the
 * application being broken.
 *
 * This module deliberately does NOT retry. Retrying a telephony mutation is a
 * correctness decision that belongs to the caller and its idempotency journal,
 * never to the transport: a timed-out mutation is a *lost response*, not proof
 * that nothing happened at the provider.
 */

/** Budgets by request kind. Control actions get more room than plain reads. */
export const TELEPHONY_TIMEOUT_MS = {
  /** Ordinary snapshot/list reads that a poller repeats anyway. */
  read: 8_000,
  /** Reads that may wait on a fresh provider snapshot capture. */
  snapshot: 10_000,
  /** Call control includes provider acknowledgement and durable state writes. */
  control: 30_000,
  /** Durable workplace/state mutations that run a server-side saga. */
  mutation: 20_000,
} as const;

export type TelephonyTimeoutKind = keyof typeof TELEPHONY_TIMEOUT_MS;

/**
 * Raised only when our budget elapsed. A caller-initiated abort keeps its own
 * AbortError. Either kind of abort may happen after a mutation was delivered;
 * neither is proof that the remote operation was cancelled.
 */
export class TelephonyRequestTimeoutError extends Error {
  readonly timedOut = true;
  readonly label: string;
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    const budget = timeoutMs >= 1_000 ? `${Math.round(timeoutMs / 1_000)} s` : `${timeoutMs} ms`;
    super(`Požiadavka „${label}" prekročila časový limit ${budget}.`);
    this.name = "TelephonyRequestTimeoutError";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

export function isTelephonyTimeout(error: unknown): error is TelephonyRequestTimeoutError {
  return error instanceof TelephonyRequestTimeoutError;
}

export function isAbortLikeError(error: unknown) {
  return isTelephonyTimeout(error) ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
}

export type TelephonyFetchInit = Omit<RequestInit, "signal"> & {
  timeoutMs: number;
  /** Short human-readable name used in the timeout message and in tests. */
  label: string;
  signal?: AbortSignal | null;
  operationId?: string;
  /** UI feedback only; an uncertain operation remains in flight until its real result. */
  onSlow?: () => void;
};

/**
 * `fetch` with a mandatory budget. The caller's signal and our timer are
 * composed into one controller so either can cancel the request, and the two
 * outcomes stay distinguishable afterwards.
 */
export async function telephonyFetch(
  input: string,
  init: TelephonyFetchInit,
  runtime: { fetch?: typeof fetch; setTimeout?: typeof setTimeout; clearTimeout?: typeof clearTimeout } = {},
): Promise<Response> {
  const { timeoutMs, label, signal: callerSignal, onSlow, operationId, ...rest } = init;
  const doFetch = runtime.fetch ?? globalThis.fetch;
  const schedule = runtime.setTimeout ?? globalThis.setTimeout;
  const cancel = runtime.clearTimeout ?? globalThis.clearTimeout;

  if (callerSignal?.aborted) throw abortError();

  const finishTiming = beginBrowserCallStep("request", { operationId });
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort();
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = schedule(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const slowTimer = onSlow && timeoutMs > 15_000 ? schedule(() => {
    try { onSlow(); } catch { /* UI reporting must not interrupt an in-flight mutation. */ }
  }, 15_000) : null;

  try {
    const response = await doFetch(input, {
      cache: "no-store",
      credentials: "same-origin",
      ...rest,
      headers: isMobileApp() && input.startsWith("/api/telephony/") ? { ...Object.fromEntries(new Headers(rest.headers)), "x-pm-phone-kind": "mobile" } : rest.headers,
      signal: controller.signal,
    });
    // Every caller consumes a finite API response. Keep the deadline alive
    // through the body: fetch() alone resolves as soon as headers arrive.
    const body = response.body ? await readBoundedBody(response.body, controller.signal) : null;
    if (controller.signal.aborted) throw abortError();
    finishTiming({ outcome: response.ok ? "ok" : "failed", requestId: response.headers.get("x-request-id") });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    finishTiming({ outcome: callerSignal?.aborted ? "cancelled" : "failed" });
    // Keep caller cancellation distinguishable if it races the timer.
    if (callerSignal?.aborted) throw abortError();
    if (timedOut) throw new TelephonyRequestTimeoutError(label, timeoutMs);
    throw error;
  } finally {
    cancel(timer);
    if (slowTimer !== null) cancel(slowTimer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

const MAX_API_RESPONSE_BYTES = 8 * 1024 * 1024;

async function readBoundedBody(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const reader = body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    if (signal.aborted) { cancel(); throw abortError(); }
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw abortError();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_API_RESPONSE_BYTES) {
        cancel();
        throw new Error("Odpoveď telefónnej služby je príliš veľká.");
      }
      chunks.push(value);
    }
    const result = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export type TelephonyJsonResult<T> = {
  ok: boolean;
  status: number;
  body: T | null;
};

/**
 * Bounded fetch plus tolerant JSON parsing. A non-2xx response is returned, not
 * thrown, so callers can read the server's Slovak `error` field; only transport
 * failures and timeouts throw.
 */
export async function telephonyJson<T>(
  input: string,
  init: TelephonyFetchInit,
  runtime?: Parameters<typeof telephonyFetch>[2],
): Promise<TelephonyJsonResult<T>> {
  const response = await telephonyFetch(input, init, runtime);
  const body = (await response.json().catch(() => null)) as T | null;
  return { ok: response.ok, status: response.status, body };
}

/**
 * Exponential backoff with jitter, used to stop a failing poller from hammering
 * an endpoint that is already struggling. Jitter prevents every open console
 * from retrying in the same instant after a shared outage.
 */
export function nextBackoffDelayMs(input: {
  baseMs: number;
  consecutiveFailures: number;
  maxMs: number;
  jitter?: number;
  random?: () => number;
}) {
  const { baseMs, consecutiveFailures, maxMs } = input;
  if (consecutiveFailures <= 0) return baseMs;
  const jitter = input.jitter ?? 0.2;
  const random = input.random ?? Math.random;
  const exponential = baseMs * 2 ** Math.min(consecutiveFailures, 10);
  const capped = Math.min(exponential, maxMs);
  const spread = capped * jitter;
  const jittered = capped - spread + random() * spread * 2;
  // Clamp after jitter, not before: upward jitter on an already-capped delay
  // would otherwise push the retry past the caller's stated maximum.
  return Math.round(Math.min(maxMs, Math.max(baseMs, jittered)));
}

function abortError() {
  const error = new Error("Požiadavka bola zrušená.");
  error.name = "AbortError";
  return error;
}
