import { AI_DEMO_LIMITS } from "./config";

/**
 * The opening exchange: make Veronika speak first, and measure how long it took.
 *
 * GPT-Live has no accept-time greeting option. The documented way to make the
 * model speak before the caller does is a *fresh* `session.instructions.append`
 * on a sideband WebSocket, optionally followed by a short
 * `session.commentary.append` to start the turn. `response.create` explicitly
 * does not grant permission to speak.
 *
 * Latency is the whole point of this demo, so two things happen differently
 * from the obvious implementation:
 *
 *  1. **The two commands are pipelined.** WebSocket delivery is ordered, so the
 *     server sees the instructions before the trigger regardless of when we
 *     read the acknowledgement. Waiting for `session.instructions.appended`
 *     before sending the trigger would add a full round trip to the one moment
 *     when somebody is holding a phone to their ear hearing nothing.
 *  2. **The socket stays open for the opening turns.** Not to control the call
 *     — the audio is on SIP and needs nobody — but to timestamp when she
 *     actually started speaking, when the caller answered, and how long she
 *     took to come back. Those are the only honest latency numbers available
 *     without a process running for the whole call, which this deployment does
 *     not allow.
 *
 * The probe records offsets and a direction. Never transcript text, never
 * audio: `session.output_transcript.delta` carries what was said, and this
 * function throws it away on purpose.
 *
 * A failed probe never fails the call. The greeting may still be heard — an
 * acknowledgement was never proof that it was, and its absence is not proof
 * that it wasn't.
 */

export type LatencyProbeEntry = {
  /** Milliseconds after the bridge, i.e. after the caller picked up. */
  ms: number;
  /** `out` = Veronika started a stretch of speech, `in` = the caller did. */
  dir: "in" | "out";
};

export type GreetingStatus = "appended" | "heard_started" | "failed";

export type GreetingResult = {
  status: GreetingStatus;
  /** When the instructions were acknowledged, relative to the start of the probe. */
  appendedMs: number | null;
  /** When Veronika's first word left the model. The number the demo is judged on. */
  firstDeltaMs: number | null;
  probe: LatencyProbeEntry[];
  /** Turn-taking gaps: caller stops, Veronika starts. */
  responseGapsMs: number[];
  error: string | null;
};

/** The subset of the WebSocket API this module uses; `ws` and the Node global both satisfy it. */
export type MinimalWebSocket = {
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: unknown) => void): void;
  send(data: string): void;
  close(): void;
  readyState: number;
};

export type WebSocketFactory = (url: string, init: { headers: Record<string, string> }) => MinimalWebSocket;

/** The probe's own budgets; the tests shorten them without touching the logic. */
export type ProbeLimits = {
  probeOpenMs: number;
  probeAppendedMs: number;
  probeFirstDeltaMs: number;
  probeWindowMs: number;
  probeMaxEvents: number;
};

export type RunGreetingParams = {
  sessionId: string;
  apiKey: string;
  greetingText: string;
  commentaryText: string;
  eventIdSeed: string;
  webSocketFactory?: WebSocketFactory;
  now?: () => number;
  limits?: ProbeLimits;
};

/** The Node global takes an init object with headers (undici extension). */
function defaultFactory(url: string, init: { headers: Record<string, string> }): MinimalWebSocket {
  const impl = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof impl !== "function") throw new Error("websocket_unavailable");
  const Ctor = impl as new (target: string, init?: unknown) => MinimalWebSocket;
  return new Ctor(url, init);
}

export function webSocketAvailable(): boolean {
  return typeof (globalThis as { WebSocket?: unknown }).WebSocket === "function";
}

type ParsedEvent = { type: string; clientEventId: string | null };

function parseEvent(raw: unknown): ParsedEvent | null {
  const text = typeof raw === "string" ? raw : null;
  if (text === null || text.length > 2_000_000) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const event = parsed as { type?: unknown; client_event_id?: unknown };
  if (typeof event.type !== "string") return null;
  return { type: event.type, clientEventId: typeof event.client_event_id === "string" ? event.client_event_id : null };
}

export async function runGreeting(params: RunGreetingParams): Promise<GreetingResult> {
  const limits = params.limits ?? AI_DEMO_LIMITS;
  const now = params.now ?? (() => Date.now());
  const started = now();
  const since = () => now() - started;

  const instructionsEventId = `greet-${params.eventIdSeed}`;
  const commentaryEventId = `begin-${params.eventIdSeed}`;

  const probe: LatencyProbeEntry[] = [];
  const responseGapsMs: number[] = [];
  let appendedMs: number | null = null;
  let firstDeltaMs: number | null = null;
  let lastDirection: "in" | "out" | null = null;
  let lastInboundMs: number | null = null;
  let error: string | null = null;

  const record = (dir: "in" | "out") => {
    if (dir === lastDirection) return;
    if (probe.length < limits.probeMaxEvents) probe.push({ ms: since(), dir });
    if (dir === "out" && lastDirection === "in" && lastInboundMs !== null) responseGapsMs.push(since() - lastInboundMs);
    if (dir === "in") lastInboundMs = since();
    lastDirection = dir;
  };

  let socket: MinimalWebSocket | null = null;
  let settled = false;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let firstDeltaTimer: ReturnType<typeof setTimeout> | null = null;

  const result = await new Promise<GreetingResult>((resolve) => {
    const finish = (status: GreetingStatus) => {
      if (settled) return;
      settled = true;
      if (closeTimer) clearTimeout(closeTimer);
      if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
      try {
        socket?.close();
      } catch {
        // The probe is finished either way; a failing close is not a call failure.
      }
      resolve({ status, appendedMs, firstDeltaMs, probe, responseGapsMs, error });
    };

    const openTimer = setTimeout(() => {
      error = error ?? "sideband_open_timeout";
      finish("failed");
    }, limits.probeOpenMs);

    try {
      const factory = params.webSocketFactory ?? defaultFactory;
      socket = factory(`wss://api.openai.com/v1/live/sessions/${encodeURIComponent(params.sessionId)}/attach`, {
        headers: { Authorization: `Bearer ${params.apiKey}` },
      });
    } catch (caught) {
      clearTimeout(openTimer);
      error = caught instanceof Error ? caught.message : "sideband_unavailable";
      finish("failed");
      return;
    }

    const active = socket;

    active.addEventListener("open", () => {
      clearTimeout(openTimer);
      try {
        // Pipelined on purpose; see the module comment. `delegation_id` must be
        // null — a non-null id is refused with Responses delegation.
        active.send(JSON.stringify({ type: "session.instructions.append", event_id: instructionsEventId, delegation_id: null, content: params.greetingText }));
        active.send(JSON.stringify({ type: "session.commentary.append", event_id: commentaryEventId, content: params.commentaryText }));
      } catch (caught) {
        error = caught instanceof Error ? caught.message : "sideband_send_failed";
        finish("failed");
        return;
      }
      // Hard stop for the whole probe, and a shorter one for "did she start at all".
      closeTimer = setTimeout(() => finish(firstDeltaMs !== null ? "heard_started" : appendedMs !== null ? "appended" : "failed"), limits.probeWindowMs);
      firstDeltaTimer = setTimeout(() => {
        if (firstDeltaMs === null) finish(appendedMs !== null ? "appended" : "failed");
      }, limits.probeFirstDeltaMs);
    });

    active.addEventListener("message", (event) => {
      const parsed = parseEvent((event as { data?: unknown }).data);
      if (!parsed) return;
      switch (parsed.type) {
        case "session.instructions.appended":
          if (parsed.clientEventId === null || parsed.clientEventId === instructionsEventId) appendedMs = appendedMs ?? since();
          break;
        case "session.output_transcript.delta":
          if (firstDeltaMs === null) {
            firstDeltaMs = since();
            if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
          }
          record("out");
          break;
        case "session.input_transcript.delta":
          record("in");
          break;
        case "session.closed":
          finish(firstDeltaMs !== null ? "heard_started" : appendedMs !== null ? "appended" : "failed");
          break;
        case "error":
          // A rejected append still leaves the startup instructions in force,
          // so she may well speak; only the *measured* greeting is lost.
          if (parsed.clientEventId === instructionsEventId || parsed.clientEventId === commentaryEventId) error = error ?? "append_rejected";
          break;
        default:
          break;
      }
    });

    active.addEventListener("error", () => {
      error = error ?? "sideband_error";
      finish(firstDeltaMs !== null ? "heard_started" : appendedMs !== null ? "appended" : "failed");
    });

    active.addEventListener("close", () => {
      finish(firstDeltaMs !== null ? "heard_started" : appendedMs !== null ? "appended" : "failed");
    });
  });

  return result;
}
