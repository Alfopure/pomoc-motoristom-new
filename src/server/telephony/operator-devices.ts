import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { TELEPHONY_NOT_CONFIGURED_MESSAGE } from "@/lib/telephony/not-configured";

import { isDeviceLive } from "./routing/eligibility";
import { telnyxSipUri, toJson, type DeviceRow, type TelephonyEnvironment } from "./state/types";
import type { TelnyxClient } from "./telnyx/client";

/**
 * Operator browser-phone devices (`motorist_operator_devices`, one row per
 * operator and environment).
 *
 * - `ensureOperatorCredential` lazily creates the Telnyx telephony credential
 *   on this environment's credential connection (SIP password is never stored
 *   or shipped; the browser logs in with a short-lived JWT).
 * - `issueWebphoneToken` mints the JWT, decodes its `exp`, rotates
 *   `device_session_id` (the previous tab is revoked: its next heartbeat gets
 *   409) and records the issue time.
 * - `touchDevice` is the heartbeat; it only accepts the current session id.
 */

type AdminClient = SupabaseClient<Database>;

export type DeviceDeps = {
  admin: AdminClient;
  telnyx: TelnyxClient | null;
  environment: TelephonyEnvironment;
  now?: () => Date;
  /** Override the credential connection (defaults to the client's configured one). */
  credentialConnectionId?: string | null;
};

export class OperatorDeviceError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message);
    this.name = "OperatorDeviceError";
  }
}

export const CREDENTIAL_NAME_PREFIX = "pm";
export const CREDENTIAL_TAG = "pomoc-motoristom";
/** Refresh the credential when it expires within this window. */
const CREDENTIAL_RENEW_WINDOW_MS = 24 * 60 * 60 * 1000;

function nowOf(deps: DeviceDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

export function credentialName(environment: TelephonyEnvironment, profileId: string): string {
  return `${CREDENTIAL_NAME_PREFIX}-${environment === "production" ? "prod" : "dev"}-${profileId.replace(/-/g, "").slice(0, 12)}`;
}

export async function getOperatorDevice(deps: DeviceDeps, input: { organizationId: string; profileId: string }): Promise<DeviceRow | null> {
  const { data, error } = await deps.admin
    .from("motorist_operator_devices")
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("profile_id", input.profileId)
    .eq("environment", deps.environment)
    .maybeSingle();
  if (error) throw new OperatorDeviceError(`Zariadenie sa nepodarilo načítať: ${error.message}`, 500);
  return data;
}

export async function listOperatorDevices(deps: DeviceDeps, organizationId: string): Promise<DeviceRow[]> {
  const { data, error } = await deps.admin.from("motorist_operator_devices").select("*").eq("organization_id", organizationId).eq("environment", deps.environment);
  if (error) throw new OperatorDeviceError(`Zariadenia sa nepodarilo načítať: ${error.message}`, 500);
  return data ?? [];
}

function credentialUsable(device: DeviceRow, now: Date): boolean {
  if (!device.telnyx_credential_id || !device.sip_username) return false;
  if (!device.credential_expires_at) return true;
  const expires = Date.parse(device.credential_expires_at);
  return Number.isNaN(expires) || expires - now.getTime() > CREDENTIAL_RENEW_WINDOW_MS;
}

export async function ensureOperatorCredential(deps: DeviceDeps, input: { organizationId: string; profileId: string }): Promise<DeviceRow> {
  const now = nowOf(deps);
  const existing = await getOperatorDevice(deps, input);
  if (existing && credentialUsable(existing, now)) return existing;
  if (!deps.telnyx) throw new OperatorDeviceError(TELEPHONY_NOT_CONFIGURED_MESSAGE, 503);

  const credential = await deps.telnyx.createTelephonyCredential({
    name: credentialName(deps.environment, input.profileId),
    tag: CREDENTIAL_TAG,
    connectionId: deps.credentialConnectionId ?? undefined,
  });
  if (!credential.sipUsername) throw new OperatorDeviceError("Telnyx nevrátil SIP používateľa pre nové prihlasovacie údaje.", 502);

  const values = {
    organization_id: input.organizationId,
    profile_id: input.profileId,
    environment: deps.environment,
    telnyx_credential_id: credential.id,
    sip_username: credential.sipUsername,
    credential_expires_at: credential.expiresAt,
    registration_state: "unregistered" as const,
    metadata: toJson({ ...(existing ? metadataOf(existing) : {}), credential_created_at: now.toISOString(), previous_credential_id: existing?.telnyx_credential_id ?? null }),
  };
  const upserted = await deps.admin.from("motorist_operator_devices").upsert(values, { onConflict: "profile_id,environment" }).select("*").single();
  if (upserted.error) throw new OperatorDeviceError(`Zariadenie sa nepodarilo uložiť: ${upserted.error.message}`, 500);
  return upserted.data;
}

function metadataOf(device: DeviceRow): Record<string, unknown> {
  return device.metadata && typeof device.metadata === "object" && !Array.isArray(device.metadata) ? (device.metadata as Record<string, unknown>) : {};
}

/** Reads `exp` from a JWT without verifying it (the token is Telnyx's, we only schedule its refresh). */
export function decodeJwtExpiry(token: string): Date | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as Record<string, unknown>;
    const exp = typeof payload.exp === "number" ? payload.exp : Number(payload.exp);
    if (!Number.isFinite(exp) || exp <= 0) return null;
    return new Date(exp * 1000);
  } catch {
    return null;
  }
}

export type WebphoneToken = {
  token: string;
  expiresAt: string;
  deviceSessionId: string;
  sipUsername: string;
  credentialId: string;
};

const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export async function issueWebphoneToken(deps: DeviceDeps, input: { organizationId: string; profileId: string; userAgent?: string | null }): Promise<WebphoneToken> {
  if (!deps.telnyx) throw new OperatorDeviceError(TELEPHONY_NOT_CONFIGURED_MESSAGE, 503);
  const device = await ensureOperatorCredential(deps, input);
  const credentialId = device.telnyx_credential_id;
  const sipUsername = device.sip_username;
  if (!credentialId || !sipUsername) throw new OperatorDeviceError("Zariadenie nemá prihlasovacie údaje.", 500);

  const now = nowOf(deps);
  const token = await deps.telnyx.mintCredentialToken(credentialId);
  const expiresAt = decodeJwtExpiry(token) ?? new Date(now.getTime() + DEFAULT_TOKEN_TTL_MS);
  const deviceSessionId = randomUUID();
  const metadata = metadataOf(device);
  const revoked = Array.isArray(metadata.revoked_sessions) ? (metadata.revoked_sessions as unknown[]).slice(-9) : [];
  if (device.device_session_id) revoked.push({ id: device.device_session_id, revoked_at: now.toISOString() });

  const updated = await deps.admin
    .from("motorist_operator_devices")
    .update({
      last_token_issued_at: now.toISOString(),
      token_expires_at: expiresAt.toISOString(),
      device_session_id: deviceSessionId,
      registration_state: "registering",
      user_agent: input.userAgent ?? device.user_agent,
      metadata: toJson({ ...metadata, revoked_sessions: revoked }),
    })
    .eq("id", device.id)
    .select("id")
    .single();
  if (updated.error) throw new OperatorDeviceError(`Zariadenie sa nepodarilo aktualizovať: ${updated.error.message}`, 500);

  return { token, expiresAt: expiresAt.toISOString(), deviceSessionId, sipUsername, credentialId };
}

export type TouchDeviceResult = { ok: true; device: DeviceRow } | { ok: false; reason: "unknown_device" | "stale_session" };

export async function touchDevice(
  deps: DeviceDeps,
  input: { organizationId: string; profileId: string; deviceSessionId: string; registrationState?: DeviceRow["registration_state"]; userAgent?: string | null },
): Promise<TouchDeviceResult> {
  const device = await getOperatorDevice(deps, input);
  if (!device) return { ok: false, reason: "unknown_device" };
  if (!input.deviceSessionId || device.device_session_id !== input.deviceSessionId) return { ok: false, reason: "stale_session" };
  const now = nowOf(deps).toISOString();
  const values: Database["public"]["Tables"]["motorist_operator_devices"]["Update"] = { device_seen_at: now };
  if (input.registrationState) values.registration_state = input.registrationState;
  if (input.userAgent) values.user_agent = input.userAgent;
  const updated = await deps.admin.from("motorist_operator_devices").update(values).eq("id", device.id).eq("device_session_id", input.deviceSessionId).select("*").maybeSingle();
  if (updated.error) throw new OperatorDeviceError(`Heartbeat sa nepodarilo uložiť: ${updated.error.message}`, 500);
  if (!updated.data) return { ok: false, reason: "stale_session" };
  return { ok: true, device: updated.data };
}

/** Forces the current browser off (its next heartbeat gets 409). */
export async function disconnectDevice(deps: DeviceDeps, input: { organizationId: string; profileId: string }): Promise<DeviceRow | null> {
  const device = await getOperatorDevice(deps, input);
  if (!device) return null;
  const updated = await deps.admin
    .from("motorist_operator_devices")
    .update({ device_session_id: `revoked:${randomUUID()}`, registration_state: "unregistered", device_seen_at: null })
    .eq("id", device.id)
    .select("*")
    .single();
  if (updated.error) throw new OperatorDeviceError(`Zariadenie sa nepodarilo odpojiť: ${updated.error.message}`, 500);
  return updated.data;
}

export function deviceIsLive(device: DeviceRow | null, now: Date): boolean {
  if (!device) return false;
  return isDeviceLive({ profileId: device.profile_id, deviceSeenAt: device.device_seen_at, registrationState: device.registration_state, sipUsername: device.sip_username }, now);
}

export function deviceSipUri(device: DeviceRow): string | null {
  return device.sip_username ? telnyxSipUri(device.sip_username) : null;
}
