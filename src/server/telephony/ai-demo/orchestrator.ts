import { isDestinationAllowed } from "@/lib/telephony/destinations";
import { normalizeE164 } from "@/lib/telephony/normalize-e164";
import { openAILiveClient, OpenAILiveError } from "@/lib/integrations/ai/openai-live";

import type { Json } from "@/lib/supabase/database.types";

import { recordTelephonyIncident, TELEPHONY_INCIDENT_JOBS } from "../incidents";
import { toJson } from "../state/types";
import { CallActionError } from "../service-errors";
import type { SessionRunnerDeps } from "../session-runner";
import { createTelnyxClient, isCallGoneError, TelnyxCommandError, TelnyxLiveCallsDisabledError, type TelnyxClient } from "../telnyx/client";
import type { ProcessorDeps } from "../telnyx/event-processor";
import {
  adoptLeg, casCounter, claimProbe, countToday, findByRequestId, findDue, insertAttempt, loadActive, loadAttempt,
  markLegGone, patchAttempt, transitionAttempt, type AiDemoAttempt,
} from "./attempts";
import { AI_DEMO_ALLOWED_VOICES, AI_DEMO_LIMITS, aiDemoBudgets, aiDemoEnabled, buildSipUri, getAiDemoConfig, voiceGender, type AiDemoConfig, type EnvRecord } from "./config";
import { callIsOver } from "./farewell";
import { judgeCall } from "./judge";
import { runGreeting, type GreetingResult, type ProbeControls, type ProbeLimits, type WebSocketFactory } from "./greeting";
import { readAgentSettings } from "./agent-settings";
import { describeBeforeVerification, fullDisclosureEnabled, lookupCallerCase } from "./caller-case";
import { PlateGate } from "./verification";
import { readVerificationAttempts, recordVerificationAttempts } from "./verification-store";
import type { AiDemoLeg } from "./flag";
import { aiDemoClientState, aiDemoCommandId, aiDemoCorrelationToken, maskNumber } from "./identity";
import {
  AI_DEMO_COMMENTARY_TRIGGER, AI_DEMO_DEFAULT_SCENARIO, buildBackendInstructions, buildGreetingAppend,
  buildStartupInstructions, isAiDemoScenario, pickGreeting, sanitizeContext, type AiDemoScenario,
} from "./prompts";

/**
 * The AI demo, end to end.
 *
 * Ordering: the OpenAI leg is dialled *first*, and the customer's phone only
 * once that leg has answered. Everything that can go wrong with an
 * experimental integration — SIP not enabled on the project, a rejected
 * accept, a bad caller ID — therefore goes wrong before anybody's phone rings.
 * The cost is two to six seconds of a parked AI session; the benefit is that a
 * failed demo is invisible to the person being called.
 *
 * Latency: the only budget that matters is the one that starts when somebody
 * picks up. That path is one webhook, one WebSocket open and two pipelined
 * commands, in that order and with nothing else on it. Everything expensive —
 * persona, scenario, the caller's context — is already inside the session by
 * then, delivered in the `accept` body while the phone was still ringing.
 *
 * Termination: `ending` is the only door to a terminal state, `failed` is
 * exactly `error_code is not null`, and a failure never dials anything. The
 * provider's own `time_limit_secs` is the backstop, so the call ends on time
 * even if this application is having a bad day.
 */

export type AiDemoDeps = SessionRunnerDeps &
  Pick<ProcessorDeps, "deferMaintenance" | "ledgerReplay"> & {
    env?: EnvRecord;
    /** Injected in tests; production uses the Node global. */
    webSocketFactory?: WebSocketFactory;
    /** Shortened in tests so the suite does not wait out the real probe window. */
    probeLimits?: ProbeLimits;
    openAIFetch?: typeof fetch;
    /**
     * Short-budget Telnyx client for the webhook and cleanup paths.
     *
     * The shared `deps.telnyx` carries a 12-second operation budget sized for
     * an operator waiting at a screen. A webhook has ten seconds in total, so
     * these paths build their own client — and the seam is what lets the tests
     * drive the fake provider.
     */
    telnyxClientFactory?: (operationTimeoutMs: number) => TelnyxClient;
  };

export class AiDemoError extends CallActionError {
  constructor(message: string, status: number, code: string, readonly missing?: string[]) {
    super(message, status, code);
    this.name = "AiDemoError";
  }
}

/** Thrown after a state transition has been applied, so the caller answers 200 rather than asking for redelivery. */
export class AiDemoTransitionApplied extends Error {
  constructor(readonly cause: unknown) {
    super("ai_demo_transition_applied");
    this.name = "AiDemoTransitionApplied";
  }
}

const nowOf = (deps: AiDemoDeps): Date => (deps.now ? deps.now() : new Date());

function shortBudgetClient(deps: AiDemoDeps, operationTimeoutMs: number, liveGate: { callsEnabled: boolean; smsEnabled: boolean }): TelnyxClient {
  if (deps.telnyxClientFactory) return deps.telnyxClientFactory(operationTimeoutMs);
  return createTelnyxClient({ config: deps.config, liveGate, operationTimeoutMs });
}

function requireConfig(deps: AiDemoDeps): Extract<AiDemoConfig, { configured: true }> {
  const env = deps.env ?? process.env;
  if (!aiDemoEnabled(env)) throw new AiDemoError("AI demo nie je v tomto prostredí zapnuté.", 403, "ai_demo_disabled");
  const config = getAiDemoConfig(env);
  if (!config.configured) {
    throw new AiDemoError("AI demo nie je nakonfigurované. Chýba serverová konfigurácia.", 503, "ai_demo_not_configured", config.missing);
  }
  return config;
}

function requireTelnyx(deps: AiDemoDeps) {
  if (!deps.telnyx || !deps.config.configured) throw new AiDemoError("Telefónia nie je nakonfigurovaná.", 503, "telephony_not_configured");
  // Checked before the row is inserted: a refusal must not leave an attempt behind.
  if (!deps.telnyx.liveGate.callsEnabled) throw new TelnyxLiveCallsDisabledError();
  return deps.telnyx;
}

export type StartAiDemoInput = {
  actorProfileId: string;
  requestId: string | null;
  to: string;
  scenario?: unknown;
  context?: unknown;
  /** Optional per-call voice; anything outside the allowlist falls back to the configured default. */
  voice?: unknown;
};

export type StartAiDemoResult = { attempt: AiDemoAttempt; reused: boolean };

/**
 * Validates the request, records it, then dials.
 *
 * Four independent gates stand between an authenticated admin and a phone
 * ringing: the environment switch, the organisation's destination allowlist,
 * the server-side recipient list, and the daily counter. None of them can be
 * influenced by the request body, and the model never sees a phone number at
 * all — it is dialled by us, from a list we hold.
 */
export async function startAiDemo(deps: AiDemoDeps, input: StartAiDemoInput): Promise<StartAiDemoResult> {
  const config = requireConfig(deps);
  const telnyx = requireTelnyx(deps);
  const now = nowOf(deps);

  const target = normalizeE164(input.to, { defaultCountryCode: "421" });
  if (target === null || !/^\+[1-9]\d{6,14}$/.test(target)) {
    throw new AiDemoError("Telefónne číslo nie je platné.", 400, "invalid_number");
  }

  const ownLine = await deps.admin
    .from("motorist_telephony_lines")
    .select("id")
    .eq("organization_id", deps.organizationId)
    .eq("phone_number", target)
    .eq("active", true)
    .maybeSingle();
  if (ownLine.error) throw new AiDemoError("Linky sa nepodarilo načítať.", 503, "line_unavailable");
  // Calling our own DID would loop the demo into the inbound path.
  if (ownLine.data) throw new AiDemoError("Toto je naša vlastná linka. Zadaj mobilné číslo.", 400, "ai_demo_target_is_own_line");

  const settings = await deps.admin
    .from("motorist_telephony_settings")
    .select("destination_allowlist")
    .eq("organization_id", deps.organizationId)
    .maybeSingle();
  if (settings.error) throw new AiDemoError("Nastavenia telefónie sa nepodarilo načítať.", 503, "settings_unavailable");
  const allowlist = (settings.data?.destination_allowlist as string[] | null) ?? null;
  if (!isDestinationAllowed(target, allowlist)) {
    throw new AiDemoError("Toto číslo nie je v povolených cieľoch organizácie.", 403, "destination_not_allowed");
  }
  // The shortlist is a second, tighter gate over the organisation's own
  // allowlist. Empty means the demo may call whatever an ordinary outbound
  // call may call — which is a deliberate setting, not an oversight.
  if (config.allowedRecipients.length > 0 && !config.allowedRecipients.includes(target)) {
    throw new AiDemoError("Toto číslo nie je v serverovom zozname povolených príjemcov dema.", 403, "ai_demo_recipient_not_allowed");
  }

  const fromLine = await deps.admin
    .from("motorist_telephony_lines")
    .select("id, active")
    .eq("organization_id", deps.organizationId)
    .eq("phone_number", config.fromNumber)
    .eq("active", true)
    .maybeSingle();
  if (fromLine.error) throw new AiDemoError("Odchádzajúcu linku sa nepodarilo načítať.", 503, "line_unavailable");
  // Fail closed: without a known active line we cannot say whose identity the
  // recipient would see, and "some number from the account" is not an answer.
  if (!fromLine.data) throw new AiDemoError("Odchádzajúca linka dema nie je aktívna v tejto organizácii.", 503, "ai_demo_from_invalid");

  if (input.requestId) {
    const existing = await findByRequestId(deps.admin, deps.organizationId, input.actorProfileId, input.requestId);
    if (existing) return { attempt: existing, reused: true };
  }

  // `0` is an explicit "no daily cap", for a session of back-to-back test
  // calls. It removes one guard of four: one demo at a time, the server-held
  // recipient list and the five-minute ceiling all still stand, and every call
  // still costs money.
  if (config.maxAttemptsPerDay > 0) {
    const midnight = new Date(now);
    midnight.setUTCHours(0, 0, 0, 0);
    const today = await countToday(deps.admin, deps.organizationId, midnight);
    if (today >= config.maxAttemptsPerDay) {
      throw new AiDemoError(`Denný limit dema je vyčerpaný (${config.maxAttemptsPerDay}).`, 429, "ai_demo_daily_limit");
    }
  }

  const scenario: AiDemoScenario = isAiDemoScenario(input.scenario) ? input.scenario : AI_DEMO_DEFAULT_SCENARIO;
  const context = sanitizeContext(input.context, AI_DEMO_LIMITS.contextMaxChars);
  // A voice cannot change once the session starts, so it is chosen here and
  // recorded on the attempt — which also makes the history a record of which
  // voice was actually heard.
  const voice = typeof input.voice === "string" && AI_DEMO_ALLOWED_VOICES.includes(input.voice) ? input.voice : config.voice;
  if (scenario === "custom" && (context === null || context.length < 10)) {
    throw new AiDemoError("Pri vlastnom účele treba doplniť kontext (aspoň 10 znakov).", 400, "ai_demo_context_required");
  }

  const budgets = aiDemoBudgets(config);
  const attemptId = crypto.randomUUID();
  const inserted = await insertAttempt(deps.admin, {
    organizationId: deps.organizationId,
    environment: deps.environment,
    actorProfileId: input.actorProfileId,
    requestId: input.requestId,
    scenario,
    targetNumber: target,
    fromNumber: config.fromNumber,
    correlationToken: aiDemoCorrelationToken(attemptId),
    sipDialCommandId: aiDemoCommandId(attemptId, "sip", "dial"),
    requestedAt: now,
    deadlineAt: new Date(now.getTime() + budgets.attemptDeadlineSeconds * 1_000),
    metadata: { context, voice, backendModel: config.backendModel, sipHost: config.sipHost },
  });

  if ("conflict" in inserted) {
    if (inserted.conflict === "busy") throw new AiDemoError("Jedno demo už beží. Najprv ho ukonči.", 409, "ai_demo_busy");
    // The unique index rejected a replay whose row we could not read above.
    const existing = input.requestId ? await findByRequestId(deps.admin, deps.organizationId, input.actorProfileId, input.requestId) : null;
    if (existing) return { attempt: existing, reused: true };
    throw new AiDemoError("Požiadavka sa opakovala.", 409, "ai_demo_duplicate");
  }

  // The row exists with its own id, not `attemptId`, unless the database used
  // ours; every derived identifier must come from the row from here on.
  const attempt = inserted.attempt;
  const dialing = await transitionAttempt(deps.admin, attempt.id, ["requested"], {
    state: "sip_dialing",
    sip_dialed_at: now.toISOString(),
    correlation_token: aiDemoCorrelationToken(attempt.id),
    sip_dial_command_id: aiDemoCommandId(attempt.id, "sip", "dial"),
  });
  if (!dialing) throw new AiDemoError("Demo sa nepodarilo pripraviť.", 409, "ai_demo_state_conflict");

  try {
    const result = await dialSipLeg({ ...deps, telnyx }, dialing, config);
    return { attempt: result, reused: false };
  } catch (error) {
    if (error instanceof TelnyxCommandError) {
      const uncertain = error.retryable || error.status === 408 || error.status >= 500;
      // The kill switch is not a dial failure. Somebody turned live calls off
      // between this row being written and the provider being asked, and the
      // history should say that rather than blame the number.
      const code = error.code === "live_calls_disabled" ? "live_calls_disabled" : uncertain ? "dial_unknown" : "sip_dial_rejected";
      await patchAttempt(deps.admin, dialing.id, { sip_dial_outcome: uncertain ? "unknown" : "rejected" });
      await requestEnding(deps, dialing.id, code, code);
      if (!uncertain) await endAttempt(deps, dialing.id, AI_DEMO_LIMITS.cleanupBudgetActionMs, "inline");
      throw new AiDemoError(
        error.code === "live_calls_disabled" ? error.message : "Volanie k AI sa nepodarilo vytvoriť.",
        error.status === 423 ? 423 : 502,
        `ai_demo_${error.code}`,
      );
    }
    await requestEnding(deps, dialing.id, "dial_failed", "dial_failed");
    throw error;
  }
}

/**
 * Dials the OpenAI leg.
 *
 * `media_encryption: "SRTP"` is mandatory on this leg (GPT-Live refuses plain
 * RTP) and must never appear on a PSTN leg, which answers `10011`.
 * `send_silence_when_idle` keeps comfort noise flowing while the session waits
 * for the customer, so the model does not interpret a parked leg as a hang-up.
 */
async function dialSipLeg(
  deps: AiDemoDeps & { telnyx: NonNullable<AiDemoDeps["telnyx"]> },
  attempt: AiDemoAttempt,
  config: Extract<AiDemoConfig, { configured: true }>,
): Promise<AiDemoAttempt> {
  const budgets = aiDemoBudgets(config);
  const result = await deps.telnyx.dial({
    commandId: attempt.sip_dial_command_id,
    to: buildSipUri(config.projectId, config.sipHost),
    from: attempt.from_number,
    fromDisplayName: attempt.correlation_token,
    clientState: aiDemoClientState(attempt.id, "sip"),
    timeoutSecs: config.ringTimeoutSeconds,
    timeLimitSecs: budgets.sipTimeLimitSeconds,
    mediaEncryption: "SRTP",
    sipRegion: "Europe",
    ...(config.webhookUrl ? { webhookUrl: config.webhookUrl } : {}),
    extra: { sip_transport_protocol: "TLS", send_silence_when_idle: true },
  });

  const adopted = await adoptLeg(deps.admin, attempt.id, "sip", result, { sip_dial_outcome: "accepted" });
  return adopted ?? attempt;
}

/** Dials the person. The only leg that reaches the public network. */
export async function dialMobileLeg(deps: AiDemoDeps, attempt: AiDemoAttempt): Promise<void> {
  const config = requireConfig(deps);
  if (!deps.config.configured) throw new AiDemoError("Telefónia nie je nakonfigurovaná.", 503, "telephony_not_configured");
  if (!attempt.telnyx_sip_call_control_id) throw new AiDemoError("Chýba identifikátor AI vetvy.", 409, "ai_demo_missing_sip_leg");

  const budgets = aiDemoBudgets(config);
  const commandId = aiDemoCommandId(attempt.id, "mobile", "dial");
  // A short-lived client: the webhook has its own budget and must not inherit
  // the default operation timeout meant for an operator waiting at a screen.
  const client = shortBudgetClient(deps, AI_DEMO_LIMITS.mobileDialOperationMs, deps.telnyx?.liveGate ?? { callsEnabled: false, smsEnabled: false });

  try {
    const result = await client.dial({
      commandId,
      to: attempt.target_number,
      from: attempt.from_number,
      clientState: aiDemoClientState(attempt.id, "mobile"),
      timeoutSecs: config.ringTimeoutSeconds,
      timeLimitSecs: budgets.mobileTimeLimitSeconds,
      linkTo: attempt.telnyx_sip_call_control_id,
      // `link_to` alone only puts both legs in one session. Without
      // `bridge_on_answer` the audio is never joined and the customer hears
      // nothing at all.
      bridgeOnAnswer: true,
      preventDoubleBridge: true,
      ...(config.webhookUrl ? { webhookUrl: config.webhookUrl } : {}),
    });
    await adoptLeg(deps.admin, attempt.id, "mobile", result, { mobile_dial_outcome: "accepted", mobile_dial_command_id: commandId });
  } catch (error) {
    if (error instanceof TelnyxCommandError) {
      const uncertain = error.retryable || error.status === 408 || error.status >= 500;
      await patchAttempt(deps.admin, attempt.id, { mobile_dial_outcome: uncertain ? "unknown" : "rejected", mobile_dial_command_id: commandId });
      // Never redial: an uncertain outcome may already be ringing somebody.
      await requestEnding(deps, attempt.id, uncertain ? "mobile_dial_unknown" : "mobile_dial_rejected", uncertain ? "mobile_dial_unknown" : "mobile_dial_rejected");
      if (!uncertain) await endAttempt(deps, attempt.id, AI_DEMO_LIMITS.cleanupBudgetWebhookMs, "deferred");
      return;
    }
    throw error;
  }
}

export type AcceptOutcome = { accepted: boolean; code?: string };

/**
 * Accepts the pending GPT-Live session.
 *
 * Synchronous inside the OpenAI webhook: the provider retries only when it
 * does not get a 2xx, and the phone is not ringing yet, so this is the cheapest
 * possible place to spend eight seconds. The whole persona goes in here — by
 * the time the customer answers, the session must already know everything.
 */
export async function acceptSession(deps: AiDemoDeps, attempt: AiDemoAttempt, sessionId: string): Promise<AcceptOutcome> {
  const config = requireConfig(deps);
  const scenario: AiDemoScenario = isAiDemoScenario(attempt.scenario) ? attempt.scenario : AI_DEMO_DEFAULT_SCENARIO;
  const context = typeof (attempt.metadata as { context?: unknown })?.context === "string" ? ((attempt.metadata as { context?: string }).context ?? null) : null;

  const chosenVoice = readVoice(attempt.metadata);
  const voice = chosenVoice !== null && AI_DEMO_ALLOWED_VOICES.includes(chosenVoice) ? chosenVoice : config.voice;

  const client = openAILiveClient({
    apiKey: config.apiKey,
    signal: AbortSignal.timeout(AI_DEMO_LIMITS.acceptTimeoutMs),
    ...(deps.openAIFetch ? { fetch: deps.openAIFetch } : {}),
  });

  try {
    const result = await client.accept({
      sessionId,
      model: config.model,
      voice,
      instructions: buildStartupInstructions(scenario, context, voiceGender(voice)),
      backendModel: config.backendModel,
      // The procedure lives here, not in the voice prompt: the guide is explicit
      // that long business procedures belong to the backend, and a voice model
      // reading a numbered list sounds like one.
      backendInstructions: buildBackendInstructions(scenario, context),
      tuning: {
        // The backend is only asked to reason when the voice model delegates.
        // On a phone call, thinking time is silence, so it is turned off and
        // the replies are capped short.
        reasoningEffort: "none",
        serviceTier: "ultrafast",
        maxOutputTokens: 400,
      },
    });
    await transitionAttempt(deps.admin, attempt.id, ["ai_offered"], {
      state: "ai_accepted",
      ai_accepted_at: nowOf(deps).toISOString(),
      metadata: { ...(attempt.metadata as Record<string, unknown>), accept: result.status, tuning_applied: result.tuningApplied },
    });
    return { accepted: true };
  } catch (error) {
    const code = error instanceof OpenAILiveError ? error.code : "openai_accept_failed";
    await requestEnding(deps, attempt.id, code, code === "openai_auth" ? "openai_auth" : "accept_failed");
    await endAttempt(deps, attempt.id, AI_DEMO_LIMITS.cleanupBudgetWebhookMs, "deferred");
    return { accepted: false, code };
  }
}

/**
 * The greeting, and the measurement of it.
 *
 * Runs after the HTTP response so the webhook is acknowledged inside Telnyx's
 * ten-second window while the socket work continues. The state moves to
 * `talking` whatever happens: a probe that failed tells us nothing about
 * whether the caller heard her, and a demo that hangs up because it could not
 * measure itself would be absurd.
 */
export async function runGreetingAndFinish(deps: AiDemoDeps, attemptId: string, options: { inline?: boolean } = {}): Promise<void> {
  const existing = await loadAttempt(deps.admin, deps.organizationId, attemptId);
  if (!existing || existing.state !== "bridged" || !existing.openai_session_id) return;

  // Exactly one probe per call. The webhook hands off to the listener and
  // listens itself if that fails; a hand-off that timed out may have started
  // one anyway, and then the caller is greeted twice.
  const claimed = await claimProbe(deps.admin, attemptId, nowOf(deps));
  if (claimed === null) {
    deps.logger?.({ scope: "ai-demo", attemptId, message: "probe already claimed" });
    return;
  }
  if (claimed === "unclaimable") {
    deps.logger?.({ level: "warn", scope: "ai-demo", attemptId, message: "probe claim column missing; greeting without the guarantee" });
  }
  const attempt = claimed === "unclaimable" ? existing : claimed;

  const config = requireConfig(deps);
  const scenario: AiDemoScenario = isAiDemoScenario(attempt.scenario) ? attempt.scenario : AI_DEMO_DEFAULT_SCENARIO;
  const context = typeof (attempt.metadata as { context?: unknown })?.context === "string" ? ((attempt.metadata as { context?: string }).context ?? null) : null;

  // The judge is asked about a silence, not about every tick of it.
  const silence = { lastJudgedAt: 0, askedToCloseAt: null as number | null };
  const probeLimits: ProbeLimits = deps.probeLimits ?? {
    ...AI_DEMO_LIMITS,
    keepTranscript: config.storeTranscript,
    ...(options.inline ? { probeWindowMs: AI_DEMO_LIMITS.inlineProbeWindowMs } : {}),
  };

  // Who is on the line, and what of their case she may know.
  //
  // The record is held here, in the server, and never reaches the model until
  // the plate checks out. That is the whole protection: not a sentence in the
  // instructions asking her to be careful, but the fact that there is nothing
  // to be careless with.
  const gate = await preparePlateGate(deps, attempt);

  let result: GreetingResult;
  try {
    result = await runGreeting({
      // Checked on `existing` before the claim; the claim returns the same row.
      sessionId: existing.openai_session_id,
      apiKey: config.apiKey,
      greetingText: [buildGreetingAppend(scenario, context !== null, pickGreeting(scenario, deps.random)), gate?.opening]
        .filter(Boolean)
        .join(" "),
      commentaryText: AI_DEMO_COMMENTARY_TRIGGER,
      eventIdSeed: attempt.id.replace(/-/g, "").slice(0, 8),
      ...(deps.webSocketFactory ? { webSocketFactory: deps.webSocketFactory } : {}),
      /**
       * Inline means this is running inside the Telnyx webhook, whose budget is
       * sized for the human call path. A window longer than that budget does
       * not listen for longer — it gets the function killed, and before this
       * was checkpointed that lost the entire call.
       */
      limits: probeLimits,
      onProgress: async (partial, controls) => {
        await savePartial(deps, attempt, partial);
        await advanceVerification(deps, gate, partial, controls);

        const ended = await watchSilence(deps, attempt, config, partial, controls, silence, probeLimits);
        if (ended) return false;

        // Stop as soon as the call is over rather than waiting out the window;
        // `session.closed` is not something we have ever seen proven to arrive.
        const current = await loadAttempt(deps.admin, deps.organizationId, attempt.id);
        return current !== null && current.state !== "ended" && current.state !== "failed";
      },
    });
  } catch (error) {
    deps.logger?.({ level: "warn", scope: "ai-demo", attemptId: attempt.id, message: "greeting failed", error: error instanceof Error ? error.message : String(error) });
    await transitionAttempt(deps.admin, attempt.id, ["bridged"], { state: "talking", greeting_status: "failed", talking_at: nowOf(deps).toISOString() });
    return;
  }

  const bridgedMs = attempt.bridged_at ? Date.parse(attempt.bridged_at) : null;
  const finishedAt = (offset: number | null): string | null => (offset === null || bridgedMs === null ? null : new Date(bridgedMs + offset).toISOString());

  await transitionAttempt(deps.admin, attempt.id, ["bridged"], {
    state: "talking",
    talking_at: nowOf(deps).toISOString(),
    greeting_status: result.status,
    greeting_appended_at: finishedAt(result.appendedMs),
    first_transcript_at: finishedAt(result.firstDeltaMs),
    latency_probe: toJson(result.probe),
    transcript: toJson(result.transcript),
    conversation_stats: toJson(result.stats),
    metadata: toJson({ ...(attempt.metadata as Record<string, unknown>), latency: latencyOf(result) }),
  });

  deps.logger?.({
    scope: "ai-demo",
    attemptId: attempt.id,
    message: "greeting probe",
    status: result.status,
    firstWordMs: result.firstDeltaMs,
    appendedMs: result.appendedMs,
    responseGapsMs: result.responseGapsMs,
    // Counts and durations only; the words stay in the database row.
    stats: result.stats,
  });
}

/**
 * Writes down what has been heard so far, without touching the state machine.
 *
 * The state moves once, at the end. This runs every few seconds so that a probe
 * cut short — by a budget, a redeploy, anything — still leaves the part of the
 * call it did hear.
 */
async function savePartial(deps: AiDemoDeps, attempt: AiDemoAttempt, result: GreetingResult): Promise<void> {
  const bridgedAt = attempt.bridged_at ? Date.parse(attempt.bridged_at) : null;
  const at = (offset: number | null): string | null => (offset === null || bridgedAt === null ? null : new Date(bridgedAt + offset).toISOString());
  try {
    await patchAttempt(deps.admin, attempt.id, {
      greeting_appended_at: at(result.appendedMs),
      first_transcript_at: at(result.firstDeltaMs),
      latency_probe: toJson(result.probe),
      transcript: toJson(result.transcript),
      conversation_stats: toJson(result.stats),
      metadata: toJson({ ...(attempt.metadata as Record<string, unknown>), latency: latencyOf(result) }),
    });
  } catch (error) {
    deps.logger?.({ level: "warn", scope: "ai-demo", attemptId: attempt.id, message: "checkpoint failed", error: error instanceof Error ? error.message : String(error) });
  }
}

function latencyOf(result: GreetingResult): Json {
  return toJson({
    greeting_appended_ms: result.appendedMs,
    first_word_ms: result.firstDeltaMs,
    response_gaps_ms: result.responseGapsMs,
    ...(result.error ? { probe_error: result.error } : {}),
  });
}

/** Moves any non-terminal attempt into `ending`; the single door to a terminal state. */
export async function requestEnding(deps: AiDemoDeps, attemptId: string, endReason: string, errorCode: string | null): Promise<AiDemoAttempt | null> {
  const now = nowOf(deps);
  return transitionAttempt(
    deps.admin,
    attemptId,
    ["requested", "sip_dialing", "ai_offered", "ai_accepted", "mobile_dialing", "bridged", "talking"],
    { state: "ending", ending_requested_at: now.toISOString(), end_reason: endReason, error_code: errorCode },
  );
}

export type EndAttemptResult = { state: "ended" | "failed" | "ending"; openai: "done" | "deferred" | "pending" };

/**
 * Releases everything, idempotently, and closes the row.
 *
 * Each leg is hung up at most once (`*_hangup_done_at` is the receipt) and a
 * Telnyx refusal because the call is already over counts as done — retrying
 * cannot bring a leg back. `ended` deliberately does not wait on OpenAI: the
 * SIP BYE already tears the session down, the REST hangup is belt-and-braces,
 * and letting a provider timeout hold the row open would strand it in
 * `ending` for no gain.
 */
export async function endAttempt(deps: AiDemoDeps, attemptId: string, budgetMs: number, openaiMode: "inline" | "deferred"): Promise<EndAttemptResult> {
  const deadline = Date.now() + budgetMs;
  const attempt = await loadAttempt(deps.admin, deps.organizationId, attemptId);
  if (!attempt) return { state: "ending", openai: "pending" };
  if (attempt.state === "ended" || attempt.state === "failed") {
    return { state: attempt.state, openai: attempt.openai_hangup_done_at ? "done" : "pending" };
  }
  if (attempt.state !== "ending") {
    const moved = await requestEnding(deps, attemptId, "cleanup", null);
    if (!moved) return { state: "ending", openai: "pending" };
  }

  const current = (await loadAttempt(deps.admin, deps.organizationId, attemptId)) ?? attempt;
  const legs: Array<{ leg: AiDemoLeg; callControlId: string | null; done: string | null }> = [
    { leg: "mobile", callControlId: current.telnyx_mobile_call_control_id, done: current.mobile_hangup_done_at },
    { leg: "sip", callControlId: current.telnyx_sip_call_control_id, done: current.sip_hangup_done_at },
  ];

  let allLegsSettled = true;
  if (deps.config.configured && deps.telnyx) {
    // Cleanup is explicitly not gated: switching off new calls must never be
    // the reason a live leg cannot be released.
    const client = shortBudgetClient(deps, AI_DEMO_LIMITS.cleanupOperationMs, { callsEnabled: true, smsEnabled: false });
    for (const entry of legs) {
      if (!entry.callControlId || entry.done) continue;
      if (Date.now() > deadline) {
        allLegsSettled = false;
        break;
      }
      try {
        await client.hangup({ callControlId: entry.callControlId, commandId: aiDemoCommandId(current.id, entry.leg, "hangup") });
        await markLegGone(deps.admin, current.id, entry.leg, current[entry.leg === "sip" ? "sip_hangup_cause" : "mobile_hangup_cause"] ?? "cleanup", nowOf(deps));
      } catch (error) {
        // "Already gone" is the outcome we wanted.
        if (isCallGoneError(error) || (error instanceof TelnyxCommandError && (error.status === 404 || error.status === 422))) {
          await markLegGone(deps.admin, current.id, entry.leg, "gone", nowOf(deps));
          continue;
        }
        allLegsSettled = false;
        deps.logger?.({ level: "warn", scope: "ai-demo", attemptId: current.id, leg: entry.leg, message: "hangup unresolved", error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  let openai: EndAttemptResult["openai"] = current.openai_hangup_done_at ? "done" : "pending";
  if (current.openai_session_id && !current.openai_hangup_done_at && current.openai_hangup_attempts < AI_DEMO_LIMITS.openaiHangupMaxAttempts) {
    const release = async () => {
      const claimed = await casCounter(deps.admin, current.id, "openai_hangup_attempts", current.openai_hangup_attempts);
      if (!claimed || !claimed.openai_session_id) return;
      try {
        const client = openAILiveClient({
          apiKey: requireConfig(deps).apiKey,
          signal: AbortSignal.timeout(AI_DEMO_LIMITS.openaiHangupTimeoutMs),
          ...(deps.openAIFetch ? { fetch: deps.openAIFetch } : {}),
        });
        const result = await client.hangup(claimed.openai_session_id);
        if (result.done) await patchAttempt(deps.admin, current.id, { openai_hangup_done_at: nowOf(deps).toISOString() });
      } catch (error) {
        deps.logger?.({ level: "warn", scope: "ai-demo", attemptId: current.id, message: "openai hangup unresolved", error: error instanceof OpenAILiveError ? error.code : "unknown" });
      }
    };
    if (openaiMode === "deferred" && deps.deferMaintenance) {
      deps.deferMaintenance(release);
      openai = "deferred";
    } else {
      await release();
      const after = await loadAttempt(deps.admin, deps.organizationId, attemptId);
      openai = after?.openai_hangup_done_at ? "done" : "pending";
    }
  }

  if (!allLegsSettled) {
    await casCounter(deps.admin, current.id, "cleanup_attempts", current.cleanup_attempts, {
      cleanup_next_attempt_at: new Date(Date.now() + AI_DEMO_LIMITS.cleanupRetryMs).toISOString(),
    });
    const attempts = current.cleanup_attempts + 1;
    if (attempts >= AI_DEMO_LIMITS.cleanupMaxAttempts) {
      await transitionAttempt(deps.admin, current.id, ["ending"], { state: "failed", error_code: current.error_code ?? "cleanup_exhausted", ended_at: nowOf(deps).toISOString() });
      await recordTelephonyIncident(deps.admin, {
        job: TELEPHONY_INCIDENT_JOBS.commands,
        error: new Error("ai_demo_cleanup_exhausted"),
        context: { attemptId: current.id, code: "ai_demo_cleanup_exhausted" },
      });
      return { state: "failed", openai };
    }
    return { state: "ending", openai };
  }

  const terminal = current.error_code !== null ? "failed" : "ended";
  const closed = await transitionAttempt(deps.admin, current.id, ["ending"], { state: terminal, ended_at: nowOf(deps).toISOString() });
  return { state: closed ? terminal : "ending", openai };
}

/** The admin "Ukončiť" button. Works even when new calls are switched off. */
export async function stopAiDemo(deps: AiDemoDeps, attemptId: string): Promise<AiDemoAttempt | null> {
  const attempt = await loadAttempt(deps.admin, deps.organizationId, attemptId);
  if (!attempt) return null;
  if (attempt.state !== "ended" && attempt.state !== "failed") {
    await requestEnding(deps, attemptId, "admin_stop", null);
    await endAttempt(deps, attemptId, AI_DEMO_LIMITS.cleanupBudgetActionMs, "inline");
  }
  return loadAttempt(deps.admin, deps.organizationId, attemptId);
}

export type AiDemoCleanupDetail = { checked: number; ended: number; timedOut: number };

/**
 * The five-minute sweep.
 *
 * It exists for the case where every webhook was lost: the deadline and the
 * per-state staleness rules are what guarantee a demo cannot sit open for
 * hours. It never starts anything — the only paid call it can make is a
 * hangup.
 */
export async function runAiDemoCleanup(deps: AiDemoDeps, options: { deadline: number }): Promise<AiDemoCleanupDetail> {
  const detail: AiDemoCleanupDetail = { checked: 0, ended: 0, timedOut: 0 };
  let due: AiDemoAttempt[];
  try {
    due = await findDue(deps.admin, deps.organizationId, 5);
  } catch {
    return detail;
  }

  const now = nowOf(deps).getTime();
  for (const attempt of due) {
    if (Date.now() > options.deadline) {
      detail.timedOut += 1;
      break;
    }
    detail.checked += 1;
    const verdict = cleanupVerdict(attempt, now);
    if (!verdict) continue;
    if (verdict.endReason !== null) await requestEnding(deps, attempt.id, verdict.endReason, verdict.errorCode);
    const result = await endAttempt(deps, attempt.id, Math.max(1_000, options.deadline - Date.now()), "inline");
    if (result.state === "ended" || result.state === "failed") detail.ended += 1;
  }
  return detail;
}

type Verdict = { endReason: string | null; errorCode: string | null };

/**
 * The staleness rules, as data.
 *
 * Each non-terminal state has one question: how long may it last before the
 * only honest conclusion is that a webhook never arrived? A row already in
 * `ending` is not judged again — it is simply retried.
 */
export function cleanupVerdict(attempt: AiDemoAttempt, now: number): Verdict | null {
  const age = (iso: string | null): number | null => (iso ? now - Date.parse(iso) : null);
  const over = (iso: string | null, ms: number): boolean => {
    const value = age(iso);
    return value !== null && value > ms;
  };

  if (now > Date.parse(attempt.deadline_at) && attempt.state !== "ending") {
    // Past the bridge the conversation actually happened and the deadline is
    // only the backstop that closed the row. Before it, nobody heard anything,
    // and calling that "ended" would hide a failed demo in the history.
    const heard = attempt.bridged_at !== null;
    return { endReason: "deadline", errorCode: heard ? null : "deadline" };
  }

  switch (attempt.state) {
    case "requested":
      return over(attempt.requested_at, AI_DEMO_LIMITS.requestedStaleMs) ? { endReason: "dial_failed", errorCode: "dial_failed" } : null;
    case "sip_dialing": {
      if (!over(attempt.sip_dialed_at, AI_DEMO_LIMITS.sipDialingStaleMs)) return null;
      if (attempt.sip_dial_outcome === "none") return { endReason: "dial_failed", errorCode: "dial_failed" };
      if (attempt.sip_dial_outcome === "unknown" && !attempt.telnyx_sip_call_control_id) return { endReason: "dial_unknown", errorCode: "dial_unknown" };
      return { endReason: "sip_no_answer", errorCode: "sip_no_answer" };
    }
    case "ai_offered":
      return over(attempt.accept_started_at ?? attempt.ai_offered_at, AI_DEMO_LIMITS.acceptLostMs) ? { endReason: "accept_lost", errorCode: "accept_lost" } : null;
    case "ai_accepted":
      return over(attempt.ai_accepted_at, AI_DEMO_LIMITS.sipAnswerLostMs) && !attempt.sip_answered_at
        ? { endReason: "sip_answer_lost", errorCode: "sip_answer_lost" }
        : null;
    case "mobile_dialing": {
      if (attempt.mobile_dial_outcome === "none" && over(attempt.mobile_dialed_at, AI_DEMO_LIMITS.mobileDialLostMs)) {
        return { endReason: "mobile_dial_lost", errorCode: "mobile_dial_lost" };
      }
      return over(attempt.mobile_dialed_at, AI_DEMO_LIMITS.mobileAnswerLostMs) ? { endReason: "mobile_answer_lost", errorCode: "mobile_answer_lost" } : null;
    }
    case "bridged":
      // The greeting probe is the only thing that moves `bridged` forward, and
      // it lives in an `after()` that a cold shutdown can lose.
      return over(attempt.bridged_at, AI_DEMO_LIMITS.greetingLostMs) ? { endReason: null, errorCode: null } : null;
    case "talking":
      return null;
    case "ending":
      return attempt.cleanup_next_attempt_at === null || now >= Date.parse(attempt.cleanup_next_attempt_at) ? { endReason: null, errorCode: null } : null;
    default:
      return null;
  }
}

/** Fragments newer than the cursor; everything when there is none. */
function sliceTranscript(stored: unknown, since: number | undefined): Array<{ ms: number; dir: string; text: string }> | null {
  if (!Array.isArray(stored)) return null;
  const entries = stored as Array<{ ms?: unknown; dir?: unknown; text?: unknown }>;
  const usable = entries.filter((entry) => entry && typeof entry === "object" && typeof entry.text === "string");
  const wanted = typeof since === "number" && Number.isFinite(since) ? usable.filter((entry) => typeof entry.ms === "number" && entry.ms > since) : usable;
  return wanted as Array<{ ms: number; dir: string; text: string }>;
}

/**
 * What to do about a line that has gone quiet.
 *
 * Three steps, cheapest first. A farewell followed by silence is unambiguous
 * and decided here without asking anybody. A shorter silence gets her to check
 * in — "ste tam?", "potrebujete chvíľu?" — which is what a person would do. A
 * longer one is read by a model, because a phrase list cannot tell "dobre, to
 * ešte preberiem doma" from a pause.
 *
 * Every step runs while nobody is speaking. None of it sits between a caller
 * finishing a sentence and hearing an answer.
 */
async function watchSilence(
  deps: AiDemoDeps,
  attempt: AiDemoAttempt,
  config: Extract<AiDemoConfig, { configured: true }>,
  partial: GreetingResult,
  controls: ProbeControls,
  silence: { lastJudgedAt: number; askedToCloseAt: number | null },
  limits: ProbeLimits,
): Promise<boolean> {
  const farewellSilenceMs = limits.farewellSilenceMs ?? AI_DEMO_LIMITS.farewellSilenceMs;
  const nudgeAfterMs = limits.nudgeAfterMs ?? AI_DEMO_LIMITS.nudgeAfterMs;
  const judgeAfterMs = limits.judgeAfterMs ?? AI_DEMO_LIMITS.judgeAfterMs;
  const judgeEveryMs = limits.judgeEveryMs ?? AI_DEMO_LIMITS.judgeEveryMs;
  const maxNudges = limits.maxNudges ?? AI_DEMO_LIMITS.maxNudges;
  const closingGraceMs = limits.closingGraceMs ?? AI_DEMO_LIMITS.closingGraceMs;

  const spoken = partial.transcript ?? [];
  if (spoken.length === 0) return false;

  const end = async (reason: string): Promise<boolean> => {
    deps.logger?.({ scope: "ai-demo", attemptId: attempt.id, message: "ending call", reason });
    await requestEnding(deps, attempt.id, reason, null);
    await endAttempt(deps, attempt.id, AI_DEMO_LIMITS.cleanupBudgetActionMs, "inline");
    return true;
  };

  // Asked to close a moment ago: give her the words, then end it. Without this
  // the call simply stopped, which is what "nerozlúčila sa" was.
  if (silence.askedToCloseAt !== null) {
    if (Date.now() - silence.askedToCloseAt >= closingGraceMs) return end("judged_over");
    return false;
  }

  if (config.autoHangup) {
    const lastSpeechMs = spoken[spoken.length - 1]?.ms ?? 0;
    const nowMs = Math.max(lastSpeechMs, elapsedSince(attempt));
    if (callIsOver({ turns: spoken, lastSpeechMs, nowMs, silenceMs: farewellSilenceMs })) {
      return end("farewell");
    }
  }

  if (!config.judgeSilence) return false;
  if (controls.silenceMs < nudgeAfterMs) return false;

  // A short silence does not need a model: she simply checks in, once or twice.
  if (controls.silenceMs < judgeAfterMs) {
    if (controls.saidCount < maxNudges) {
      controls.say('Volajúci chvíľu nič nepovedal. Ozvi sa krátko a prirodzene — spýtaj sa, či je tam, alebo či potrebuje chvíľu na rozmyslenie. Jedna veta, potom počúvaj.');
    }
    return false;
  }

  const now = Date.now();
  if (now - silence.lastJudgedAt < judgeEveryMs) return false;
  silence.lastJudgedAt = now;

  const verdict = await judgeCall(
    { turns: spoken, silenceMs: controls.silenceMs, nudges: controls.saidCount, maxNudges },
    { apiKey: config.apiKey, model: config.judgeModel, ...(deps.openAIFetch ? { fetch: deps.openAIFetch } : {}) },
  );
  deps.logger?.({ scope: "ai-demo", attemptId: attempt.id, message: "silence judged", action: verdict.action, reason: verdict.reason });

  if (verdict.action === "hangup" && config.autoHangup) {
    // Let her finish properly. A call that just stops is the one thing a
    // listener notices, and she has no other way to say goodbye.
    controls.say("Rozhovor sa skončil. Krátko sa rozlúč — poďakuj a popraj pekný deň. Jednou vetou, nič viac.");
    silence.askedToCloseAt = Date.now();
    return false;
  }
  if (verdict.action === "nudge" && verdict.say !== null && controls.saidCount < maxNudges) {
    controls.say(`${verdict.say} Povedz to po slovensky, jednou vetou, a potom počúvaj.`);
  }
  return false;
}

/** Milliseconds since the call was bridged. */
function elapsedSince(attempt: AiDemoAttempt): number {
  const bridged = attempt.bridged_at ? Date.parse(attempt.bridged_at) : null;
  return bridged === null ? 0 : Date.now() - bridged;
}

/** The voice actually used, from the attempt rather than from today's configuration. */
function readVoice(metadata: unknown): string | null {
  const value = (metadata as { voice?: unknown } | null)?.voice;
  return typeof value === "string" ? value : null;
}

/**
 * What the timeline and the history show; never the full target number.
 *
 * The transcript is left out unless asked for. The timeline polls every two
 * seconds and the history returns ten rows: shipping four hundred fragments of
 * speech through either of those would be a lot of bandwidth for something
 * nobody is reading yet.
 */
export function describeAttempt(attempt: AiDemoAttempt, options: { includeTranscript?: boolean; transcriptSince?: number } = {}) {
  const metadata = attempt.metadata as { latency?: Record<string, unknown> } | null;
  return {
    id: attempt.id,
    state: attempt.state,
    scenario: attempt.scenario,
    greetingStatus: attempt.greeting_status,
    endReason: attempt.end_reason,
    errorCode: attempt.error_code,
    targetMasked: maskNumber(attempt.target_number),
    fromNumber: attempt.from_number,
    voice: readVoice(attempt.metadata),
    latency: metadata?.latency ?? null,
    stats: (attempt.conversation_stats as Record<string, unknown> | null) ?? null,
    hasTranscript: Array.isArray(attempt.transcript) && attempt.transcript.length > 0,
    review: (attempt.review as Record<string, unknown> | null) ?? null,
    reviewedAt: attempt.reviewed_at,
    ...(options.includeTranscript
      ? {
          // While a call is running the tab asks every couple of seconds. Sending
          // the whole conversation back each time would be most of a minute of
          // speech repeated 150 times; a cursor makes each poll the size of
          // whatever was said since the last one.
          transcript: sliceTranscript(attempt.transcript, options.transcriptSince),
        }
      : {}),
    timestamps: {
      requestedAt: attempt.requested_at,
      sipDialedAt: attempt.sip_dialed_at,
      aiOfferedAt: attempt.ai_offered_at,
      aiAcceptedAt: attempt.ai_accepted_at,
      sipAnsweredAt: attempt.sip_answered_at,
      mobileDialedAt: attempt.mobile_dialed_at,
      mobileAnsweredAt: attempt.mobile_answered_at,
      bridgedAt: attempt.bridged_at,
      greetingAppendedAt: attempt.greeting_appended_at,
      firstTranscriptAt: attempt.first_transcript_at,
      endedAt: attempt.ended_at,
    },
  };
}

export { loadActive, loadAttempt };


/** The gate plus the sentence that tells her to ask, prepared before the call opens. */
type PreparedGate = {
  /** Null when there is something to say about the caller but no case to open — several cases, for instance. */
  gate: PlateGate | null;
  caseId: string;
  opening: string | null;
};

/**
 * Looks up the caller's case and arms the plate gate.
 *
 * Returns null whenever the feature is off, the caller is unknown or anything
 * fails. A lookup that cannot be done is not a reason to lose a call — she
 * simply does not know about any case, which is exactly how she behaved before
 * this existed.
 */
async function preparePlateGate(deps: AiDemoDeps, attempt: AiDemoAttempt): Promise<PreparedGate | null> {
  try {
    const settings = await readAgentSettings(deps);
    if (!settings.readsCallerCases) return null;

    const lookup = await lookupCallerCase(deps, attempt.target_number);
    const opening = describeBeforeVerification(lookup);
    if (lookup.outcome !== "found") return opening ? { gate: null, caseId: "", opening } : null;

    const used = await readVerificationAttempts(deps, lookup.caseFound.before.caseId, nowOf(deps));
    const gate = new PlateGate(lookup.caseFound, fullDisclosureEnabled(), used);
    return { gate, caseId: lookup.caseFound.before.caseId, opening };
  } catch (error) {
    deps.logger?.({ level: "warn", scope: "ai-demo", attemptId: attempt.id, message: "caller lookup failed", error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** Feeds the transcript to the gate and passes on whatever it decides. */
async function advanceVerification(deps: AiDemoDeps, prepared: PreparedGate | null, partial: GreetingResult, controls: ProbeControls): Promise<void> {
  if (!prepared?.gate) return;
  const outcome = prepared.gate.observe(partial.transcript);
  if (outcome.instruction) controls.say(outcome.instruction);
  if (outcome.attemptSpent || outcome.state === "verified") {
    await recordVerificationAttempts(deps, {
      caseId: prepared.caseId,
      attempts: prepared.gate.attemptsUsed,
      verified: outcome.state === "verified",
      now: nowOf(deps),
    });
  }
}
