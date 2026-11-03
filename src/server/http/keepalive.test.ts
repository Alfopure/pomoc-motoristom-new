import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";

import type { SupabaseClient } from "@supabase/supabase-js";
import { Agent } from "undici";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";
import { registerTelnyxOrigin, withRequestMetrics } from "@/server/request-metrics";
import { sessionOwnership, type Ownership } from "@/server/telephony/ownership";
import { ProviderOutcomeUnknownError } from "@/server/telephony/provider-journal";
import { createTelnyxClient, TelnyxCommandError, type TelnyxRequestLog } from "@/server/telephony/telnyx/client";
import { getTelnyxConfig } from "@/server/telephony/telnyx/env";

import { isReusedSocketReset, keepAliveFetch } from "./keepalive";

/**
 * Against a real local HTTP server: the Agent really carries the requests,
 * and a kept-alive socket reset after the server received a request is never
 * answered by a second send.
 */
type Received = { method: string; path: string; socket: number; reused: boolean; body: string };
let server: Server;
let origin: string;
let received: Received[] = [];
/** Reset the next request that arrives on a socket that already carried one ("reused"), or on any socket. */
let reset: "reused" | "any" | null = null;
const sockets = new Map<Socket, { id: number; requests: number }>();

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
      if (reset === "any" || reset === "reused" && reused) {
        reset = null;
        // The request has reached the server: the far end may have acted on it.
        request.socket.resetAndDestroy();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: { call_control_id: `leg-${received.length}`, call_leg_id: "leg", call_session_id: "provider-session", is_alive: true } }));
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
  reset = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function journalHarness() {
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
    config: getTelnyxConfig({ TELNYX_API_KEY: "test", TELNYX_CALL_CONTROL_APP_ID: "app", TELNYX_API_BASE_URL: `${origin}/v2` }),
    liveGate: { callsEnabled: true, smsEnabled: false }, fetch: keepAliveFetch(15_000), onRequest: (entry) => { logs.push(entry); },
  });
  const dial = (commandId: string) => sessionOwnership.run(owner(), () => client.dial({ commandId, to: "+421900000001", from: "+421900000002" }));
  return { client, dial, journal, logs };
}

describe("keep-alive fetch (call-speed S4)", () => {
  it("returns no fetch for 0, so the Telnyx client keeps the global fetch", () => {
    expect(keepAliveFetch(0)).toBeUndefined();
    expect(keepAliveFetch(-1)).toBeUndefined();
    expect(keepAliveFetch(Number.NaN)).toBeUndefined();
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

    await (await keepAliveFetch(20_000)!(`${origin}/v2/calls/leg`)).text();
    expect((global.mock.calls.at(-1)![1] as { dispatcher?: unknown }).dispatcher).not.toBe(dispatchers[0]);
  });

  it("never resends a POST whose kept-alive socket was reset, and the journal keeps it unknown", async () => {
    const h = journalHarness();
    await h.dial("dial-1");
    expect(h.journal.get("dial-1")?.outcome).toBe("accepted");
    await spaced();

    reset = "reused";
    const failure = await h.dial("dial-2").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TelnyxCommandError);
    expect(failure).toMatchObject({ code: "network", commandId: "dial-2" });
    const sends = () => received.filter((request) => request.method === "POST" && JSON.parse(request.body).command_id === "dial-2");
    expect(sends()).toEqual([expect.objectContaining({ path: "/v2/calls", reused: true })]);
    expect(h.journal.get("dial-2")?.outcome).toBe("unknown");
    expect(h.logs.at(-1)).toMatchObject({ method: "POST", commandId: "dial-2", retried: false, attempts: [{ status: null, reusedSocketReset: true }] });

    // The redelivered command asks for evidence instead of dialling again.
    await expect(h.dial("dial-2")).rejects.toBeInstanceOf(ProviderOutcomeUnknownError);
    expect(sends()).toHaveLength(1);
  });

  it("lets a GET on a reset kept-alive socket fail as today: one send, a retryable network error", async () => {
    const h = journalHarness();
    await h.client.retrieveCall("leg");
    await spaced();
    reset = "reused";
    await expect(h.client.retrieveCall("leg")).rejects.toMatchObject({ code: "network", retryable: true });
    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({ method: "GET", reused: true });
    expect(h.logs.at(-1)).toMatchObject({ method: "GET", attempts: [{ status: null, reusedSocketReset: true }] });
    expect(h.logs.at(-1)!.attempts).toHaveLength(1);
  });

  it("does not call a reset of a fresh socket a reused-socket reset", async () => {
    // A new value starts a new Agent, so the first request opens a new socket.
    const fetch = keepAliveFetch(25_000)!;
    reset = "any";
    const failure = await fetch(`${origin}/v2/calls/leg`).catch((error: unknown) => error);
    expect(received).toEqual([expect.objectContaining({ reused: false })]);
    expect(failure).toBeInstanceOf(TypeError);
    expect(isReusedSocketReset(failure)).toBe(false);
  });
});
