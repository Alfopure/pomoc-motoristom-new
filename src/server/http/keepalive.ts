import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import type { Agent } from "undici";

/**
 * Call-speed S4: keep-alive sockets for the Telnyx API client.
 *
 * Node's fetch closes an idle socket after 4 s (undici's default; Telnyx's
 * Cloudflare edge sends no `Keep-Alive: timeout` hint), while one call's
 * webhooks arrive 0.3–10 s apart, so most of them opened a new TLS connection
 * (S4.0 on TEST: 65 of 79 requests with Telnyx calls). `http_keepalive_ms` > 0
 * gives the client a shared undici `Agent` that keeps idle sockets that long,
 * at most `KEEPALIVE_MAX_TIMEOUT_MS`. 0 returns no fetch at all: the client
 * keeps the plain global fetch and undici is never loaded, so the webhook's
 * cold path is unchanged.
 *
 * The Agent is passed as `dispatcher` to the global fetch. Next's patched fetch
 * hands a string or URL input's `init` to Node's fetch unchanged
 * (`next/dist/server/lib/patch-fetch.js`, `dedupe-fetch.js`; a test pins it),
 * and Node's fetch accepts an Agent of the undici it bundles: `undici` is
 * pinned to 7.30.1, the version Vercel's Node 24 runtime reports
 * (`process.versions.undici` in the cron runtime log). The Agent publishes the
 * same `undici:client:connected` diagnostics, so `telnyxConnects` keeps
 * counting its new sockets.
 *
 * Before it writes to an idle socket again, undici yields to the event loop so
 * a FIN or RST that is already pending (an instance thawed after a freeze)
 * retires the socket first; the request then goes out once, on a new socket.
 * A reused socket that fails anyway fails the request. Nothing here retries
 * it — undici never resends a written request and this wrapper does not
 * either — so a POST keeps today's ambiguous outcome: the journal's `unknown`
 * and the `observe_dial_v2` recovery. Such a failure is recognisable with
 * `isReusedSocketReset`, and a timeout on a reused socket with
 * `isReusedSocketTimeout`, for the `reusedSocketReset`/`reusedSocketTimeout`
 * log fields.
 */

export const KEEPALIVE_MAX_TIMEOUT_MS = 60_000;
export const KEEPALIVE_CONNECTIONS = 32;
export const KEEPALIVE_CONNECT_TIMEOUT_MS = 3_000;

const RESET_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"]);
const usedSockets = new WeakSet<object>();
const reusedRequests = new WeakSet<object>();
const reusedResets = new WeakSet<object>();
const reusedTimeouts = new WeakSet<object>();
/** The undici request a keep-alive fetch dispatched, if it was created in that fetch's context. */
const dispatches = new AsyncLocalStorage<{ request?: object }>();
let observing = false;
/** By effective idle time; a value switched off and on again finds its Agent. */
const agents = new Map<number, Promise<Agent | null>>();

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/**
 * Marks requests written to a socket that already carried one, and their
 * socket failures. Subscribed when the switch is first on; switching it off
 * leaves the subscriptions in a warm instance. That is harmless: they only
 * add objects to WeakSets and never touch a request.
 */
function observeReusedSockets(): void {
  if (observing) return;
  observing = true;
  channel("undici:request:create").subscribe((message) => {
    try {
      const { request } = message as { request?: unknown };
      const dispatch = dispatches.getStore();
      if (dispatch && !dispatch.request && isObject(request)) dispatch.request = request;
    } catch { /* Diagnostics callbacks must never affect the transport. */ }
  });
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

/** The Agent's options; idle time is capped at `KEEPALIVE_MAX_TIMEOUT_MS` whatever the flag allows. */
export function keepAliveAgentOptions(keepAliveMs: number) {
  return {
    keepAliveTimeout: Math.min(keepAliveMs, KEEPALIVE_MAX_TIMEOUT_MS),
    keepAliveMaxTimeout: KEEPALIVE_MAX_TIMEOUT_MS,
    connections: KEEPALIVE_CONNECTIONS,
    connect: { timeout: KEEPALIVE_CONNECT_TIMEOUT_MS },
  };
}

/**
 * One Agent per effective value, kept for the instance's life. An Agent is
 * never closed, because a request that built its client earlier may still
 * dispatch on it; its idle sockets are unreferenced and close after their own
 * timeout.
 */
function agentFor(keepAliveMs: number): Promise<Agent | null> {
  const options = keepAliveAgentOptions(keepAliveMs);
  const existing = agents.get(options.keepAliveTimeout);
  if (existing) return existing;
  observeReusedSockets();
  const agent = import("undici").then(({ Agent }) => new Agent(options)).catch(() => {
    // Without the Agent, requests go out exactly as with the switch off.
    console.warn(JSON.stringify({ scope: "telephony", level: "warn", code: "http_keepalive_unavailable" }));
    return null;
  });
  agents.set(options.keepAliveTimeout, agent);
  return agent;
}

/**
 * The Telnyx client's fetch for `http_keepalive_ms` from the request's cached
 * latency flags, or `undefined` for 0: the client then uses the global fetch
 * exactly as before. Called when the client is built, so undici loads while
 * the request is still reading the database.
 */
export function keepAliveFetch(keepAliveMs: number): typeof fetch | undefined {
  if (!Number.isInteger(keepAliveMs) || keepAliveMs <= 0) return undefined;
  const agent = agentFor(keepAliveMs);
  return async (input, init) => {
    const dispatcher = await agent;
    if (!dispatcher) return globalThis.fetch(input, init);
    const dispatch: { request?: object } = {};
    try {
      return await dispatches.run(dispatch, () => globalThis.fetch(input, { ...init, dispatcher } as RequestInit));
    } catch (error) {
      // Aborted (the client's timeout) before any response, on a reused socket: a possible silent drop.
      if (isObject(error) && (error as { name?: unknown }).name === "AbortError" && dispatch.request && reusedRequests.has(dispatch.request)) {
        reusedTimeouts.add(error);
      }
      throw error;
    }
  };
}

/** A fetch failure caused by a reset of a socket that had already carried a request. */
export function isReusedSocketReset(error: unknown): boolean {
  if (!isObject(error)) return false;
  const cause = (error as { cause?: unknown }).cause;
  return reusedResets.has(error) || (isObject(cause) && reusedResets.has(cause));
}

/** A keep-alive fetch aborted before any response while it was written to a reused socket. */
export function isReusedSocketTimeout(error: unknown): boolean {
  return isObject(error) && reusedTimeouts.has(error);
}
