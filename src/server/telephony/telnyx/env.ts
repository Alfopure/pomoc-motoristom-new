/**
 * Telnyx configuration read from the environment.
 *
 * Reading never throws: a missing key yields `{ configured: false }` so that
 * the app keeps running in its "telephony not configured" mode. Live actions
 * are additionally gated by the explicit switches below and by the
 * organisation-level settings row (added in the telephony foundation migration).
 */

export type TelnyxConfig =
  | {
      configured: true;
      apiKey: string;
      apiBaseUrl: string;
      publicKey: string | null;
      callControlAppId: string | null;
      credentialConnectionId: string | null;
      outboundVoiceProfileId: string | null;
      messagingProfileId: string | null;
      smsAlphaSender: string;
      defaultFromNumber: string | null;
      mediaBaseUrl: string | null;
      liveCallsEnabled: boolean;
      smsLiveSendsEnabled: boolean;
    }
  | { configured: false; reason: string };

export type EnvRecord = Record<string, string | undefined>;

export const TELNYX_DEFAULT_API_BASE_URL = "https://api.telnyx.com/v2";
export const TELNYX_DEFAULT_ALPHA_SENDER = "PomocMotor";

function readEnv(env: EnvRecord, name: string): string | null {
  const value = env[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readFlag(env: EnvRecord, name: string): boolean {
  return readEnv(env, name)?.toLowerCase() === "true";
}

export function getTelnyxConfig(env: EnvRecord = process.env): TelnyxConfig {
  const apiKey = readEnv(env, "TELNYX_API_KEY");
  if (!apiKey) {
    return { configured: false, reason: "TELNYX_API_KEY is not set" };
  }

  return {
    configured: true,
    apiKey,
    apiBaseUrl: (readEnv(env, "TELNYX_API_BASE_URL") ?? TELNYX_DEFAULT_API_BASE_URL).replace(/\/+$/, ""),
    publicKey: readEnv(env, "TELNYX_PUBLIC_KEY"),
    callControlAppId: readEnv(env, "TELNYX_CALL_CONTROL_APP_ID"),
    credentialConnectionId: readEnv(env, "TELNYX_CREDENTIAL_CONNECTION_ID"),
    outboundVoiceProfileId: readEnv(env, "TELNYX_OUTBOUND_VOICE_PROFILE_ID"),
    messagingProfileId: readEnv(env, "TELNYX_MESSAGING_PROFILE_ID"),
    smsAlphaSender: readEnv(env, "TELNYX_SMS_ALPHA_SENDER") ?? TELNYX_DEFAULT_ALPHA_SENDER,
    defaultFromNumber: readEnv(env, "TELNYX_DEFAULT_FROM_NUMBER"),
    mediaBaseUrl: readEnv(env, "TELNYX_MEDIA_BASE_URL")?.replace(/\/+$/, "") ?? null,
    liveCallsEnabled: readFlag(env, "TELNYX_LIVE_CALLS_ENABLED"),
    smsLiveSendsEnabled: readFlag(env, "TELNYX_SMS_LIVE_SENDS"),
  };
}

/** True only when the key exists AND the corresponding live switch is on. */
export function telnyxLiveCallsAllowed(env: EnvRecord = process.env): boolean {
  const config = getTelnyxConfig(env);
  return config.configured && config.liveCallsEnabled;
}

export function telnyxSmsAllowed(env: EnvRecord = process.env): boolean {
  const config = getTelnyxConfig(env);
  return config.configured && config.smsLiveSendsEnabled;
}
