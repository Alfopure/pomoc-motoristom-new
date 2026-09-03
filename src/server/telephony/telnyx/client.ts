import "server-only";

import { TelephonyNotConfiguredError } from "@/lib/telephony/not-configured";

import { getTelnyxConfig, type TelnyxConfig } from "./env";

/**
 * Thin Telnyx REST client over `fetch`.
 *
 * Design (see `.context/telnyx-design.md` §2.1): no SDK, explicit
 * `AbortSignal` timeout (5 s), a single retry on 429 honouring `retry-after`,
 * deterministic `command_id` on every call command, and a fail-closed gate
 * for anything that creates a billable leg or sends a message. The gate is
 * computed from the environment switches AND the organisation's
 * `motorist_telephony_settings` row (`resolveTelnyxLiveGate`).
 */

export type TelnyxConfigured = Extract<TelnyxConfig, { configured: true }>;

export type TelnyxLiveGate = {
  callsEnabled: boolean;
  smsEnabled: boolean;
};

export type TelnyxSettingsSwitches = {
  live_calls_enabled: boolean;
  sms_live_sends: boolean;
};

/** Env switch AND DB switch must both be on; a missing settings row fails closed. */
export function resolveTelnyxLiveGate(config: TelnyxConfig, settings: TelnyxSettingsSwitches | null | undefined): TelnyxLiveGate {
  if (!config.configured || !settings) return { callsEnabled: false, smsEnabled: false };
  return {
    callsEnabled: config.liveCallsEnabled && settings.live_calls_enabled === true,
    smsEnabled: config.smsLiveSendsEnabled && settings.sms_live_sends === true,
  };
}

export const TELNYX_COMMAND_TIMEOUT_MS = 5_000;
export const TELNYX_MAX_RETRY_AFTER_MS = 2_000;
export const TELNYX_DEFAULT_RETRY_AFTER_MS = 500;

export const LIVE_CALLS_DISABLED_MESSAGE = "Živé hovory sú vypnuté (kill switch).";
export const SMS_SENDS_DISABLED_MESSAGE = "Odosielanie SMS je vypnuté (kill switch).";

export type TelnyxErrorCode = string;

export class TelnyxCommandError extends Error {
  readonly code: TelnyxErrorCode;
  readonly status: number;
  readonly detail: string | null;
  readonly title: string | null;
  readonly retryable: boolean;
  readonly commandId: string | null;

  constructor(input: { code: TelnyxErrorCode; status: number; detail?: string | null; title?: string | null; retryable?: boolean; commandId?: string | null; message?: string }) {
    super(input.message ?? `Telnyx ${input.code} (${input.status})${input.detail ? `: ${input.detail}` : ""}`);
    this.name = "TelnyxCommandError";
    this.code = input.code;
    this.status = input.status;
    this.detail = input.detail ?? null;
    this.title = input.title ?? null;
    this.retryable = input.retryable ?? false;
    this.commandId = input.commandId ?? null;
  }
}

export class TelnyxLiveCallsDisabledError extends TelnyxCommandError {
  constructor() {
    super({ code: "live_calls_disabled", status: 423, message: LIVE_CALLS_DISABLED_MESSAGE });
    this.name = "TelnyxLiveCallsDisabledError";
  }
}

export class TelnyxSmsDisabledError extends TelnyxCommandError {
  constructor() {
    super({ code: "sms_disabled", status: 423, message: SMS_SENDS_DISABLED_MESSAGE });
    this.name = "TelnyxSmsDisabledError";
  }
}

export type TelnyxRequestLog = {
  method: string;
  path: string;
  status: number | null;
  ms: number;
  commandId: string | null;
  retried: boolean;
  error: string | null;
};

export type TelnyxClientOptions = {
  config?: TelnyxConfig;
  liveGate: TelnyxLiveGate;
  fetch?: typeof fetch;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  maxRetryAfterMs?: number;
  onRequest?: (entry: TelnyxRequestLog) => void;
  now?: () => number;
};

// --- command parameter types ---------------------------------------------

export type CallLegRef = { callControlId: string; commandId: string };

export type DialParams = {
  commandId: string;
  to: string | string[];
  from: string;
  connectionId?: string;
  clientState?: string;
  linkTo?: string;
  timeoutSecs?: number;
  timeLimitSecs?: number;
  fromDisplayName?: string;
  sipRegion?: "Europe" | "US" | "Canada" | "Australia" | "Asia";
  mediaEncryption?: "disabled" | "SRTP" | "DTLS";
  bridgeIntent?: boolean;
  bridgeOnAnswer?: boolean;
  preventDoubleBridge?: boolean;
  parkAfterUnbridge?: "self";
  customHeaders?: Array<{ name: string; value: string }>;
  superviseCallControlId?: string;
  supervisorRole?: "barge" | "whisper" | "monitor";
  webhookUrl?: string;
  extra?: Record<string, unknown>;
};

export type DialResult = {
  callControlId: string;
  callLegId: string | null;
  callSessionId: string | null;
  isAlive: boolean;
};

export type AnswerParams = CallLegRef & { clientState?: string; customHeaders?: Array<{ name: string; value: string }>; preferredCodecs?: string; webhookUrl?: string };
export type HangupParams = CallLegRef & { clientState?: string };
export type BridgeParams = CallLegRef & {
  targetCallControlId: string;
  clientState?: string;
  playRingtone?: boolean;
  ringtone?: string;
  parkAfterUnbridge?: "self";
  holdAfterUnbridge?: "self";
  preventDoubleBridge?: boolean;
  muteDtmf?: "none" | "both" | "self" | "opposite";
};
export type TransferParams = CallLegRef & {
  to: string;
  from?: string;
  fromDisplayName?: string;
  clientState?: string;
  targetLegClientState?: string;
  timeoutSecs?: number;
  timeLimitSecs?: number;
  earlyMedia?: boolean;
  parkAfterUnbridge?: "self";
  sipRegion?: DialParams["sipRegion"];
  mediaEncryption?: DialParams["mediaEncryption"];
  customHeaders?: Array<{ name: string; value: string }>;
};
export type GatherUsingAudioParams = CallLegRef & {
  audioUrl?: string;
  mediaName?: string;
  invalidAudioUrl?: string;
  invalidMediaName?: string;
  clientState?: string;
  minimumDigits?: number;
  maximumDigits?: number;
  maximumTries?: number;
  timeoutMillis?: number;
  interDigitTimeoutMillis?: number;
  terminatingDigit?: string;
  validDigits?: string;
};
export type GatherUsingSpeakParams = CallLegRef & {
  payload: string;
  voice: string;
  language?: string;
  invalidPayload?: string;
  clientState?: string;
  minimumDigits?: number;
  maximumDigits?: number;
  maximumTries?: number;
  timeoutMillis?: number;
  interDigitTimeoutMillis?: number;
  terminatingDigit?: string;
  validDigits?: string;
};
export type SpeakParams = CallLegRef & { payload: string; voice: string; language?: string; clientState?: string; stop?: "current" | "all" };
export type PlaybackStartParams = CallLegRef & {
  audioUrl?: string;
  mediaName?: string;
  loop?: number | "infinity";
  overlay?: boolean;
  targetLegs?: "self" | "opposite" | "both";
  cacheAudio?: boolean;
  clientState?: string;
};
export type PlaybackStopParams = CallLegRef & { overlay?: boolean; stop?: "current" | "all"; clientState?: string };
export type SendDtmfParams = CallLegRef & { digits: string; durationMillis?: number; clientState?: string };

export type CreateConferenceParams = {
  commandId: string;
  callControlId: string;
  name: string;
  clientState?: string;
  startConferenceOnCreate?: boolean;
  beepEnabled?: "always" | "never" | "on_enter" | "on_exit";
  comfortNoise?: boolean;
  durationMinutes?: number;
  holdAudioUrl?: string;
  maxParticipants?: number;
};

export type ConferenceResult = { id: string; name: string | null; expiresAt: string | null };

export type ConferenceAction =
  | "join"
  | "leave"
  | "hold"
  | "unhold"
  | "mute"
  | "unmute"
  | "end"
  | "play"
  | "stop"
  | "speak"
  | "update"
  | "send_dtmf"
  | "gather_using_audio";

export type TelnyxPhoneNumber = {
  id: string;
  phoneNumber: string;
  connectionId: string | null;
  messagingProfileId: string | null;
  status: string | null;
  raw: Record<string, unknown>;
};

export type CreateTelephonyCredentialParams = { name: string; connectionId?: string; tag?: string; expiresAt?: string };

export type TelephonyCredential = { id: string; sipUsername: string | null; sipPassword: string | null; expiresAt: string | null; raw: Record<string, unknown> };

export type SendMessageParams = { to: string; text: string; from?: string; messagingProfileId?: string; webhookUrl?: string };

export type SendMessageResult = { id: string; status: string | null; raw: Record<string, unknown> };

export type TelnyxClient = {
  readonly config: TelnyxConfigured;
  readonly liveGate: TelnyxLiveGate;
  dial(params: DialParams): Promise<DialResult>;
  answer(params: AnswerParams): Promise<void>;
  hangup(params: HangupParams): Promise<void>;
  bridge(params: BridgeParams): Promise<void>;
  transfer(params: TransferParams): Promise<void>;
  gatherUsingAudio(params: GatherUsingAudioParams): Promise<void>;
  gatherUsingSpeak(params: GatherUsingSpeakParams): Promise<void>;
  speak(params: SpeakParams): Promise<void>;
  playbackStart(params: PlaybackStartParams): Promise<void>;
  playbackStop(params: PlaybackStopParams): Promise<void>;
  sendDtmf(params: SendDtmfParams): Promise<void>;
  createConference(params: CreateConferenceParams): Promise<ConferenceResult>;
  conferenceAction(conferenceId: string, action: ConferenceAction, body: Record<string, unknown> & { commandId?: string }): Promise<void>;
  listPhoneNumbers(params?: { pageSize?: number; phoneNumber?: string }): Promise<TelnyxPhoneNumber[]>;
  createTelephonyCredential(params: CreateTelephonyCredentialParams): Promise<TelephonyCredential>;
  mintCredentialToken(credentialId: string): Promise<string>;
  sendMessage(params: SendMessageParams): Promise<SendMessageResult>;
  /** Escape hatch used by later stages for endpoints not wrapped above. */
  request<T = unknown>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, options?: RequestOptions): Promise<T>;
};

export type RequestOptions = {
  body?: Record<string, unknown>;
  query?: Record<string, string | number | undefined>;
  commandId?: string;
};

// --- helpers ---------------------------------------------------------------

function compact(record: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseRetryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorFromBody(status: number, body: unknown, commandId: string | null): TelnyxCommandError {
  const record = asRecord(body);
  const errors = Array.isArray(record.errors) ? record.errors : [];
  const first = asRecord(errors[0]);
  const code = str(first.code) ?? `http_${status}`;
  return new TelnyxCommandError({
    code,
    status,
    title: str(first.title),
    detail: str(first.detail) ?? str(record.message),
    retryable: status === 429 || status >= 500,
    commandId,
  });
}

// --- client ----------------------------------------------------------------

export function createTelnyxClient(options: TelnyxClientOptions): TelnyxClient {
  const config = options.config ?? getTelnyxConfig();
  if (!config.configured) {
    throw new TelephonyNotConfiguredError();
  }
  const configured: TelnyxConfigured = config;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? TELNYX_COMMAND_TIMEOUT_MS;
  const sleep = options.sleep ?? defaultSleep;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? TELNYX_MAX_RETRY_AFTER_MS;
  const now = options.now ?? (() => Date.now());
  const liveGate = { ...options.liveGate };

  async function attempt(method: string, url: string, body: string | undefined, commandId: string | null): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, {
        method,
        headers: compact({
          authorization: `Bearer ${configured.apiKey}`,
          accept: "application/json",
          "content-type": body !== undefined ? "application/json" : undefined,
        }) as Record<string, string>,
        body,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new TelnyxCommandError({ code: "timeout", status: 504, detail: `No response within ${timeoutMs} ms`, retryable: true, commandId });
      }
      throw new TelnyxCommandError({
        code: "network",
        status: 502,
        detail: error instanceof Error ? error.message : String(error),
        retryable: true,
        commandId,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function readBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("json") || /^[\s]*[{[]/.test(text)) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return text;
  }

  async function request<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, requestOptions: RequestOptions = {}): Promise<T> {
    const commandId = requestOptions.commandId ?? null;
    const url = new URL(`${configured.apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(requestOptions.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const payload = requestOptions.body || commandId ? compact({ ...(requestOptions.body ?? {}), command_id: commandId ?? undefined }) : undefined;
    const body = payload ? JSON.stringify(payload) : undefined;

    const started = now();
    let retried = false;
    let response: Response;
    let parsed: unknown;

    try {
      response = await attempt(method, url.toString(), body, commandId);
      if (response.status === 429) {
        const retryAfter = parseRetryAfterMs(response.headers.get("retry-after"), now()) ?? TELNYX_DEFAULT_RETRY_AFTER_MS;
        await response.text().catch(() => undefined);
        await sleep(Math.min(retryAfter, maxRetryAfterMs));
        retried = true;
        response = await attempt(method, url.toString(), body, commandId);
      }
      parsed = await readBody(response);
      if (!response.ok) {
        throw errorFromBody(response.status, parsed, commandId);
      }
    } catch (error) {
      options.onRequest?.({
        method,
        path,
        status: error instanceof TelnyxCommandError ? error.status : null,
        ms: now() - started,
        commandId,
        retried,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      throw error;
    }

    options.onRequest?.({ method, path, status: response.status, ms: now() - started, commandId, retried, error: null });
    return parsed as T;
  }

  async function callAction(callControlId: string, action: string, commandId: string, body: Record<string, unknown>): Promise<void> {
    if (!callControlId) throw new TelnyxCommandError({ code: "invalid_call_control_id", status: 400, detail: `${action}: callControlId is required`, commandId });
    await request<unknown>("POST", `/calls/${encodeURIComponent(callControlId)}/actions/${action}`, { body: compact(body), commandId });
  }

  function assertCallsAllowed(): void {
    if (!liveGate.callsEnabled) throw new TelnyxLiveCallsDisabledError();
  }

  function headers(customHeaders?: Array<{ name: string; value: string }>) {
    return customHeaders && customHeaders.length > 0 ? customHeaders : undefined;
  }

  const client: TelnyxClient = {
    config: configured,
    liveGate,
    request,

    async dial(params) {
      assertCallsAllowed();
      const connectionId = params.connectionId ?? configured.callControlAppId;
      if (!connectionId) {
        throw new TelnyxCommandError({ code: "missing_connection_id", status: 400, detail: "TELNYX_CALL_CONTROL_APP_ID is not set", commandId: params.commandId });
      }
      const response = await request<unknown>("POST", "/calls", {
        commandId: params.commandId,
        body: compact({
          to: params.to,
          from: params.from,
          connection_id: connectionId,
          client_state: params.clientState,
          link_to: params.linkTo,
          timeout_secs: params.timeoutSecs,
          time_limit_secs: params.timeLimitSecs,
          from_display_name: params.fromDisplayName,
          sip_region: params.sipRegion,
          media_encryption: params.mediaEncryption,
          bridge_intent: params.bridgeIntent,
          bridge_on_answer: params.bridgeOnAnswer,
          prevent_double_bridge: params.preventDoubleBridge,
          park_after_unbridge: params.parkAfterUnbridge,
          custom_headers: headers(params.customHeaders),
          supervise_call_control_id: params.superviseCallControlId,
          supervisor_role: params.supervisorRole,
          webhook_url: params.webhookUrl,
          ...(params.extra ?? {}),
        }),
      });
      const data = asRecord(asRecord(response).data);
      const callControlId = str(data.call_control_id);
      if (!callControlId) {
        throw new TelnyxCommandError({ code: "invalid_response", status: 502, detail: "dial response has no call_control_id", commandId: params.commandId });
      }
      return {
        callControlId,
        callLegId: str(data.call_leg_id),
        callSessionId: str(data.call_session_id),
        isAlive: data.is_alive === true,
      };
    },

    answer(params) {
      return callAction(params.callControlId, "answer", params.commandId, {
        client_state: params.clientState,
        custom_headers: headers(params.customHeaders),
        preferred_codecs: params.preferredCodecs,
        webhook_url: params.webhookUrl,
      });
    },

    hangup(params) {
      return callAction(params.callControlId, "hangup", params.commandId, { client_state: params.clientState });
    },

    bridge(params) {
      return callAction(params.callControlId, "bridge", params.commandId, {
        call_control_id: params.targetCallControlId,
        client_state: params.clientState,
        play_ringtone: params.playRingtone,
        ringtone: params.ringtone,
        park_after_unbridge: params.parkAfterUnbridge,
        hold_after_unbridge: params.holdAfterUnbridge,
        prevent_double_bridge: params.preventDoubleBridge,
        mute_dtmf: params.muteDtmf,
      });
    },

    async transfer(params) {
      assertCallsAllowed();
      await callAction(params.callControlId, "transfer", params.commandId, {
        to: params.to,
        from: params.from,
        from_display_name: params.fromDisplayName,
        client_state: params.clientState,
        target_leg_client_state: params.targetLegClientState,
        timeout_secs: params.timeoutSecs,
        time_limit_secs: params.timeLimitSecs,
        early_media: params.earlyMedia,
        park_after_unbridge: params.parkAfterUnbridge,
        sip_region: params.sipRegion,
        media_encryption: params.mediaEncryption,
        custom_headers: headers(params.customHeaders),
      });
    },

    gatherUsingAudio(params) {
      return callAction(params.callControlId, "gather_using_audio", params.commandId, {
        audio_url: params.audioUrl,
        media_name: params.mediaName,
        invalid_audio_url: params.invalidAudioUrl,
        invalid_media_name: params.invalidMediaName,
        client_state: params.clientState,
        minimum_digits: params.minimumDigits,
        maximum_digits: params.maximumDigits,
        maximum_tries: params.maximumTries,
        timeout_millis: params.timeoutMillis,
        inter_digit_timeout_millis: params.interDigitTimeoutMillis,
        terminating_digit: params.terminatingDigit,
        valid_digits: params.validDigits,
      });
    },

    gatherUsingSpeak(params) {
      return callAction(params.callControlId, "gather_using_speak", params.commandId, {
        payload: params.payload,
        voice: params.voice,
        language: params.language,
        invalid_payload: params.invalidPayload,
        client_state: params.clientState,
        minimum_digits: params.minimumDigits,
        maximum_digits: params.maximumDigits,
        maximum_tries: params.maximumTries,
        timeout_millis: params.timeoutMillis,
        inter_digit_timeout_millis: params.interDigitTimeoutMillis,
        terminating_digit: params.terminatingDigit,
        valid_digits: params.validDigits,
      });
    },

    speak(params) {
      return callAction(params.callControlId, "speak", params.commandId, {
        payload: params.payload,
        voice: params.voice,
        language: params.language,
        client_state: params.clientState,
        stop: params.stop,
      });
    },

    playbackStart(params) {
      return callAction(params.callControlId, "playback_start", params.commandId, {
        audio_url: params.audioUrl,
        media_name: params.mediaName,
        loop: params.loop,
        overlay: params.overlay,
        target_legs: params.targetLegs,
        cache_audio: params.cacheAudio,
        client_state: params.clientState,
      });
    },

    playbackStop(params) {
      return callAction(params.callControlId, "playback_stop", params.commandId, {
        overlay: params.overlay,
        stop: params.stop,
        client_state: params.clientState,
      });
    },

    sendDtmf(params) {
      return callAction(params.callControlId, "send_dtmf", params.commandId, {
        digits: params.digits,
        duration_millis: params.durationMillis,
        client_state: params.clientState,
      });
    },

    async createConference(params) {
      const response = await request<unknown>("POST", "/conferences", {
        commandId: params.commandId,
        body: compact({
          call_control_id: params.callControlId,
          name: params.name,
          client_state: params.clientState,
          start_conference_on_create: params.startConferenceOnCreate,
          beep_enabled: params.beepEnabled,
          comfort_noise: params.comfortNoise,
          duration_minutes: params.durationMinutes,
          hold_audio_url: params.holdAudioUrl,
          max_participants: params.maxParticipants,
        }),
      });
      const data = asRecord(asRecord(response).data);
      const id = str(data.id);
      if (!id) {
        throw new TelnyxCommandError({ code: "invalid_response", status: 502, detail: "conference response has no id", commandId: params.commandId });
      }
      return { id, name: str(data.name), expiresAt: str(data.expires_at) };
    },

    async conferenceAction(conferenceId, action, body) {
      if (!conferenceId) throw new TelnyxCommandError({ code: "invalid_conference_id", status: 400, detail: `${action}: conferenceId is required` });
      const { commandId, ...rest } = body;
      await request<unknown>("POST", `/conferences/${encodeURIComponent(conferenceId)}/actions/${action}`, { body: compact(rest), commandId });
    },

    async listPhoneNumbers(params = {}) {
      const response = await request<unknown>("GET", "/phone_numbers", {
        query: compact({ "page[size]": params.pageSize ?? 100, "filter[phone_number]": params.phoneNumber }) as Record<string, string | number>,
      });
      const data = asRecord(response).data;
      return (Array.isArray(data) ? data : []).map((entry) => {
        const raw = asRecord(entry);
        return {
          id: str(raw.id) ?? "",
          phoneNumber: str(raw.phone_number) ?? "",
          connectionId: str(raw.connection_id),
          messagingProfileId: str(raw.messaging_profile_id),
          status: str(raw.status),
          raw,
        };
      });
    },

    async createTelephonyCredential(params) {
      const connectionId = params.connectionId ?? configured.credentialConnectionId;
      if (!connectionId) {
        throw new TelnyxCommandError({ code: "missing_connection_id", status: 400, detail: "TELNYX_CREDENTIAL_CONNECTION_ID is not set" });
      }
      const response = await request<unknown>("POST", "/telephony_credentials", {
        body: compact({ connection_id: connectionId, name: params.name, tag: params.tag, expires_at: params.expiresAt }),
      });
      const raw = asRecord(asRecord(response).data);
      const id = str(raw.id);
      if (!id) throw new TelnyxCommandError({ code: "invalid_response", status: 502, detail: "credential response has no id" });
      return { id, sipUsername: str(raw.sip_username), sipPassword: str(raw.sip_password), expiresAt: str(raw.expires_at), raw };
    },

    async mintCredentialToken(credentialId) {
      if (!credentialId) throw new TelnyxCommandError({ code: "invalid_credential_id", status: 400, detail: "credentialId is required" });
      const response = await request<unknown>("POST", `/telephony_credentials/${encodeURIComponent(credentialId)}/token`);
      // Telnyx returns the JWT as a plain-text body; tolerate a JSON envelope too.
      const token = typeof response === "string" ? response.trim() : str(asRecord(response).token) ?? str(asRecord(asRecord(response).data).token);
      if (!token) throw new TelnyxCommandError({ code: "invalid_response", status: 502, detail: "token response is empty" });
      return token;
    },

    async sendMessage(params) {
      if (!liveGate.smsEnabled) throw new TelnyxSmsDisabledError();
      const messagingProfileId = params.messagingProfileId ?? configured.messagingProfileId ?? undefined;
      const response = await request<unknown>("POST", "/messages", {
        body: compact({
          from: params.from ?? configured.smsAlphaSender,
          to: params.to,
          text: params.text,
          messaging_profile_id: messagingProfileId,
          webhook_url: params.webhookUrl,
        }),
      });
      const raw = asRecord(asRecord(response).data);
      const id = str(raw.id);
      if (!id) throw new TelnyxCommandError({ code: "invalid_response", status: 502, detail: "message response has no id" });
      const to = Array.isArray(raw.to) ? asRecord(raw.to[0]) : {};
      return { id, status: str(to.status), raw };
    },
  };

  return client;
}
