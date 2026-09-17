import { normalizeE164 } from "@/lib/telephony/normalize-e164";

import { aiDemoEnabled } from "./flag";

/**
 * Configuration and the numeric budgets of the AI demo.
 *
 * Reading never throws: a missing value yields `{ configured: false, missing }`
 * so the settings tab can say *what* is missing instead of a 500. Every limit
 * lives here as a constant because the demo's whole promise is "it ends on its
 * own": a value hidden in a call site is a value nobody can audit.
 *
 * The timings are chosen for perceived latency, which is the point of the demo.
 * The budget that matters is `bridged → first spoken word`; everything on that
 * path (webhook delivery, one WebSocket open, one append) is pipelined and the
 * per-step budgets are the shortest that still survive a provider hiccup.
 */

export type EnvRecord = Record<string, string | undefined>;

/** "Neutrálna linka 2" (`docs/operations/telnyx-setup.md:15`); the demo's caller ID. */
export const AI_DEMO_NEUTRAL_LINE = "+421232408774";
/** Allianz Assistance (`:10`) is only permitted on an explicit instruction. */
export const AI_DEMO_ALLOWED_FROM: readonly string[] = [AI_DEMO_NEUTRAL_LINE, "+421232408718"];
/**
 * The first neutral line cannot originate: Telnyx stores a malformed E.164
 * record for it (`docs/operations/telnyx-runbook.md`, spike S3). Both spellings
 * are refused so a copied value cannot resurrect the bug.
 */
export const AI_DEMO_FORBIDDEN_FROM: readonly string[] = ["+421232408700", "+4210232408700"];

export const AI_DEMO_LIMITS = {
  /** How long the OpenAI SIP leg may ring before Telnyx gives up. */
  sipRingSeconds: 30,
  /** The SIP leg outlives the mobile leg so its hard limit is the backstop. */
  sipTimeLimitExtraSeconds: 50,
  /** Accept is on the critical path: the phone is not ringing yet, but the caller is waiting. */
  acceptTimeoutMs: 8_000,
  acceptRetryAfterMs: 5_000,
  mobileDialOperationMs: 8_000,
  cleanupOperationMs: 4_000,
  openaiHangupTimeoutMs: 3_000,
  /** Webhook cleanup stays short; `stop` and the cron can afford to be thorough. */
  cleanupBudgetWebhookMs: 6_000,
  cleanupBudgetActionMs: 20_000,
  /** Sideband probe: open, prime, then listen to the opening exchange and close. */
  probeOpenMs: 3_000,
  probeAppendedMs: 4_000,
  probeFirstDeltaMs: 8_000,
  probeWindowMs: 18_000,
  probeMaxEvents: 40,
  /** Cron staleness rules; the tick is five minutes, so these are floors not ceilings. */
  requestedStaleMs: 60_000,
  sipDialingStaleMs: 120_000,
  acceptLostMs: 30_000,
  sipAnswerLostMs: 60_000,
  mobileDialLostMs: 60_000,
  mobileAnswerLostMs: 120_000,
  greetingLostMs: 30_000,
  unknownDialGraceMs: 120_000,
  cleanupRetryMs: 30_000,
  cleanupMaxAttempts: 6,
  openaiHangupMaxAttempts: 2,
  cronBudgetMs: 30_000,
  cronStartedCapMs: 40_000,
  /** Correlating an OpenAI `live.transport.incoming` back to a dial we made. */
  pendingWindowMs: 60_000,
  contextMaxChars: 300,
  historyLimit: 10,
} as const;

/** Outbound only: the OpenAI leg is dialled first so failures happen before the phone rings. */
export const AI_DEMO_LEG_ORDER = "openai_first" as const;
/** An `incoming` we cannot match is acknowledged, never rejected: a stray 603 would be ours to explain. */
export const AI_DEMO_REJECT_UNMATCHED = false;
/** The `To` header shape on OpenAI's side is unverified, so it is metadata only. */
export const AI_DEMO_STRICT_TO = false;

export const AI_DEMO_DEFAULT_MODEL = "gpt-live-1";
export const AI_DEMO_DEFAULT_BACKEND_MODEL = "gpt-5.6-terra";
export const AI_DEMO_DEFAULT_VOICE = "marin";
export const AI_DEMO_DEFAULT_SIP_HOST = "sip.api.openai.com";

export const AI_DEMO_ALLOWED_MODELS: readonly string[] = ["gpt-live-1"];
export const AI_DEMO_ALLOWED_BACKEND_MODELS: readonly string[] = ["gpt-5.6-terra", "gpt-5.6-luna"];
/** GPT-Live built-in voices (`SessionAcceptParams`); a custom voice id is not accepted here. */
export const AI_DEMO_ALLOWED_VOICES: readonly string[] = [
  "marin", "cedar", "sage", "alloy", "ash", "ballad", "beacon", "bossa", "cinder", "coral",
  "delta", "echo", "gleam", "meridian", "quartz", "ripple", "shimmer", "stone", "tempo", "verse", "vesper", "willow",
];
/**
 * `sip-eu` needs an EU data-residency project; on an ordinary project it does
 * not resolve. Both hosts are GeoIP-routed, so the plain host already lands in
 * Europe for a Slovak call.
 */
export const AI_DEMO_ALLOWED_SIP_HOSTS: readonly string[] = ["sip.api.openai.com", "sip-eu.api.openai.com"];

export type AiDemoConfig =
  | {
      configured: true;
      apiKey: string;
      projectId: string;
      webhookSecret: string;
      sipHost: string;
      model: string;
      backendModel: string;
      voice: string;
      fromNumber: string;
      allowedRecipients: readonly string[];
      maxAttemptsPerDay: number;
      maxCallSeconds: number;
      ringTimeoutSeconds: number;
      /** Per-call webhook override; `null` leaves the Call Control app's own URL in place. */
      webhookUrl: string | null;
    }
  | { configured: false; missing: string[] };

function read(env: EnvRecord, name: string): string | null {
  const value = env[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

/** The placeholder in `.env.example` must not count as a configured key. */
function isPlaceholder(value: string): boolean {
  return /^(?:your|changeme|placeholder|sk-xxx|xxx)/i.test(value) || value.includes("…");
}

export function parseRecipients(raw: string | null): readonly string[] | null {
  if (raw === null) return null;
  const parsed = raw
    .split(",")
    .map((entry) => normalizeE164(entry, { defaultCountryCode: "421" }))
    .filter((entry): entry is string => entry !== null);
  return parsed.length > 0 ? parsed : null;
}

/** `sip:proj_…@sip.api.openai.com;transport=tls` — the only dial target of the demo. */
export function buildSipUri(projectId: string, sipHost: string): string {
  return `sip:${projectId}@${sipHost};transport=tls`;
}

export function aiDemoFromNumber(env: EnvRecord = process.env): { number: string } | { invalid: string } {
  const override = read(env, "AI_DEMO_FROM_NUMBER");
  if (override === null) return { number: AI_DEMO_NEUTRAL_LINE };
  const normalized = normalizeE164(override, { defaultCountryCode: "421" });
  if (normalized === null) return { invalid: override };
  if (AI_DEMO_FORBIDDEN_FROM.includes(normalized)) return { invalid: normalized };
  if (!AI_DEMO_ALLOWED_FROM.includes(normalized)) return { invalid: normalized };
  return { number: normalized };
}

/**
 * Where Telnyx should send this call's events.
 *
 * Telnyx normally delivers to the webhook URL of the Call Control application
 * the call was dialled through — which is the shared one. `dial` accepts a
 * per-call `webhook_url`, so a demo running on its own deployment can claim its
 * own events without anybody editing the account, and without taking events
 * away from the deployment everybody else is using.
 *
 * Unset means "leave the application's URL alone", which is the right default
 * when the demo runs on the same deployment as everything else.
 */
export function aiDemoWebhookUrl(env: EnvRecord = process.env): string | null {
  const base = read(env, "AI_DEMO_WEBHOOK_BASE_URL");
  if (base === null) return null;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  // A plaintext or non-HTTP callback would be a downgrade nobody asked for.
  if (url.protocol !== "https:") return null;
  return `${url.origin}/api/telephony/telnyx/webhook`;
}

function allowlisted(value: string | null, allowed: readonly string[], fallback: string): string | null {
  if (value === null) return fallback;
  return allowed.includes(value) ? value : null;
}

/**
 * Reads the demo configuration. `missing` names the environment variables an
 * operator has to set — it is rendered verbatim in the settings tab, which is
 * why it carries names and never values.
 */
export function getAiDemoConfig(env: EnvRecord = process.env): AiDemoConfig {
  const missing: string[] = [];

  const apiKeyRaw = read(env, "OPENAI_API_KEY");
  const apiKey = apiKeyRaw !== null && !isPlaceholder(apiKeyRaw) ? apiKeyRaw : null;
  if (apiKey === null) missing.push("OPENAI_API_KEY");

  const projectId = read(env, "OPENAI_LIVE_PROJECT_ID");
  if (projectId === null || !/^proj_[A-Za-z0-9_-]+$/.test(projectId)) missing.push("OPENAI_LIVE_PROJECT_ID");

  const webhookSecret = read(env, "OPENAI_WEBHOOK_SECRET");
  if (webhookSecret === null) missing.push("OPENAI_WEBHOOK_SECRET");

  const sipHost = allowlisted(read(env, "OPENAI_LIVE_SIP_HOST"), AI_DEMO_ALLOWED_SIP_HOSTS, AI_DEMO_DEFAULT_SIP_HOST);
  if (sipHost === null) missing.push("OPENAI_LIVE_SIP_HOST");

  const model = allowlisted(read(env, "OPENAI_LIVE_MODEL"), AI_DEMO_ALLOWED_MODELS, AI_DEMO_DEFAULT_MODEL);
  if (model === null) missing.push("OPENAI_LIVE_MODEL");

  const backendModel = allowlisted(read(env, "OPENAI_LIVE_BACKEND_MODEL"), AI_DEMO_ALLOWED_BACKEND_MODELS, AI_DEMO_DEFAULT_BACKEND_MODEL);
  if (backendModel === null) missing.push("OPENAI_LIVE_BACKEND_MODEL");

  const voice = allowlisted(read(env, "OPENAI_LIVE_VOICE"), AI_DEMO_ALLOWED_VOICES, AI_DEMO_DEFAULT_VOICE);
  if (voice === null) missing.push("OPENAI_LIVE_VOICE");

  const from = aiDemoFromNumber(env);
  if ("invalid" in from) missing.push("AI_DEMO_FROM_NUMBER");

  /**
   * Required, not optional.
   *
   * The organisation's `destination_allowlist` is a country-level rule — "SK" —
   * which is the right control for dispatchers calling customers and the wrong
   * one for an experiment that dials a number a model was told about. With the
   * recipient list mandatory, the set of phones this feature can ever reach is
   * a deployment decision, made once, by whoever holds the environment.
   */
  const allowedRecipients = parseRecipients(read(env, "AI_DEMO_ALLOWED_RECIPIENTS"));
  if (allowedRecipients === null) missing.push("AI_DEMO_ALLOWED_RECIPIENTS");

  if (missing.length > 0 || apiKey === null || projectId === null || webhookSecret === null || sipHost === null || model === null || backendModel === null || voice === null || allowedRecipients === null || "invalid" in from) {
    return { configured: false, missing };
  }

  return {
    configured: true,
    apiKey,
    projectId,
    webhookSecret,
    sipHost,
    model,
    backendModel,
    voice,
    fromNumber: from.number,
    allowedRecipients,
    webhookUrl: aiDemoWebhookUrl(env),
    maxAttemptsPerDay: clampInt(read(env, "AI_DEMO_MAX_ATTEMPTS_PER_DAY"), 3, 1, 10),
    maxCallSeconds: clampInt(read(env, "AI_DEMO_MAX_CALL_SECONDS"), 300, 30, 300),
    ringTimeoutSeconds: clampInt(read(env, "AI_DEMO_RING_TIMEOUT_SECONDS"), AI_DEMO_LIMITS.sipRingSeconds, 5, 60),
  };
}

/** Derived budgets. One source value keeps the leg limits and the deadline consistent. */
export function aiDemoBudgets(config: Extract<AiDemoConfig, { configured: true }>) {
  const maxCallSeconds = config.maxCallSeconds;
  return {
    mobileTimeLimitSeconds: maxCallSeconds,
    sipTimeLimitSeconds: maxCallSeconds + AI_DEMO_LIMITS.sipTimeLimitExtraSeconds,
    /** Wall clock from the request; the cron enforces it when every webhook is lost. */
    attemptDeadlineSeconds: maxCallSeconds + config.ringTimeoutSeconds + 90,
    staleTalkingSeconds: maxCallSeconds + 60,
  };
}

export { aiDemoEnabled };
