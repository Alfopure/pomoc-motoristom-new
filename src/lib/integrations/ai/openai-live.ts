import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

import { readBoundedResponse } from "./openai-batch";

/**
 * The REST surface of an OpenAI GPT-Live session, and the verification of the
 * webhook that announces one.
 *
 * GPT-Live has exactly four server-side controls — accept, reject, hangup,
 * refer — and everything else is a WebSocket command. That is what makes a
 * demo possible on a request/response host at all: the audio never touches us,
 * and the only long-lived thing (the sideband) is optional.
 *
 * Two deliberate choices:
 *
 *  - `accept` retries once without its latency-tuning fields. `service_tier`
 *    and `reasoning.effort` are the difference between a conversation that
 *    feels alive and one that feels like a queue, but their availability is
 *    per-project. A 400 on the tuning must not be the reason a demo dies with
 *    the caller's phone already ringing.
 *  - A 4xx carrying `decision_already_made` is success, not failure. The first
 *    accept wins; a redelivered webhook reaching the second one means the
 *    session is already running.
 */

const BASE = "https://api.openai.com/v1";
const RESPONSE_LIMIT = 64_000;
/** Standard Webhooks default; an older timestamp is a replay. */
export const OPENAI_WEBHOOK_TOLERANCE_SECONDS = 300;

export class OpenAILiveError extends Error {
  constructor(readonly code: string, readonly status = 502, readonly uncertain = false) {
    super(code);
    this.name = "OpenAILiveError";
  }
}

export type OpenAILiveSessionId = string;

export type AcceptTuning = {
  /** Responses delegation: `none` keeps the backend out of the critical path. */
  reasoningEffort?: "none" | "minimal" | "low";
  /** Provider fast lane; not enabled on every project, hence the fallback. */
  serviceTier?: "auto" | "default" | "priority" | "ultrafast";
  maxOutputTokens?: number;
};

export type AcceptParams = {
  sessionId: OpenAILiveSessionId;
  model: string;
  voice: string;
  instructions: string;
  backendModel: string;
  backendInstructions: string;
  tuning?: AcceptTuning;
};

export type AcceptResult = { status: "accepted" | "already_decided"; tuningApplied: boolean };
export type HangupResult = { done: boolean; status: number | null };

type Options = { apiKey: string; signal?: AbortSignal; fetch?: typeof fetch };

function sessionPath(sessionId: string, action: string): string {
  if (!/^live_[A-Za-z0-9_-]{1,190}$/.test(sessionId)) throw new OpenAILiveError("openai_invalid_session_id", 400);
  return `/live/sessions/${encodeURIComponent(sessionId)}/${action}`;
}

/**
 * `audio.format` is deliberately absent: SIP negotiates the media format and
 * the API rejects the field on a SIP session. `tools` is absent because a
 * function tool would need a process listening for its result.
 */
function acceptBody(params: AcceptParams, withTuning: boolean): Record<string, unknown> {
  const tuning = params.tuning ?? {};
  return {
    session: {
      type: "live",
      model: params.model,
      instructions: params.instructions,
      audio: { output: { voice: params.voice } },
      delegation: {
        type: "responses",
        responses: {
          model: params.backendModel,
          instructions: params.backendInstructions,
          ...(withTuning && tuning.reasoningEffort ? { reasoning: { effort: tuning.reasoningEffort } } : {}),
          ...(withTuning && tuning.serviceTier ? { service_tier: tuning.serviceTier } : {}),
          ...(tuning.maxOutputTokens ? { max_output_tokens: tuning.maxOutputTokens } : {}),
        },
      },
    },
  };
}

export function openAILiveClient(options: Options) {
  const key = options.apiKey.trim();
  if (!key) throw new OpenAILiveError("openai_not_configured", 503);
  const doFetch = options.fetch ?? fetch;

  type Raw = { ok: boolean; status: number; body: string };

  const request = async (method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<Raw> => {
    if (options.signal?.aborted) throw new OpenAILiveError("openai_deadline", 504, method === "POST");
    let response: Response;
    try {
      response = await doFetch(BASE + path, {
        method,
        headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error",
        cache: "no-store",
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch {
      // A POST that never got an answer may still have been applied.
      throw new OpenAILiveError(options.signal?.aborted ? "openai_deadline" : "openai_transport_failed", 504, method === "POST");
    }
    let text = "";
    try {
      text = response.body ? await readBoundedResponse(response, RESPONSE_LIMIT) : "";
    } catch {
      text = "";
    }
    return { ok: response.ok, status: response.status, body: text };
  };

  /** The error body is inspected for one documented code and never logged: it can quote the prompt. */
  const hasCode = (body: string, code: string): boolean => {
    if (!body.includes(code)) return false;
    try {
      return JSON.stringify(JSON.parse(body)).includes(code);
    } catch {
      return false;
    }
  };

  return {
    /**
     * Claims the pending SIP session. The first accept or reject decision wins;
     * a later one answers `decision_already_made`, which we report as success
     * so a redelivered webhook is a no-op instead of a failure.
     */
    async accept(params: AcceptParams): Promise<AcceptResult> {
      const path = sessionPath(params.sessionId, "accept");
      const first = await request("POST", path, acceptBody(params, true));
      if (first.ok) return { status: "accepted", tuningApplied: true };
      if (hasCode(first.body, "decision_already_made")) return { status: "already_decided", tuningApplied: true };
      // Only a rejected *request* is worth retrying plainly; 401/403/429/5xx
      // say nothing about the tuning fields and a retry would just cost time.
      if (first.status === 400 || first.status === 422) {
        const retry = await request("POST", path, acceptBody(params, false));
        if (retry.ok) return { status: "accepted", tuningApplied: false };
        if (hasCode(retry.body, "decision_already_made")) return { status: "already_decided", tuningApplied: false };
        throw new OpenAILiveError(`openai_accept_${retry.status}`, retry.status, false);
      }
      throw new OpenAILiveError(`openai_accept_${first.status}`, first.status, first.status === 429 || first.status >= 500);
    },

    async reject(sessionId: string, statusCode = 603): Promise<void> {
      const result = await request("POST", sessionPath(sessionId, "reject"), { status_code: statusCode });
      if (!result.ok && !hasCode(result.body, "decision_already_made")) {
        throw new OpenAILiveError(`openai_reject_${result.status}`, result.status, result.status >= 500);
      }
    },

    /**
     * Releases the session. A session that has already gone away answers 4xx,
     * which is the outcome we wanted — so only auth failures and genuinely
     * uncertain results (429/5xx/timeout) are reported as unfinished.
     */
    async hangup(sessionId: string): Promise<HangupResult> {
      try {
        const result = await request("POST", sessionPath(sessionId, "hangup"));
        if (result.ok) return { done: true, status: result.status };
        if (result.status === 401 || result.status === 403) throw new OpenAILiveError("openai_auth", result.status, false);
        if (result.status === 429 || result.status >= 500) return { done: false, status: result.status };
        return { done: true, status: result.status };
      } catch (error) {
        if (error instanceof OpenAILiveError && error.code === "openai_auth") throw error;
        return { done: false, status: null };
      }
    },

    /** Read-only preflight: does this key see `gpt-live-1` at all? */
    async listModels(): Promise<string[]> {
      const result = await request("GET", "/models");
      if (!result.ok) throw new OpenAILiveError(`openai_models_${result.status}`, result.status, false);
      try {
        const parsed: unknown = JSON.parse(result.body);
        const data = (parsed as { data?: unknown }).data;
        if (!Array.isArray(data)) return [];
        return data.map((entry) => (entry as { id?: unknown }).id).filter((id): id is string => typeof id === "string");
      } catch {
        throw new OpenAILiveError("openai_invalid_json", 502, false);
      }
    },
  };
}

export type LiveIncoming = { sessionId: string; fromHeader: string | null; toHeader: string | null };

/**
 * Reads `live.transport.incoming`.
 *
 * `live.call.incoming` (deprecated) and the Realtime API's
 * `realtime.call.incoming` can fire for the same pending session; accepting
 * twice is what `decision_already_made` exists for, but we only subscribe to,
 * and only recognise, the current Live event.
 */
export function parseLiveIncoming(payload: unknown): LiveIncoming | null {
  if (!payload || typeof payload !== "object") return null;
  const event = payload as { type?: unknown; data?: unknown };
  if (event.type !== "live.transport.incoming") return null;
  const data = event.data as { session_id?: unknown; type?: unknown; sip_headers?: unknown } | undefined;
  if (!data || typeof data.session_id !== "string" || data.type !== "sip") return null;

  let fromHeader: string | null = null;
  let toHeader: string | null = null;
  if (Array.isArray(data.sip_headers)) {
    for (const entry of data.sip_headers) {
      const header = entry as { name?: unknown; value?: unknown };
      if (typeof header.name !== "string" || typeof header.value !== "string") continue;
      const name = header.name.toLowerCase();
      if (name === "from" && fromHeader === null) fromHeader = header.value.slice(0, 256);
      if (name === "to" && toHeader === null) toHeader = header.value.slice(0, 256);
    }
  }
  return { sessionId: data.session_id, fromHeader, toHeader };
}

export type WebhookVerification = { ok: true } | { ok: false; reason: string };

function secretBytes(secret: string): Buffer {
  const trimmed = secret.trim();
  return trimmed.startsWith("whsec_") ? Buffer.from(trimmed.slice("whsec_".length), "base64") : Buffer.from(trimmed, "utf8");
}

/**
 * Standard Webhooks verification: HMAC-SHA256 over
 * `${webhook-id}.${webhook-timestamp}.${rawBody}`, compared against every
 * `v1,<base64>` entry in `webhook-signature` so a key rotation does not drop
 * events. The timestamp window is what makes a captured delivery unusable
 * later; the ledger handles ordinary duplicates.
 */
export function verifyOpenAIWebhook(
  headers: Headers,
  rawBody: string,
  options: { secret: string; now?: Date; toleranceSeconds?: number },
): WebhookVerification {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signature = headers.get("webhook-signature");
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing_headers" };

  const sent = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(sent)) return { ok: false, reason: "invalid_timestamp" };
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const tolerance = options.toleranceSeconds ?? OPENAI_WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - sent) > tolerance) return { ok: false, reason: "timestamp_out_of_window" };

  let expected: Buffer;
  try {
    expected = createHmac("sha256", secretBytes(options.secret)).update(`${id}.${timestamp}.${rawBody}`, "utf8").digest();
  } catch {
    return { ok: false, reason: "secret_unusable" };
  }

  for (const part of signature.split(" ")) {
    const [version, value] = part.split(",");
    if (version !== "v1" || !value) continue;
    let candidate: Buffer;
    try {
      candidate = Buffer.from(value, "base64");
    } catch {
      continue;
    }
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return { ok: true };
  }
  return { ok: false, reason: "signature_mismatch" };
}
