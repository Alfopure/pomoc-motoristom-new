import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { TELEPHONY_NOT_CONFIGURED_MESSAGE } from "@/lib/telephony/not-configured";

import { isDeviceLive } from "./routing/eligibility";
import { telnyxSipUri, toJson, type DeviceRow, type TelephonyEnvironment } from "./state/types";
import { TelnyxCommandError, type TelnyxClient } from "./telnyx/client";

/**
 * Operator browser-phone devices (`motorist_operator_devices`, one row per
 * operator and environment).
 *
 * - `ensureOperatorCredential` lazily creates the Telnyx telephony credential
 *   on this environment's credential connection (SIP password is never stored
 *   or shipped; the browser logs in with a short-lived JWT).
 * - `issueWebphoneToken` mints the JWT, decodes its `exp`, rotates
 *   `device_session_id` on takeover (the previous tab's next heartbeat gets
 *   409), preserves it on renewal and records the issue time.
 * - `touchDevice` is the heartbeat; it only accepts the current session id.
 */

type AdminClient = SupabaseClient<Database>;

export type DeviceDeps = {
  admin: AdminClient;
  telnyx: TelnyxClient | null;
  environment: TelephonyEnvironment;
  now?: () => Date;
  /** Mobile credentials are used only for explicitly requested app calls. */
  deviceKind?: "web" | "mobile";
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

function deviceTable(deps: DeviceDeps) {
  return deps.deviceKind === "mobile" ? "motorist_operator_mobile_devices" as const : "motorist_operator_devices" as const;
}

function nowOf(deps: DeviceDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

export function credentialName(environment: TelephonyEnvironment, profileId: string): string {
  return `${CREDENTIAL_NAME_PREFIX}-${environment === "production" ? "prod" : "dev"}-${profileId.replace(/-/g, "").slice(0, 12)}`;
}

export async function getOperatorDevice(deps: DeviceDeps, input: { organizationId: string; profileId: string }): Promise<DeviceRow | null> {
  const { data, error } = await deps.admin
    .from(deviceTable(deps))
    .select("*")
    .eq("organization_id", input.organizationId)
    .eq("profile_id", input.profileId)
    .eq("environment", deps.environment)
    .maybeSingle();
  if (error) throw new OperatorDeviceError(`Zariadenie sa nepodarilo načítať: ${error.message}`, 500);
  return data;
}

export async function listOperatorDevices(deps: DeviceDeps, organizationId: string): Promise<DeviceRow[]> {
  const { data, error } = await deps.admin.from(deviceTable(deps)).select("*").eq("organization_id", organizationId).eq("environment", deps.environment);
  if (error) throw new OperatorDeviceError(`Zariadenia sa nepodarilo načítať: ${error.message}`, 500);
  return data ?? [];
}

function credentialUsable(device: DeviceRow, now: Date): boolean {
  if (!device.telnyx_credential_id || !device.sip_username) return false;
  if (!device.credential_expires_at) return true;
  const expires = Date.parse(device.credential_expires_at);
  return Number.isNaN(expires) || expires - now.getTime() > CREDENTIAL_RENEW_WINDOW_MS;
}

export async function ensureOperatorCredential(deps: DeviceDeps, input: { organizationId: string; profileId: string; force?: boolean }): Promise<DeviceRow> {
  const now = nowOf(deps);
  const existing = await getOperatorDevice(deps, input);
  // `force` is the manager pressing "regenerate": mint a new credential even
  // when the stored one is still usable (Phase 3 OperatorsTelephonyPanel).
  if (existing && !input.force && credentialUsable(existing, now)) return existing;
  if (!deps.telnyx) throw new OperatorDeviceError(TELEPHONY_NOT_CONFIGURED_MESSAGE, 503);

  const credential = await deps.telnyx.createTelephonyCredential({
    name: credentialName(deps.environment, input.profileId) + (deps.deviceKind === "mobile" ? "-mobile" : ""),
    tag: CREDENTIAL_TAG,
    connectionId: deps.credentialConnectionId ?? undefined,
  });
  if (!credential.sipUsername) {
    await deleteCredentialAtProvider(deps, credential.id, "Neúplné prihlasovacie údaje sa nepodarilo zrušiť u operátora");
    throw new OperatorDeviceError("Telnyx nevrátil SIP používateľa pre nové prihlasovacie údaje.", 502);
  }

  const previousCredentialId = existing?.telnyx_credential_id ?? null;
  const values = {
    organization_id: input.organizationId,
    profile_id: input.profileId,
    environment: deps.environment,
    telnyx_credential_id: credential.id,
    sip_username: credential.sipUsername,
    credential_expires_at: credential.expiresAt,
    registration_state: "unregistered" as const,
    metadata: toJson({ ...(existing ? metadataOf(existing) : {}), credential_created_at: now.toISOString(), previous_credential_id: previousCredentialId }),
  };
  // Enrollment can race across requests. An upsert would overwrite the first
  // credential and leave an untracked SIP identity active at the provider.
  // Inserts use the org/profile/environment unique key; renewal only replaces
  // the credential we read. A losing request revokes its own mint and reuses
  // the winner, never the other way around.
  let saved;
  if (existing) {
    let update = deps.admin.from(deviceTable(deps)).update(values).eq("id", existing.id);
    update = previousCredentialId === null
      ? update.is("telnyx_credential_id", null)
      : update.eq("telnyx_credential_id", previousCredentialId);
    saved = await update.select("*").maybeSingle();
  } else {
    saved = await deps.admin.from(deviceTable(deps)).insert(values).select("*").maybeSingle();
  }
  if (saved.error || !saved.data) {
    await deleteCredentialAtProvider(deps, credential.id, "Nepoužité prihlasovacie údaje sa nepodarilo zrušiť u operátora");
    if (!saved.error || saved.error.code === "23505") {
      const winner = await getOperatorDevice(deps, input);
      if (winner && credentialUsable(winner, now)) return winner;
    }
    if (saved.error) throw new OperatorDeviceError(`Zariadenie sa nepodarilo uložiť: ${saved.error.message}`, 500);
    throw new OperatorDeviceError("Pripojenie zariadenia sa medzitým zmenilo. Skúste to znova.", 409);
  }
  // The superseded credential has to die at Telnyx: it can still register and
  // the JWT minted from it stays valid for up to 24 h, so keeping it would make
  // "new credentials" a rename rather than a revocation.
  if (previousCredentialId && previousCredentialId !== credential.id) {
    await deleteCredentialAtProvider(deps, previousCredentialId, "Staré prihlasovacie údaje sa nepodarilo zrušiť u operátora");
  }
  return saved.data;
}

/**
 * Deletes a telephony credential at Telnyx.
 *
 * A failure is a 502, never a silent pass: the manager has to know that the old
 * SIP identity is still able to register and place billable calls. A `404` is
 * the one exception — the credential is already gone, so access *is* revoked;
 * treating it as a failure would brick the ordinary renewal path
 * (`credentialUsable` false → mint a new one → delete a credential Telnyx
 * expired or somebody removed in the portal) and leave the operator without a
 * phone.
 */
async function deleteCredentialAtProvider(deps: DeviceDeps, credentialId: string, context: string): Promise<void> {
  if (!deps.telnyx) throw new OperatorDeviceError(`${context}: ${TELEPHONY_NOT_CONFIGURED_MESSAGE}`, 503);
  try {
    await deps.telnyx.deleteTelephonyCredential(credentialId);
  } catch (error) {
    if (error instanceof TelnyxCommandError && error.status === 404) return;
    const detail = error instanceof Error ? error.message : String(error);
    throw new OperatorDeviceError(`${context} (${credentialId}): ${detail}. Prístup zatiaľ nie je odobratý.`, 502);
  }
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

export const TOKEN_TAKEOVER_MESSAGE = "Telefón je prihlásený v inom okne alebo zariadení. Ak chceš prijímať hovory tu, prevezmi telefón.";

export async function issueWebphoneToken(
  deps: DeviceDeps,
  input: { organizationId: string; profileId: string; userAgent?: string | null; takeover?: boolean; handoff?: boolean; deviceSessionId?: string | null },
): Promise<WebphoneToken> {
  if (!deps.telnyx) throw new OperatorDeviceError(TELEPHONY_NOT_CONFIGURED_MESSAGE, 503);
  if (input.takeover) {
    const presence = await deps.admin.from("motorist_operator_presence").select("status")
      .eq("organization_id", input.organizationId).eq("profile_id", input.profileId).maybeSingle();
    if (presence.error) throw new OperatorDeviceError("Stav operátora sa nepodarilo overiť.", 503);
    if (presence.data?.status === "on_call") throw new OperatorDeviceError("Prebiehajúci hovor nemožno presunúť pripojením iného prehliadača. Najprv ho dokončite.", 409);
  }
  // Opening the dispatch on a second device must not silently steal incoming
  // calls from a live phone, even between calls. Own-token renewal is allowed.
  if (!input.takeover) {
    const current = await getOperatorDevice(deps, input);
    const sameTab = Boolean(input.deviceSessionId && current?.device_session_id === input.deviceSessionId);
    if (current && !sameTab && deviceIsLive(current, nowOf(deps))) throw new OperatorDeviceError(TOKEN_TAKEOVER_MESSAGE, 409);
  }
  const device = await ensureOperatorCredential(deps, input);
  const sameTab = Boolean(input.deviceSessionId && device.device_session_id === input.deviceSessionId);
  if (!input.takeover && !sameTab && deviceIsLive(device, nowOf(deps))) throw new OperatorDeviceError(TOKEN_TAKEOVER_MESSAGE, 409);
  const credentialId = device.telnyx_credential_id;
  const sipUsername = device.sip_username;
  if (!credentialId || !sipUsername) throw new OperatorDeviceError("Zariadenie nemá prihlasovacie údaje.", 500);

  const now = nowOf(deps);
  const token = await deps.telnyx.mintCredentialToken(credentialId);
  const expiresAt = decodeJwtExpiry(token) ?? new Date(now.getTime() + DEFAULT_TOKEN_TTL_MS);
  // A heartbeat already in flight must remain valid across this tab's renewal.
  const renewing = sameTab && !input.handoff;
  const deviceSessionId = renewing ? device.device_session_id! : randomUUID();
  const metadata = metadataOf(device);
  const revoked = Array.isArray(metadata.revoked_sessions) ? (metadata.revoked_sessions as unknown[]).slice(-9) : [];
  if (!renewing && device.device_session_id) revoked.push({ id: device.device_session_id, revoked_at: now.toISOString() });

  // A refresh for a phone that is already registered and still sending
  // heartbeats must not report it as registering: the ring engine skips any
  // operator who is not "registered", so downgrading here made the operator
  // invisible until the next heartbeat and inbound calls silently walked past
  // them. Only a genuinely new or stale registration starts as "registering".
  const stillLive = renewing && deviceIsLive(device, now);

  let update = deps.admin
    .from(deviceTable(deps))
    .update({
      last_token_issued_at: now.toISOString(),
      token_expires_at: expiresAt.toISOString(),
      device_session_id: deviceSessionId,
      registration_state: stillLive ? "registered" : "registering",
      ...(!renewing ? { device_seen_at: null } : {}),
      user_agent: input.userAgent ?? device.user_agent,
      metadata: toJson({ ...metadata, revoked_sessions: revoked }),
    })
    .eq("id", device.id);
  // A slow token response cannot overwrite a newer takeover or revocation.
  update = device.device_session_id === null
    ? update.is("device_session_id", null)
    : update.eq("device_session_id", device.device_session_id);
  const updated = await update.select("id").maybeSingle();
  if (updated.error) throw new OperatorDeviceError(`Zariadenie sa nepodarilo aktualizovať: ${updated.error.message}`, 500);
  if (!updated.data) throw new OperatorDeviceError(TOKEN_TAKEOVER_MESSAGE, 409);

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
  // An `unregistered` report is the tab saying goodbye (pagehide): clear the
  // liveness stamp instead of refreshing it, or the ring plan keeps allocating
  // steps to a phone that is gone.
  const leaving = input.registrationState === "unregistered";
  const values: Database["public"]["Tables"]["motorist_operator_devices"]["Update"] = { device_seen_at: leaving ? null : now };
  if (input.registrationState) values.registration_state = input.registrationState;
  if (input.userAgent) values.user_agent = input.userAgent;
  const updated = await deps.admin.from(deviceTable(deps)).update(values).eq("id", device.id).eq("device_session_id", input.deviceSessionId).select("*").maybeSingle();
  if (updated.error) throw new OperatorDeviceError(`Heartbeat sa nepodarilo uložiť: ${updated.error.message}`, 500);
  if (!updated.data) return { ok: false, reason: "stale_session" };
  return { ok: true, device: updated.data };
}

/** Revokes the browser session id only (the tab's next heartbeat gets 409). */
async function revokeDeviceSession(deps: DeviceDeps, device: DeviceRow): Promise<DeviceRow> {
  const updated = await deps.admin
    .from(deviceTable(deps))
    .update({ device_session_id: `revoked:${randomUUID()}`, registration_state: "unregistered", device_seen_at: null })
    .eq("id", device.id)
    .select("*")
    .single();
  if (updated.error) throw new OperatorDeviceError(`Zariadenie sa nepodarilo odpojiť: ${updated.error.message}`, 500);
  return updated.data;
}

export type DisconnectResult = { device: DeviceRow; deletedCredentialId: string | null };

/**
 * Forces the operator's browser phone off — for good.
 *
 * Revoking `device_session_id` alone is cooperative: a tab that never sends the
 * heartbeat (offline, paused in devtools) keeps its registration, and the JWT it
 * already holds stays valid for up to `DEFAULT_TOKEN_TTL_MS`. Offboarding
 * therefore also deletes the telephony credential at Telnyx and clears the SIP
 * identity from the row, so no stale token can re-register.
 *
 * `keepCredential` is the rotate path: `ensureOperatorCredential({ force })` has
 * already deleted the *previous* credential and minted a new one, which must
 * survive.
 */
export async function disconnectDevice(
  deps: DeviceDeps,
  input: { organizationId: string; profileId: string; keepCredential?: boolean },
): Promise<DisconnectResult | null> {
  if (!deps.deviceKind && !input.keepCredential) {
    const web = await disconnectDevice({ ...deps, deviceKind: "web" }, input);
    const mobile = await disconnectDevice({ ...deps, deviceKind: "mobile" }, input);
    return web ?? mobile;
  }
  const device = await getOperatorDevice(deps, input);
  if (!device) return null;
  const revoked = await revokeDeviceSession(deps, device);
  if (input.keepCredential || !revoked.telnyx_credential_id) return { device: revoked, deletedCredentialId: null };

  const credentialId = revoked.telnyx_credential_id;
  await deleteCredentialAtProvider(deps, credentialId, "Telefón sme odhlásili, ale prihlasovacie údaje sa nepodarilo zrušiť u operátora");
  const cleared = await deps.admin
    .from(deviceTable(deps))
    .update({
      telnyx_credential_id: null,
      sip_username: null,
      credential_expires_at: null,
      token_expires_at: null,
      metadata: toJson({ ...metadataOf(revoked), deleted_credential_id: credentialId, deleted_credential_at: nowOf(deps).toISOString() }),
    })
    .eq("id", revoked.id)
    .select("*")
    .single();
  if (cleared.error) throw new OperatorDeviceError(`Zariadenie sa nepodarilo odpojiť: ${cleared.error.message}`, 500);
  return { device: cleared.data, deletedCredentialId: credentialId };
}

export function deviceIsLive(device: DeviceRow | null, now: Date): boolean {
  if (!device) return false;
  return isDeviceLive({ deviceSeenAt: device.device_seen_at, registrationState: device.registration_state }, now);
}

export function deviceSipUri(device: DeviceRow): string | null {
  return device.sip_username ? telnyxSipUri(device.sip_username) : null;
}
