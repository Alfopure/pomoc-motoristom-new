import { createHmac } from "node:crypto";

import type { MinimalWebSocket, WebSocketFactory } from "@/server/telephony/ai-demo/greeting";

/**
 * Offline stand-ins for the two OpenAI surfaces the AI demo touches: the REST
 * endpoints and the sideband WebSocket.
 *
 * `openaiSignedRequest` signs exactly the way the route verifies, so a test
 * that tampers with one byte of the body or moves the clock outside the window
 * fails for the real reason rather than because the fixture was built
 * differently from the verifier.
 */

export type FakeLiveOptions = {
  /** `accept` answers this status; 400 exercises the tuning fallback. */
  acceptStatus?: number;
  acceptBody?: string;
  /** The second `accept` attempt, after the tuning fields are dropped. */
  acceptRetryStatus?: number;
  hangupStatus?: number;
  models?: string[];
};

export type FakeLiveCall = { method: string; url: string; body: unknown };

export function createFakeOpenAIFetch(options: FakeLiveOptions = {}): { fetch: typeof fetch; calls: FakeLiveCall[] } {
  const calls: FakeLiveCall[] = [];
  let accepts = 0;

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    let body: unknown = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, url, body });

    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

    if (url.endsWith("/models")) return json(200, { data: (options.models ?? ["gpt-live-1", "gpt-5.6-terra"]).map((id) => ({ id })) });

    if (url.includes("/accept")) {
      accepts += 1;
      const status = accepts === 1 ? (options.acceptStatus ?? 200) : (options.acceptRetryStatus ?? 200);
      if (status === 200) return new Response("", { status: 200 });
      return new Response(options.acceptBody ?? JSON.stringify({ error: { code: "invalid_request_error" } }), { status });
    }

    if (url.includes("/hangup")) {
      const status = options.hangupStatus ?? 200;
      return status === 200 ? new Response("", { status: 200 }) : json(status, { error: { code: "session_not_found" } });
    }

    if (url.includes("/reject")) return new Response("", { status: 200 });
    return json(404, { error: { code: "not_found" } });
  }) as typeof fetch;

  return { fetch: fakeFetch, calls };
}

export type SignedRequestOptions = {
  secret: string;
  payload: unknown;
  id?: string;
  timestamp?: number;
  /** Corrupt the signature on purpose. */
  tamper?: boolean;
  url?: string;
};

export function openaiSignedRequest(options: SignedRequestOptions): Request {
  const raw = JSON.stringify(options.payload);
  const id = options.id ?? "evt_test_1";
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const key = options.secret.startsWith("whsec_") ? Buffer.from(options.secret.slice(6), "base64") : Buffer.from(options.secret, "utf8");
  const digest = createHmac("sha256", key).update(`${id}.${timestamp}.${raw}`, "utf8").digest("base64");
  return new Request(options.url ?? "https://example.test/api/telephony/webhooks/openai", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${options.tamper ? "AAAA" : digest}`,
    },
    body: raw,
  });
}

export type FakeSidebandScript = {
  /** Events the server "sends" once a client command arrives, in order. */
  onInstructions?: Array<{ delayMs?: number; event: Record<string, unknown> }>;
  /** Fail the connection instead of opening it. */
  failOpen?: boolean;
  openDelayMs?: number;
};

export type FakeSideband = { factory: WebSocketFactory; sent: string[]; url: string | null; headers: Record<string, string> | null };

/**
 * A sideband socket driven by a script.
 *
 * Deliberately records *order*: the greeting sends its two commands without
 * waiting in between, and `sent` is what proves that pipelining still happens
 * after somebody refactors the function.
 */
export function createFakeSideband(script: FakeSidebandScript = {}): FakeSideband {
  const state: FakeSideband = { factory: () => { throw new Error("unset"); }, sent: [], url: null, headers: null };

  state.factory = (url, init) => {
    state.url = url;
    state.headers = init.headers;
    const listeners = new Map<string, Array<(event: unknown) => void>>();
    const emit = (type: string, event: unknown) => {
      for (const listener of listeners.get(type) ?? []) listener(event);
    };

    const socket: MinimalWebSocket = {
      readyState: 0,
      addEventListener(type, listener) {
        const list = listeners.get(type) ?? [];
        list.push(listener);
        listeners.set(type, list);
      },
      send(data: string) {
        state.sent.push(data);
        if (state.sent.length !== 1) return;
        for (const step of script.onInstructions ?? []) {
          setTimeout(() => emit("message", { data: JSON.stringify(step.event) }), step.delayMs ?? 0);
        }
      },
      close() {
        socket.readyState = 3;
      },
    };

    setTimeout(() => {
      if (script.failOpen) emit("error", {});
      else {
        socket.readyState = 1;
        emit("open", {});
      }
    }, script.openDelayMs ?? 0);

    return socket;
  };

  return state;
}
