import { resolveAppEnvironment } from "@/lib/app-environment";

import { getTestProviderSafety, type TestProviderSafety } from "./test-safety";

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
      /** Region `us`: `api.telnyx.com` (see `regionBaseUrl`). */
      apiBaseUrl: string;
      /** Region `eu` (call-speed S5): `api.telnyx.eu` (see `regionBaseUrl`). */
      euApiBaseUrl: string;
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
      testSafety?: TestProviderSafety;
    }
  | { configured: false; reason: string };

export type EnvRecord = Record<string, string | undefined>;

export const TELNYX_DEFAULT_API_BASE_URL = "https://api.telnyx.com/v2";
export const TELNYX_DEFAULT_EU_API_BASE_URL = "https://api.telnyx.eu/v2";
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

const ignoredOverrides = new Set<string>();

/**
 * Call-speed S5: each API region has its own fixed host, so the region a
 * session freezes and the telnyx-http line logs always name the host its
 * calls really use. In production `us` is api.telnyx.com and `eu`
 * api.telnyx.eu, whatever the environment says: `TELNYX_API_BASE_URL` and
 * `TELNYX_EU_API_BASE_URL` are overrides for tests and local runs, and a
 * production override is ignored and logged once per instance. An unreadable
 * application environment counts as production.
 */
function regionBaseUrl(env: EnvRecord, name: "TELNYX_API_BASE_URL" | "TELNYX_EU_API_BASE_URL", fixed: string): string {
  const override = readEnv(env, name)?.replace(/\/+$/, "");
  if (!override || override === fixed) return fixed;
  let production = true;
  try { production = resolveAppEnvironment(env) === "production"; } catch { /* fail closed */ }
  if (!production) return override;
  if (!ignoredOverrides.has(name)) {
    ignoredOverrides.add(name);
    let host: string | null = null;
    try { host = new URL(override).hostname; } catch { /* Only the hostname is ever logged. */ }
    console.error(JSON.stringify({ scope: "telnyx-config", level: "error", code: "api_base_url_override_ignored", variable: name, host, using: fixed }));
  }
  return fixed;
}

export function getTelnyxConfig(env: EnvRecord = process.env): TelnyxConfig {
  const apiKey = readEnv(env, "TELNYX_API_KEY");
  if (!apiKey) {
    return { configured: false, reason: "TELNYX_API_KEY is not set" };
  }

  return {
    configured: true,
    apiKey,
    apiBaseUrl: regionBaseUrl(env, "TELNYX_API_BASE_URL", TELNYX_DEFAULT_API_BASE_URL),
    euApiBaseUrl: regionBaseUrl(env, "TELNYX_EU_API_BASE_URL", TELNYX_DEFAULT_EU_API_BASE_URL),
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
    testSafety: getTestProviderSafety(env),
  };
}

/**
 * The Telnyx API region a call is created and controlled in (call-speed S5).
 * Telnyx processes a call or conference in the region whose API created it,
 * and a call created through `.eu` must be controlled through `.eu`, so a
 * session's region is frozen at creation (`metadata.start_mode.apiRegion`).
 */
export type TelnyxApiRegion = "us" | "eu";

/** The REST base for a region: api.telnyx.com for `us`, api.telnyx.eu for `eu` (overridable outside production). */
export function apiBaseUrlFor(config: Pick<Extract<TelnyxConfig, { configured: true }>, "apiBaseUrl" | "euApiBaseUrl">, region: TelnyxApiRegion): string {
  return region === "eu" ? config.euApiBaseUrl : config.apiBaseUrl;
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
