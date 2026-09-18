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
 * By default the probe records offsets and a direction and throws the words
 * away. `keepTranscript` turns that off — it is the one switch in this system
 * that causes what was said on a call to be stored, so it is off unless
 * somebody asked for it, and it is never implied by wanting the timings.
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
  /** How long that stretch of speech lasted. */
  durMs: number;
  /** An outbound stretch too short to be an answer — "hm", "rozumiem". */
  backchannel?: true;
};

/**
 * An outbound stretch shorter than this is an acknowledgement, not a reply.
 *
 * The prompt now asks for these on purpose, which is what makes the call sound
 * alive — and which is exactly why they must not be counted as response times.
 * A 184 ms "answer" is somebody saying "hm" while the caller is still finishing.
 *
 * It belongs to the limits rather than being a constant so a test can compress
 * a conversation into a few hundred milliseconds without every utterance
 * looking like a grunt.
 */
export const BACKCHANNEL_MAX_MS = 700;

export type GreetingStatus = "appended" | "heard_started" | "failed";

/** One delta as it arrived: who spoke, when, and what was said. */
export type TranscriptEntry = {
  /** Milliseconds after the bridge. */
  ms: number;
  dir: "in" | "out";
  text: string;
};

/** What the opening of the call looked like, as numbers. */
export type ConversationStats = {
  /** Stretches of speech, per side. */
  turns: { in: number; out: number };
  /** Total milliseconds each side was speaking. */
  speakingMs: { in: number; out: number };
  /** Both talking at once — an interruption or a talk-over. */
  overlaps: number;
  /** The longest stretch in which neither side said anything. */
  longestSilenceMs: number;
  /** Acknowledgements of hers, counted rather than mistaken for answers. */
  backchannels: number;
};

export type GreetingResult = {
  status: GreetingStatus;
  /** When the instructions were acknowledged, relative to the start of the probe. */
  appendedMs: number | null;
  /** When Veronika's first word left the model. The number the demo is judged on. */
  firstDeltaMs: number | null;
  probe: LatencyProbeEntry[];
  /** Turn-taking gaps: caller stops, Veronika starts. */
  responseGapsMs: number[];
  /**
   * The words, with the time each delta arrived — present only when the caller
   * asked for it. Everything else in this result is timings alone.
   */
  transcript: TranscriptEntry[] | null;
  stats: ConversationStats;
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
  backchannelMaxMs?: number;
  /** How often the caller is offered a snapshot to save. */
  probeCheckpointMs?: number;
  /**
   * Silence thresholds.
   *
   * They live here so a test can compress a whole call into a second without
   * the logic knowing the difference; in production they come from
   * `AI_DEMO_LIMITS`.
   */
  farewellSilenceMs?: number;
  nudgeAfterMs?: number;
  judgeAfterMs?: number;
  judgeEveryMs?: number;
  maxNudges?: number;
  closingGraceMs?: number;
  /**
   * Keep the words, not just the timings.
   *
   * Off by default: this is the only place in the system where what was said
   * on a call could be stored, and that must be a decision somebody made, not
   * a side effect of measuring latency.
   */
  keepTranscript?: boolean;
  transcriptMaxEntries?: number;
};

/**
 * What the probe can do besides listen.
 *
 * The sideband is open for the whole call, so it can also put a word in: the
 * same instructions/commentary pair that makes her greet is what makes her
 * check in when a line has gone quiet.
 */
export type ProbeControls = {
  /** Milliseconds since anybody last said anything. */
  silenceMs: number;
  /** Nudge her to say something now. */
  say: (instruction: string) => void;
  /** How many times `say` has already been used on this call. */
  saidCount: number;
};

/** A snapshot mid-probe, and whether there is any point carrying on. */
export type ProbeProgress = (snapshot: GreetingResult, controls: ProbeControls) => Promise<boolean> | boolean;

export type RunGreetingParams = {
  sessionId: string;
  apiKey: string;
  greetingText: string;
  commentaryText: string;
  eventIdSeed: string;
  webSocketFactory?: WebSocketFactory;
  now?: () => number;
  limits?: ProbeLimits;
  /**
   * Called every `probeCheckpointMs` with what has been heard so far.
   *
   * Writing only at the end meant that a probe killed by its host — a budget
   * running out, a deployment cycling — lost the entire call. It also lets the
   * caller stop the probe: returning `false` ends it, which is how a finished
   * call stops us waiting out the rest of the window.
   */
  onProgress?: ProbeProgress;
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

type ParsedEvent = { type: string; clientEventId: string | null; delta: string | null };

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
  const event = parsed as { type?: unknown; client_event_id?: unknown; delta?: unknown };
  if (typeof event.type !== "string") return null;
  return {
    type: event.type,
    clientEventId: typeof event.client_event_id === "string" ? event.client_event_id : null,
    delta: typeof event.delta === "string" ? event.delta : null,
  };
}

export async function runGreeting(params: RunGreetingParams): Promise<GreetingResult> {
  const limits: ProbeLimits = params.limits ?? AI_DEMO_LIMITS;
  const now = params.now ?? (() => Date.now());
  const started = now();
  const since = () => now() - started;

  const instructionsEventId = `greet-${params.eventIdSeed}`;
  const commentaryEventId = `begin-${params.eventIdSeed}`;

  const probe: LatencyProbeEntry[] = [];
  const transcript: TranscriptEntry[] = [];
  const keepTranscript = limits.keepTranscript === true;
  const transcriptMax = limits.transcriptMaxEntries ?? 400;
  let appendedMs: number | null = null;
  let firstDeltaMs: number | null = null;
  let error: string | null = null;

  /**
   * Speech is recorded as stretches, not as single events.
   *
   * The first version timestamped only the changes of speaker and measured a
   * "gap" from when the caller *started* talking — which is their utterance
   * plus the gap, not the gap. Every delta now extends the current stretch, so
   * a stretch knows when it ended, and a response time can be measured from
   * there.
   */
  type Stretch = { dir: "in" | "out"; startMs: number; endMs: number };
  const stretches: Stretch[] = [];

  const record = (dir: "in" | "out", delta: string | null = null) => {
    const at = since();
    if (keepTranscript && delta !== null && delta.length > 0 && transcript.length < transcriptMax) {
      transcript.push({ ms: at, dir, text: delta.slice(0, 400) });
    }
    const current = stretches[stretches.length - 1];
    if (current && current.dir === dir) {
      current.endMs = at;
      return;
    }
    if (stretches.length >= limits.probeMaxEvents) return;
    stretches.push({ dir, startMs: at, endMs: at });
  };

  let socket: MinimalWebSocket | null = null;
  let settled = false;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let firstDeltaTimer: ReturnType<typeof setTimeout> | null = null;
  let checkpointTimer: ReturnType<typeof setInterval> | null = null;
  let saidCount = 0;

  const result = await new Promise<GreetingResult>((resolve) => {
    const finish = (status: GreetingStatus) => {
      if (settled) return;
      settled = true;
      if (closeTimer) clearTimeout(closeTimer);
      if (firstDeltaTimer) clearTimeout(firstDeltaTimer);
      if (checkpointTimer) clearInterval(checkpointTimer);
      try {
        socket?.close();
      } catch {
        // The probe is finished either way; a failing close is not a call failure.
      }
      resolve(snapshot(status));
    };

    /**
     * Turns the stretches into what the timeline shows.
     *
     * A response time is the silence between the caller finishing and Veronika
     * beginning a real answer; acknowledgements are marked and excluded.
     */
    const summarise = (): number[] => {
      const gaps: number[] = [];
      probe.length = 0;
      for (let index = 0; index < stretches.length; index += 1) {
        const stretch = stretches[index];
        const durMs = stretch.endMs - stretch.startMs;
        const isBackchannel = stretch.dir === "out" && durMs < (limits.backchannelMaxMs ?? BACKCHANNEL_MAX_MS);
        probe.push({ ms: stretch.startMs, dir: stretch.dir, durMs, ...(isBackchannel ? { backchannel: true as const } : {}) });
        const previous = stretches[index - 1];
        if (stretch.dir === "out" && !isBackchannel && previous?.dir === "in") gaps.push(stretch.startMs - previous.endMs);
      }
      return gaps;
    };

    /**
     * The shape of the opening exchange, as five numbers.
     *
     * Overlaps and the longest silence are the two that say most about how the
     * call felt: one is her talking over somebody, the other is dead air.
     */
    const describeConversation = (): ConversationStats => {
      const stats: ConversationStats = {
        turns: { in: 0, out: 0 },
        speakingMs: { in: 0, out: 0 },
        overlaps: 0,
        longestSilenceMs: 0,
        backchannels: probe.filter((entry) => entry.backchannel === true).length,
      };
      let previousEnd: number | null = null;
      for (const stretch of stretches) {
        stats.turns[stretch.dir] += 1;
        stats.speakingMs[stretch.dir] += stretch.endMs - stretch.startMs;
        if (previousEnd !== null) {
          if (stretch.startMs < previousEnd) stats.overlaps += 1;
          else stats.longestSilenceMs = Math.max(stats.longestSilenceMs, stretch.startMs - previousEnd);
        }
        previousEnd = stretch.endMs;
      }
      return stats;
    };

    /** The result as it stands right now; safe to call repeatedly. */
    const snapshot = (status: GreetingStatus): GreetingResult => {
      const gaps = summarise();
      return {
        status,
        appendedMs,
        firstDeltaMs,
        probe: [...probe],
        responseGapsMs: gaps,
        transcript: keepTranscript ? [...transcript] : null,
        stats: describeConversation(),
        error,
      };
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

      // Save as we go, and stop as soon as the caller says the call is over.
      if (params.onProgress) {
        const every = limits.probeCheckpointMs ?? 10_000;
        const say = (instruction: string) => {
          if (settled) return;
          try {
            // The same pair that makes her greet: fresh instructions, then a
            // nudge to act on them. `delegation_id` must be null.
            saidCount += 1;
            active.send(JSON.stringify({ type: "session.instructions.append", event_id: `nudge-${params.eventIdSeed}-${saidCount}`, delegation_id: null, content: instruction }));
            active.send(JSON.stringify({ type: "session.commentary.append", event_id: `nudge-go-${params.eventIdSeed}-${saidCount}`, content: "Ozvi sa teraz podľa pokynu." }));
          } catch {
            // A nudge that cannot be sent is not worth failing a call over.
          }
        };

        checkpointTimer = setInterval(() => {
          if (settled) return;
          const status = firstDeltaMs !== null ? "heard_started" : appendedMs !== null ? "appended" : "failed";
          const lastSpeech = stretches[stretches.length - 1]?.endMs ?? 0;
          void Promise.resolve(params.onProgress?.(snapshot(status), { silenceMs: since() - lastSpeech, say, saidCount }))
            .then((carryOn) => {
              if (carryOn === false) finish(status);
            })
            .catch(() => undefined);
        }, every);
      }
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
          record("out", parsed.delta);
          break;
        case "session.input_transcript.delta":
          record("in", parsed.delta);
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
