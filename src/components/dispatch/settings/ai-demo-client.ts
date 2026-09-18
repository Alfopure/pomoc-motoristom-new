import { TELEPHONY_TIMEOUT_MS, telephonyJson } from "@/lib/telephony/client-request";

/**
 * Browser side of `/api/telephony/ai-demo/*`.
 *
 * Every response is a projection the server already redacted: a masked number,
 * a state, timestamps and latency numbers. The prompt, the key, the SIP target
 * and the full phone number never reach this file.
 */

export type AiDemoTimestamps = {
  requestedAt: string;
  sipDialedAt: string | null;
  aiOfferedAt: string | null;
  aiAcceptedAt: string | null;
  sipAnsweredAt: string | null;
  mobileDialedAt: string | null;
  mobileAnsweredAt: string | null;
  bridgedAt: string | null;
  greetingAppendedAt: string | null;
  firstTranscriptAt: string | null;
  endedAt: string | null;
};

export type AiDemoLatency = {
  greeting_appended_ms?: number | null;
  first_word_ms?: number | null;
  response_gaps_ms?: number[];
  probe_error?: string;
};

export type AiDemoAttemptView = {
  id: string;
  state: string;
  scenario: string;
  greetingStatus: string;
  endReason: string | null;
  errorCode: string | null;
  targetMasked: string | null;
  fromNumber: string;
  voice: string | null;
  latency: AiDemoLatency | null;
  timestamps: AiDemoTimestamps;
};

export type AiDemoPreflight = {
  enabled: boolean;
  configured: boolean;
  missing: string[];
  fromNumber: string | null;
  fromLineActive: boolean;
  recipientCount: number;
  node: string;
  webSocketGlobal: boolean;
  deployedEnvironment: string;
  telnyx: {
    configured: boolean;
    liveCallsEnv: boolean;
    liveCallsDb: boolean;
    destinationAllowlist: string[];
    callControlAppId: string | null;
  };
  db: { migrationApplied: boolean; activeAttempt: AiDemoAttemptView | null; attemptsToday: number };
  limits: { maxAttemptsPerDay: number; ringTimeoutSeconds: number; maxCallSeconds: number } | null;
  model: { live: string; backend: string; voice: string; sipHost: string } | null;
  voices: { all: string[]; natural: string[] };
  probeBudgetMs: number;
  remote: {
    models: { liveAvailable: boolean; error: string | null };
    did: { phoneNumber: string | null; connectionId: string | null; onThisApp: boolean | null; status: string | null; error: string | null };
  } | null;
};

type ErrorBody = { error?: string; code?: string; missing?: string[] };

export class AiDemoRequestError extends Error {
  constructor(message: string, readonly code: string, readonly status: number, readonly missing?: string[]) {
    super(message);
    this.name = "AiDemoRequestError";
  }
}

async function request<T>(url: string, options: { method?: "POST" | "PATCH"; body?: unknown; signal?: AbortSignal; label: string; timeoutMs: number }): Promise<T> {
  const result = await telephonyJson<T & ErrorBody>(url, {
    ...(options.method ? { method: options.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(options.body ?? {}) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    label: options.label,
    timeoutMs: options.timeoutMs,
  });
  if (!result.ok || !result.body) {
    throw new AiDemoRequestError(
      result.body?.error ?? "Požiadavku sa nepodarilo dokončiť.",
      result.body?.code ?? "ai_demo_failed",
      result.status,
      result.body?.missing,
    );
  }
  return result.body;
}

export function loadPreflight(options: { remote?: boolean; signal?: AbortSignal } = {}) {
  return request<AiDemoPreflight>(`/api/telephony/ai-demo/preflight${options.remote ? "?remote=1" : ""}`, {
    ...(options.signal ? { signal: options.signal } : {}),
    label: "kontrola pripravenosti AI dema",
    // The remote variant makes three provider GETs and deserves the longer budget.
    timeoutMs: options.remote ? TELEPHONY_TIMEOUT_MS.snapshot : TELEPHONY_TIMEOUT_MS.read,
  });
}

export function loadAttempt(id: string, signal?: AbortSignal) {
  return request<{ attempt: AiDemoAttemptView }>(`/api/telephony/ai-demo/${encodeURIComponent(id)}`, {
    ...(signal ? { signal } : {}),
    label: "stav AI dema",
    timeoutMs: TELEPHONY_TIMEOUT_MS.read,
  });
}

export function loadHistory(limit: number, signal?: AbortSignal) {
  return request<{ attempts: AiDemoAttemptView[] }>(`/api/telephony/ai-demo?limit=${limit}`, {
    ...(signal ? { signal } : {}),
    label: "história AI dema",
    timeoutMs: TELEPHONY_TIMEOUT_MS.read,
  });
}

export type StartAiDemoBody = { requestId: string; to: string; scenario: string; context?: string; voice?: string };

export function startDemo(body: StartAiDemoBody) {
  return request<{ attempt: AiDemoAttemptView; reused: boolean }>("/api/telephony/ai-demo/start", {
    method: "POST",
    body,
    label: "spustenie AI dema",
    // Places a real call: the provider acknowledgement is part of the budget.
    timeoutMs: TELEPHONY_TIMEOUT_MS.control,
  });
}

export function stopDemo(id: string) {
  return request<{ attempt: AiDemoAttemptView }>(`/api/telephony/ai-demo/${encodeURIComponent(id)}/stop`, {
    method: "POST",
    label: "ukončenie AI dema",
    timeoutMs: TELEPHONY_TIMEOUT_MS.control,
  });
}
