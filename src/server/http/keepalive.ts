import "server-only";

import { channel } from "node:diagnostics_channel";
import type { Agent } from "undici";

/**
 * Call-speed S4: keep-alive sockets for the Telnyx API client.
 *
 * Node's fetch closes an idle socket after 4 s (undici's default; Telnyx's
 * Cloudflare edge sends no `Keep-Alive: timeout` hint), while one call's
 * webhooks arrive 0.3–10 s apart, so most of them opened a new TLS connection
 * (S4.0 on TEST: 65 of 79 requests with Telnyx calls). `http_keepalive_ms` > 0
 * gives the client one shared undici `Agent` that keeps idle sockets that
 * long. 0 returns no fetch at all: the client keeps the plain global fetch and
 * undici is never loaded, so the webhook's cold path is unchanged.
 *
 * The Agent is passed as `dispatcher` to the global fetch. Next's patched fetch
 * hands a string or URL input's `init` to Node's fetch unchanged
 * (`next/dist/server/lib/patch-fetch.js`, `dedupe-fetch.js`), and Node's fetch
 * accepts an Agent of the undici it bundles: `undici` is pinned to 7.30.1,
 * the version Vercel's Node 24 runtime reports (`process.versions.undici` in
 * the cron runtime log). The Agent publishes the same `undici:client:connected`
 * diagnostics, so `telnyxConnects` keeps counting its new sockets.
 *
 * A reused socket that the far end has already closed fails the request.
 * Nothing here retries it — undici never resends a written request and this
 * wrapper does not either — so a POST keeps today's ambiguous outcome: the
 * journal's `unknown` and the `observe_dial_v2` recovery. Such a failure is
 * recognisable with `isReusedSocketReset`, for the `reusedSocketReset` log field.
 */

export const KEEPALIVE_MAX_TIMEOUT_MS = 60_000;
export const KEEPALIVE_CONNECTIONS = 32;
export const KEEPALIVE_CONNECT_TIMEOUT_MS = 3_000;

const RESET_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);
const usedSockets = new WeakSet<object>();
const reusedRequests = new WeakSet<object>();
const reusedResets = new WeakSet<object>();
let observing = false;
let current: { keepAliveMs: number; agent: Promise<Agent | null> } | null = null;

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/** Marks requests written to a socket that already carried one, and their socket failures. */
function observeReusedSockets(): void {
  if (observing) return;
  observing = true;
  channel("undici:client:sendHeaders").subscribe((message) => {
    try {
      const { request, socket } = message as { request?: unknown; socket?: unknown };
      if (!isObject(request) || !isObject(socket)) return;
      if (usedSockets.has(socket)) reusedRequests.add(request);
      else usedSockets.add(socket);
    } catch { /* Diagnostics callbacks must never affect the transport. */ }
  });
  channel("undici:request:error").subscribe((message) => {
    try {
      const { request, error } = message as { request?: unknown; error?: unknown };
      if (isObject(request) && isObject(error) && reusedRequests.has(request) && RESET_CODES.has(String((error as { code?: unknown }).code))) {
        reusedResets.add(error);
      }
    } catch { /* Diagnostics callbacks must never affect the transport. */ }
  });
}

/**
 * One Agent per value. A changed value starts a new one; the old one is never
 * closed, because a request that built its client earlier may still dispatch
 * on it. Its idle sockets are unreferenced and close after their own timeout.
 */
function agentFor(keepAliveMs: number): Promise<Agent | null> {
  if (current?.keepAliveMs === keepAliveMs) return current.agent;
  observeReusedSockets();
  const agent = import("undici").then(({ Agent }) => new Agent({
    keepAliveTimeout: keepAliveMs,
    keepAliveMaxTimeout: KEEPALIVE_MAX_TIMEOUT_MS,
    connections: KEEPALIVE_CONNECTIONS,
    connect: { timeout: KEEPALIVE_CONNECT_TIMEOUT_MS },
  })).catch(() => {
    // Without the Agent, requests go out exactly as with the switch off.
    console.warn(JSON.stringify({ scope: "telephony", level: "warn", code: "http_keepalive_unavailable" }));
    return null;
  });
  current = { keepAliveMs, agent };
  return agent;
}

/**
 * The Telnyx client's fetch for `http_keepalive_ms` from the request's cached
 * latency flags, or `undefined` for 0: the client then uses the global fetch
 * exactly as before. Called when the client is built, so undici loads while
 * the request is still reading the database.
 */
export function keepAliveFetch(keepAliveMs: number): typeof fetch | undefined {
  if (!Number.isInteger(keepAliveMs) || keepAliveMs <= 0) {
    current = null;
    return undefined;
  }
  const agent = agentFor(keepAliveMs);
  return async (input, init) => {
    const dispatcher = await agent;
    return globalThis.fetch(input, dispatcher ? { ...init, dispatcher } as RequestInit : init);
  };
}

/** A fetch failure caused by a reset of a socket that had already carried a request. */
export function isReusedSocketReset(error: unknown): boolean {
  if (!isObject(error)) return false;
  const cause = (error as { cause?: unknown }).cause;
  return reusedResets.has(error) || (isObject(cause) && reusedResets.has(cause));
}
