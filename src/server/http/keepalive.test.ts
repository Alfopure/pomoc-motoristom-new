import { AsyncLocalStorage } from "node:async_hooks";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { Worker } from "node:worker_threads";

import type { SupabaseClient } from "@supabase/supabase-js";
import { Agent } from "undici";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";
import { registerTelnyxOrigin, withRequestMetrics } from "@/server/request-metrics";
import { sessionOwnership, type Ownership } from "@/server/telephony/ownership";
import { ProviderOutcomeUnknownError } from "@/server/telephony/provider-journal";
import { createTelnyxClient, TelnyxCommandError, type TelnyxRequestLog } from "@/server/telephony/telnyx/client";
import { getTelnyxConfig } from "@/server/telephony/telnyx/env";

import { isReusedSocketReset, keepAliveAgentOptions, keepAliveFetch, KEEPALIVE_MAX_TIMEOUT_MS } from "./keepalive";

/**
 * Against a real local HTTP server: the Agent really carries the requests,
 * and a kept-alive socket reset after the server received a request is never
 * answered by a second send.
 */
type Received = { method: string; path: string; socket: number; reused: boolean; body: string };
/**
 * What the server does with the next matching request: reset it (on a reused
 * socket, or on any), cut its 200 body off with a reset, or never answer it.
 */
type Mode = "reset-reused" | "reset-any" | "body-reset-reused" | "hang-reused";
let server: Server;
let origin: string;
let received: Received[] = [];
let mode: Mode | null = null;
const sockets = new Map<Socket, { id: number; requests: number }>();
const answer = (n: number) => JSON.stringify({ data: { call_control_id: `leg-${n}`, call_leg_id: "leg", call_session_id: "provider-session", is_alive: true } });

beforeAll(async () => {
  server = createServer((request, response) => {
    const socket = sockets.get(request.socket) ?? { id: sockets.size + 1, requests: 0 };
    sockets.set(request.socket, socket);
    socket.requests += 1;
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const reused = socket.requests > 1;
      received.push({ method: request.method!, path: request.url!, socket: socket.id, reused, body });
      const current = mode;
      if (current === "reset-any" || current && reused) mode = null;
      if (current === "reset-any" || current === "reset-reused" && reused) {
        // The request has reached the server: the far end may have acted on it.
        request.socket.resetAndDestroy();
      } else if (current === "body-reset-reused" && reused) {
        response.writeHead(200, { "content-type": "application/json", "content-length": "200" });
        response.write("{\"data\":");
        setTimeout(() => request.socket.resetAndDestroy(), 20);
      } else if (current !== "hang-reused" || !reused) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(answer(received.length));
      }
    });
  });
  // Node's default 5 s hint would cap undici's idle time; Telnyx sends no hint.
  server.keepAliveTimeout = 60_000;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

/**
 * Back-to-back requests alternate between two sockets with or without the
 * Agent: undici's pool frees a socket a microtask after the body is read.
 * Commands spaced like webhooks reuse one socket.
 */
const spaced = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  received = [];
  mode = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function journalHarness(base = `${origin}/v2`, timeoutMs?: number) {
  const journal = new Map<string, { fingerprint: string; outcome: string }>();
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "motorist_session_lease_renew_v2") return { data: true, error: null };
    const id = String(args.p_command_id);
    if (name === "motorist_provider_command_prepare_v2") {
      const prior = journal.get(id);
      if (prior) return { data: { ...prior, dispatch: false }, error: null };
      journal.set(id, { fingerprint: String(args.p_fingerprint), outcome: "unknown" });
      return { data: { dispatch: true }, error: null };
    }
    if (name === "motorist_provider_command_result_v2") {
      const status = Number(args.p_status);
      journal.get(id)!.outcome = status < 300 ? "accepted" : status === 429 ? "rate_limited" : status < 500 && status !== 408 ? "rejected" : "unknown";
      return { data: true, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  const admin = { rpc } as unknown as SupabaseClient<Database>;
  const owner = (): Ownership => ({ admin, sessionId: "session", organizationId: "org", token: "token", generation: 1, contract: 2, deadline: Date.now() + 24_000, acquiredAt: 0 });
  const logs: TelnyxRequestLog[] = [];
  const client = createTelnyxClient({
    config: getTelnyxConfig({ TELNYX_API_KEY: "test", TELNYX_CALL_CONTROL_APP_ID: "app", TELNYX_API_BASE_URL: base }),
    liveGate: { callsEnabled: true, smsEnabled: false }, fetch: keepAliveFetch(15_000), timeoutMs, onRequest: (entry) => { logs.push(entry); },
  });
  const dial = (commandId: string) => sessionOwnership.run(owner(), () => client.dial({ commandId, to: "+421900000001", from: "+421900000002" }));
  return { client, dial, journal, logs };
}

const sendsOf = (requests: Received[], commandId: string) =>
  requests.filter((request) => request.method === "POST" && JSON.parse(request.body).command_id === commandId);

describe("keep-alive fetch (call-speed S4)", () => {
  it("returns no fetch for 0, so the Telnyx client keeps the global fetch", () => {
    expect(keepAliveFetch(0)).toBeUndefined();
    expect(keepAliveFetch(-1)).toBeUndefined();
    expect(keepAliveFetch(Number.NaN)).toBeUndefined();
  });

  it("caps idle time at 60 s and keeps one Agent per value across off and on", async () => {
    expect(keepAliveAgentOptions(15_000)).toEqual({ keepAliveTimeout: 15_000, keepAliveMaxTimeout: 60_000, connections: 32, connect: { timeout: 3_000 } });
    // The flag accepts up to 600 000; the Agent never holds a socket idle past the cap.
    expect(keepAliveAgentOptions(600_000).keepAliveTimeout).toBe(KEEPALIVE_MAX_TIMEOUT_MS);

    const global = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}"));
    const dispatcherOf = async (keepAliveMs: number) => {
      await keepAliveFetch(keepAliveMs)!(`${origin}/v2/calls/leg`);
      return (global.mock.calls.at(-1)![1] as { dispatcher?: unknown }).dispatcher;
    };
    const first = await dispatcherOf(15_000);
    expect(keepAliveFetch(0)).toBeUndefined();
    const other = await dispatcherOf(20_000);
    expect(other).toBeInstanceOf(Agent);
    expect(other).not.toBe(first);
    expect(await dispatcherOf(15_000)).toBe(first);
    expect(await dispatcherOf(600_000)).toBe(await dispatcherOf(60_000));
  });

  it("sends through one shared undici Agent when on, and its new sockets still count as telnyxConnects", async () => {
    const global = vi.spyOn(globalThis, "fetch");
    const logger = vi.fn();
    await withRequestMetrics("call.action", async () => {
      registerTelnyxOrigin(`${origin}/v2`);
      for (const fetch of [keepAliveFetch(15_000)!, keepAliveFetch(15_000)!, keepAliveFetch(15_000)!]) {
        await (await fetch(`${origin}/v2/calls/leg`, { method: "GET" })).text();
        await spaced();
      }
      return Response.json({});
    }, { logger });

    const dispatchers = global.mock.calls.map(([, init]) => (init as { dispatcher?: unknown } | undefined)?.dispatcher);
    expect(dispatchers[0]).toBeInstanceOf(Agent);
    expect(new Set(dispatchers).size).toBe(1);
    expect((dispatchers[0] as Agent).stats[origin]).toMatchObject({ connected: 1 });
    expect(new Set(received.map((request) => request.socket)).size).toBe(1);
    expect(logger.mock.calls[0][0]).toMatchObject({ telnyxConnects: 1 });
  });

  it("passes the dispatcher through Next's patched fetch, inside and outside a request (POST and GET)", async () => {
    // Next reads AsyncLocalStorage from the global scope, as its server sets it up.
    (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;
    const { createPatchedFetcher } = await import("next/dist/server/lib/patch-fetch.js");
    const { workAsyncStorage } = await import("next/dist/server/app-render/work-async-storage.external.js");
    const { workUnitAsyncStorage } = await import("next/dist/server/app-render/work-unit-async-storage.external.js");
    const seen: Array<{ method: unknown; dispatcher: unknown }> = [];
    const originFetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ method: init?.method, dispatcher: (init as { dispatcher?: unknown } | undefined)?.dispatcher });
      return new Response("{}");
    };
    const patched = createPatchedFetcher(originFetch as typeof fetch, { workAsyncStorage, workUnitAsyncStorage });
    const dispatcher = { marker: "agent" };
    const send = async (method: "GET" | "POST") => (await patched("https://api.telnyx.eu/v2/calls", {
      method, headers: { accept: "application/json" }, body: method === "POST" ? "{}" : undefined,
      signal: new AbortController().signal, dispatcher } as RequestInit)).text();
    const workStore = { route: "/api/telephony/telnyx/webhook", isDraftMode: false, forceDynamic: false, forceStatic: false,
      isUnstableNoStore: false, isBuildTimePrerendering: false, nextFetchId: 1, shouldTrackFetchMetrics: false, isStaticGeneration: false };
    const workUnitStore = { type: "request", phase: "action", url: { pathname: "/api/telephony/telnyx/webhook", search: "" }, headers: new Headers() };
    await workAsyncStorage.run(workStore as never, () => workUnitAsyncStorage.run(workUnitStore as never, async () => {
      await send("POST");
      await send("GET");
    }));
    // Outside a request: the cron's and `after()`'s background work.
    await send("POST");
    await send("GET");
    expect(seen).toEqual(["POST", "GET", "POST", "GET"].map((method) => ({ method, dispatcher })));
  });

  it("never resends a POST whose kept-alive socket was reset, and the journal keeps it unknown", async () => {
    const h = journalHarness();
    await h.dial("dial-1");
    expect(h.journal.get("dial-1")?.outcome).toBe("accepted");
    await spaced();

    mode = "reset-reused";
    const failure = await h.dial("dial-2").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TelnyxCommandError);
    expect(failure).toMatchObject({ code: "network", commandId: "dial-2" });
    expect(sendsOf(received, "dial-2")).toEqual([expect.objectContaining({ path: "/v2/calls", reused: true })]);
    expect(h.journal.get("dial-2")?.outcome).toBe("unknown");
    expect(h.logs.at(-1)).toMatchObject({ method: "POST", commandId: "dial-2", retried: false, attempts: [{ status: null, reusedSocketReset: true }] });

    // The redelivered command asks for evidence instead of dialling again.
    await expect(h.dial("dial-2")).rejects.toBeInstanceOf(ProviderOutcomeUnknownError);
    expect(sendsOf(received, "dial-2")).toHaveLength(1);
  });

  it("lets a GET on a reset kept-alive socket fail as today: one send, a retryable network error", async () => {
    const h = journalHarness();
    await h.client.retrieveCall("leg");
    await spaced();
    mode = "reset-reused";
    await expect(h.client.retrieveCall("leg")).rejects.toMatchObject({ code: "network", retryable: true });
    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({ method: "GET", reused: true });
    expect(h.logs.at(-1)).toMatchObject({ method: "GET", attempts: [{ status: null, reusedSocketReset: true }] });
    expect(h.logs.at(-1)!.attempts).toHaveLength(1);
  });

  it("does not tag a 200 whose body a reset cut off", async () => {
    const h = journalHarness();
    await h.dial("body-1");
    await spaced();
    mode = "body-reset-reused";
    await expect(h.dial("body-2")).rejects.toMatchObject({ code: "network" });
    expect(sendsOf(received, "body-2")).toEqual([expect.objectContaining({ reused: true })]);
    const [attempt] = h.logs.at(-1)!.attempts!;
    expect(attempt.status).toBe(200);
    expect(attempt).not.toHaveProperty("reusedSocketReset");
    expect(attempt).not.toHaveProperty("reusedSocketTimeout");
  });

  it("tags a POST that timed out unanswered on a reused socket, without resending it", async () => {
    const h = journalHarness(`${origin}/v2`, 300);
    await h.dial("silent-1");
    await spaced();
    mode = "hang-reused";
    await expect(h.dial("silent-2")).rejects.toMatchObject({ code: "timeout" });
    expect(sendsOf(received, "silent-2")).toEqual([expect.objectContaining({ reused: true })]);
    expect(h.journal.get("silent-2")?.outcome).toBe("unknown");
    expect(h.logs.at(-1)).toMatchObject({ method: "POST", commandId: "silent-2", retried: false, attempts: [{ status: null, reusedSocketTimeout: true }] });
  });

  it("does not call a reset of a fresh socket a reused-socket reset", async () => {
    // A new value starts a new Agent, so the first request opens a new socket.
    const fetch = keepAliveFetch(25_000)!;
    mode = "reset-any";
    const failure = await fetch(`${origin}/v2/calls/leg`).catch((error: unknown) => error);
    expect(received).toEqual([expect.objectContaining({ reused: false })]);
    expect(failure).toBeInstanceOf(TypeError);
    expect(isReusedSocketReset(failure)).toBe(false);
  });

  it("sends a POST once, on a new socket, after the server closed the idle one", async () => {
    const h = journalHarness();
    await h.dial("idle-1");
    const before = sendsOf(received, "idle-1")[0].socket;
    server.closeIdleConnections();
    await new Promise((resolve) => setTimeout(resolve, 50));

    await h.dial("idle-2");
    expect(h.journal.get("idle-2")?.outcome).toBe("accepted");
    const sends = sendsOf(received, "idle-2");
    expect(sends).toEqual([expect.objectContaining({ reused: false })]);
    expect(sends[0].socket).not.toBe(before);
  });

  it("sends a POST once, on a new socket, when the FIN arrived while the instance was frozen", async () => {
    // The server runs on its own thread, so it can close the idle socket while this thread is blocked.
    const worker = new Worker(`
      const { createServer } = require("node:http");
      const { parentPort } = require("node:worker_threads");
      const sockets = new Map();
      const received = [];
      const server = createServer((request, response) => {
        const socket = sockets.get(request.socket) ?? { id: sockets.size + 1, requests: 0 };
        sockets.set(request.socket, socket);
        socket.requests += 1;
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          received.push({ method: request.method, path: request.url, socket: socket.id, reused: socket.requests > 1, body });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ data: { call_control_id: "leg-" + received.length, call_leg_id: "leg", call_session_id: "s", is_alive: true } }));
        });
      });
      server.keepAliveTimeout = 60000;
      server.listen(0, "127.0.0.1", () => parentPort.postMessage({ port: server.address().port }));
      parentPort.on("message", (message) => {
        if (message === "close-idle-soon") setTimeout(() => server.closeIdleConnections(), 20);
        if (message === "received") parentPort.postMessage({ received });
      });
    `, { eval: true });
    const next = <T>() => new Promise<T>((resolve) => worker.once("message", resolve));
    try {
      const { port } = await next<{ port: number }>();
      const h = journalHarness(`http://127.0.0.1:${port}/v2`);
      await h.dial("thaw-1");
      await spaced();

      worker.postMessage("close-idle-soon");
      // Frozen: the FIN arrives meanwhile, but no event-loop turn reads it before the next send.
      const until = Date.now() + 300;
      while (Date.now() < until) { /* blocked */ }
      await h.dial("thaw-2");

      expect(h.journal.get("thaw-2")?.outcome).toBe("accepted");
      worker.postMessage("received");
      const { received: remote } = await next<{ received: Received[] }>();
      const sends = sendsOf(remote, "thaw-2");
      expect(sends).toEqual([expect.objectContaining({ reused: false })]);
      expect(sends[0].socket).not.toBe(sendsOf(remote, "thaw-1")[0].socket);
      expect(h.logs.at(-1)!.attempts).toEqual([expect.objectContaining({ status: 200 })]);
    } finally {
      await worker.terminate();
    }
  });
});
