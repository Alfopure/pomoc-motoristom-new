import { randomUUID } from "node:crypto";
import { recordServerDiagnostic } from "@/server/diagnostics/record";
import { isDiagnosticUuid, type DiagnosticReason } from "@/lib/diagnostics/types";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";
import { TELEPHONY_NOT_CONFIGURED_MESSAGE } from "@/lib/telephony/not-configured";

import { isDeviceLive } from "./routing/eligibility";
import { deviceLastOnlineAt, LAST_ONLINE_METADATA_KEY, retainDeviceLastOnline } from "./device-online";
import { OperatorDeviceError } from "./service-errors";
import { telnyxSipUri, toJson, type DeviceRow, type TelephonyEnvironment } from "./state/types";
import { TelnyxCommandError, type TelnyxClient } from "./telnyx/client";
import { MOBILE_TOKEN_CACHE_MARGIN_MS, MOBILE_TOKEN_CACHE_UNTIL, mobileTokenCacheOpen, NATIVE_PUSH_LEASE_MS, nativeMobilePushReachable, nativePushLease,
  PENDING_CREDENTIAL_DELETIONS, pendingCredentialEntries, type PendingCredentialDeletion } from "@/lib/telephony/device-liveness";
import { assertRateLimit, rateLimitKey } from "@/server/rate-limit";

export { OperatorDeviceError } from "./service-errors";

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

export const CREDENTIAL_NAME_PREFIX = "pm";
export const CREDENTIAL_TAG = "pomoc-motoristom";
/** Refresh the credential when it expires within this window. */
const CREDENTIAL_RENEW_WINDOW_MS = 24 * 60 * 60 * 1000;

function recordDeviceTransition(deps: DeviceDeps, device: DeviceRow, reason: DiagnosticReason) {
  if (deps.deviceKind === "mobile" || !isDiagnosticUuid(device.device_session_id)) return;
  recordServerDiagnostic({organizationId: device.organization_id, profileId: device.profile_id}, {
    type: "phone_lifecycle", module: "telephony", outcome: "ok", reason, deviceSessionId: device.device_session_id,
  });
}

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
  if (error) throw new OperatorDeviceError(`Zariadenie sa nepodarilo načítať: ${error.message}`, 500, { cause: error });
  return data;
}

export async function listOperatorDevices(deps: DeviceDeps, organizationId: string): Promise<DeviceRow[]> {
  const { data, error } = await deps.admin.from(deviceTable(deps)).select("*").eq("organization_id", organizationId).eq("environment", deps.environment);
  if (error) throw new OperatorDeviceError(`Zariadenia sa nepodarilo načítať: ${error.message}`, 500, { cause: error });
  return data ?? [];
}

function credentialUsable(device: DeviceRow, now: Date): boolean {
  if (!device.telnyx_credential_id || !device.sip_username) return false;
  if (!device.credential_expires_at) return true;
  const expires = Date.parse(device.credential_expires_at);
  return Number.isNaN(expires) || expires - now.getTime() > CREDENTIAL_RENEW_WINDOW_MS;
}

const PENDING_DELETIONS = PENDING_CREDENTIAL_DELETIONS;
/** Minting a token stays blocked by a failing deletion until it failed this often AND has been
 * failing this long; only then it no longer locks the operator out. It stays pending (retried on
 * every pass) and a manager is told once in the audit log. Revocations never use this relief. */
const PENDING_BLOCK_FAILURES = 5;
const PENDING_BLOCK_MS = 15 * 60 * 1000;
/** Retried at most this long and this many at once (newest first); the rest are abandoned with an
 * audit row, which stays the record, so a push wake never fans out Telnyx calls. */
const PENDING_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
const PENDING_MAX = 20;
function pendingAge(entry: PendingCredentialDeletion, now: Date): number {
  const since = entry.since ? Date.parse(entry.since) : NaN;
  return Number.isFinite(since) ? now.getTime() - since : 0;
}
function pendingBlocks(entry: PendingCredentialDeletion, now: Date): boolean {
  return entry.failures < PENDING_BLOCK_FAILURES || pendingAge(entry, now) < PENDING_BLOCK_MS;
}

/**
 * Deletes every superseded credential still pending at Telnyx and forgets those that are gone
 * (deleted or 404); a failure is counted on its entry, never silently dropped. `strict` (every
 * revocation: logout, manager disconnect, deactivation, removal) throws whenever a pending
 * deletion fails, so no revocation is reported done while an old JWT may still register.
 * Minting throws while a failing deletion still blocks (see PENDING_BLOCK_*).
 */
async function drainPendingDeletions(deps: DeviceDeps, device: DeviceRow, mode: "mint" | "strict" = "mint"): Promise<DeviceRow> {
  const listed = pendingCredentialEntries(device.metadata);
  if (!listed.length) return device;
  const now = nowOf(deps);
  const pending = listed.filter(entry => pendingAge(entry, now) < PENDING_RETRY_MS).slice(-PENDING_MAX);
  const abandoned = new Set(listed.filter(entry => !pending.includes(entry)).map(entry => entry.id));
  const results = new Map<string, "gone" | "failed">();
  let failure: unknown = null;
  for (const entry of pending) {
    try {
      await deleteCredentialAtProvider(deps, entry.id, "Staré prihlasovacie údaje sa nepodarilo zrušiť u operátora");
      results.set(entry.id, "gone");
    } catch (error) { results.set(entry.id, "failed"); failure ??= error; }
  }
  const settle = (entry: PendingCredentialDeletion): PendingCredentialDeletion[] => {
    const result = results.get(entry.id);
    if (result === "gone" || abandoned.has(entry.id)) return [];
    if (result !== "failed") return [entry];
    const next = { ...entry, since: entry.since ?? now.toISOString(), failures: entry.failures + 1 };
    return [{ ...next, reported: next.reported || !pendingBlocks(next, now) }];
  };
  const after = pending.flatMap(settle);
  // Entries added meanwhile by another request are kept untouched.
  const updated = await updateCurrentDevice(deps, device, (row) => {
    const metadata = retainDeviceLastOnline(row, nowOf(deps));
    const rest = pendingCredentialEntries(row.metadata).flatMap(settle);
    if (rest.length) metadata[PENDING_DELETIONS] = rest; else delete metadata[PENDING_DELETIONS];
    return { metadata: toJson(metadata) };
  });
  // Contention keeps the deleted IDs listed; the next drain sees their 404 and forgets them.
  const current = updated ?? device;
  const incidents = [...after.filter(entry => entry.reported && !listed.find(previous => previous.id === entry.id)?.reported).map(entry => ({ entry, abandoned: false })),
    ...listed.filter(entry => abandoned.has(entry.id)).map(entry => ({ entry, abandoned: true }))];
  for (const { entry, abandoned: dropped } of incidents) {
    console.error(JSON.stringify({ level: "error", scope: "telephony", code: "credential_deletion_stuck", deviceKind: deps.deviceKind ?? "web", failures: entry.failures, abandoned: dropped }));
    const audit = await deps.admin.from("motorist_audit_log").insert({ organization_id: device.organization_id, actor_profile_id: null,
      action: "telephony.credential_deletion_stuck", entity_type: "operator_device", entity_id: device.profile_id, source: "telephony",
      after_payload: toJson({ credentialId: entry.id, deviceKind: deps.deviceKind ?? "web", failures: entry.failures, since: entry.since, abandoned: dropped }) });
    if (audit.error) console.error("Credential deletion incident could not be audited:", audit.error.message);
  }
  if (failure && (mode === "strict" || after.some(entry => results.get(entry.id) === "failed" && pendingBlocks(entry, now)))) throw failure;
  return current;
}

/** Replaced leases a row remembers, so their phone cannot renew its way back. An iPhone keeps a
 * lease usable for up to NATIVE_PUSH_LEASE_MS, so its entries are kept by age (capped for row
 * size, far above any real takeover rate) and `revoked:` placeholders spend no slot. The browser
 * keeps its last ten, as before. */
function rememberReplaced(deps: DeviceDeps, metadata: Record<string, unknown>, sessionId: string | null, now: Date): unknown[] {
  const list = Array.isArray(metadata.revoked_sessions) ? metadata.revoked_sessions as unknown[] : [];
  if (deps.deviceKind !== "mobile") {
    const kept = list.slice(-9);
    if (sessionId) kept.push({ id: sessionId, revoked_at: now.toISOString() });
    return kept;
  }
  const kept = list.filter((entry) => {
    const value = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as { id?: unknown; revoked_at?: unknown } : null;
    if (!value || typeof value.id !== "string" || value.id.startsWith("revoked:")) return false;
    const at = typeof value.revoked_at === "string" ? Date.parse(value.revoked_at) : NaN;
    return !Number.isFinite(at) || now.getTime() - at < NATIVE_PUSH_LEASE_MS;
  });
  if (sessionId && !sessionId.startsWith("revoked:")) kept.push({ id: sessionId, revoked_at: now.toISOString() });
  return kept.slice(-MOBILE_REPLACED_LEASES_MAX);
}
const MOBILE_REPLACED_LEASES_MAX = 100;

export async function ensureOperatorCredential(deps: DeviceDeps, input: { organizationId: string; profileId: string; force?: boolean }): Promise<DeviceRow> {
  const now = nowOf(deps);
  let existing = await getOperatorDevice(deps, input);
  // `force` is the manager pressing "regenerate": mint a new credential even
  // when the stored one is still usable (Phase 3 OperatorsTelephonyPanel).
  if (existing && !input.force && credentialUsable(existing, now)) return existing;
  if (!deps.telnyx) throw new OperatorDeviceError(TELEPHONY_NOT_CONFIGURED_MESSAGE, 503);
  // An earlier switch whose deletion failed is finished first; while it fails nothing new is minted.
  if (existing) existing = await drainPendingDeletions(deps, existing);

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
  // The superseded credential is listed in the same write that switches the row, so a failed or
  // interrupted deletion is never forgotten (and a later switch never overwrites it).
  const pendingAfter = (row: Pick<DeviceRow, "metadata"> | null) => {
    const list = pendingCredentialEntries(row?.metadata);
    return previousCredentialId && previousCredentialId !== credential.id && !list.some(entry => entry.id === previousCredentialId)
      ? [...list, { id: previousCredentialId, since: null, failures: 0, reported: false }] : list;
  };
  const values = {
    organization_id: input.organizationId,
    profile_id: input.profileId,
    environment: deps.environment,
    telnyx_credential_id: credential.id,
    sip_username: credential.sipUsername,
    credential_expires_at: credential.expiresAt,
    registration_state: "unregistered" as const,
    // The previous tab authenticated with the old credential. Its heartbeat
    // cannot register the replacement while the provider deletion is pending.
    ...(existing ? { device_session_id: `revoked:${randomUUID()}`, device_seen_at: null } : {}),
    metadata: toJson({ ...(existing ? retainDeviceLastOnline(existing, now) : {}), credential_created_at: now.toISOString(), previous_credential_id: previousCredentialId,
      ...(pendingAfter(existing).length ? { [PENDING_DELETIONS]: pendingAfter(existing) } : {}) }),
  };
  // Enrollment can race across requests. An upsert would overwrite the first
  // credential and leave an untracked SIP identity active at the provider.
  // Inserts use the org/profile/environment unique key; renewal only replaces
  // the credential we read. A losing request revokes its own mint and reuses
  // the winner, never the other way around.
  let saved;
  if (existing) {
    try {
      saved = { error: null, data: await updateCurrentDevice(deps, existing, current => {
        const metadata = retainDeviceLastOnline(current, nowOf(deps));
        // The replaced lease is remembered, so its phone cannot renew its way back (S8.1).
        const revoked = rememberReplaced(deps, metadata, current.device_session_id?.startsWith("revoked:") ? null : current.device_session_id, now);
        return { ...values, metadata: toJson({ ...metadata, credential_created_at: now.toISOString(), previous_credential_id: previousCredentialId,
          ...(revoked.length ? { revoked_sessions: revoked } : {}), ...(pendingAfter(current).length ? { [PENDING_DELETIONS]: pendingAfter(current) } : {}) }) };
      }) };
    } catch (error) {
      await deleteCredentialAtProvider(deps, credential.id, "Nepoužité prihlasovacie údaje sa nepodarilo zrušiť u operátora");
      throw error;
    }
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
    throw new OperatorDeviceError("Pripojenie zariadenia sa medzitým zmenilo. Skúste to znova.", 409, { code: LEASE_CONTENTION });
  }
  // The superseded credential has to die at Telnyx: it can still register and
  // the JWT minted from it stays valid for up to 24 h, so keeping it would make
  // "new credentials" a rename rather than a revocation. Until it is confirmed
  // gone it stays pending, and every later mint or revocation retries it first.
  const device = await drainPendingDeletions(deps, saved.data);
  if (existing) recordDeviceTransition(deps, existing, "superseded");
  return device;
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

/** Merge against the current session snapshot so a heartbeat cannot discard
 * concurrent token/audio metadata, or restore the metadata of a revoked tab. */
async function updateCurrentDevice(
  deps: DeviceDeps,
  observed: DeviceRow,
  values: (current: DeviceRow) => Database["public"]["Tables"]["motorist_operator_devices"]["Update"],
): Promise<DeviceRow | null> {
  let current = observed;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let update = deps.admin.from(deviceTable(deps)).update(values(current)).eq("id", observed.id)
      .eq("metadata", JSON.stringify(current.metadata))
      .eq("registration_state", current.registration_state);
    update = observed.device_session_id === null ? update.is("device_session_id", null) : update.eq("device_session_id", observed.device_session_id);
    update = observed.telnyx_credential_id === null ? update.is("telnyx_credential_id", null) : update.eq("telnyx_credential_id", observed.telnyx_credential_id);
    update = current.device_seen_at === null ? update.is("device_seen_at", null) : update.eq("device_seen_at", current.device_seen_at);
    const result = await update.select("*").maybeSingle();
    if (result.error) throw new OperatorDeviceError(`Zariadenie sa nepodarilo aktualizovať: ${result.error.message}`, 500);
    if (result.data) return result.data;
    const latest = await getOperatorDevice(deps, { organizationId: observed.organization_id, profileId: observed.profile_id });
    if (!latest || latest.id !== observed.id || latest.device_session_id !== observed.device_session_id || latest.telnyx_credential_id !== observed.telnyx_credential_id) return null;
    current = latest;
  }
  throw new OperatorDeviceError("Stav zariadenia sa medzitým zmenil. Skúste to znova.", 409, { code: LEASE_CONTENTION });
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
/** Another device holds the lease: only an explicit takeover helps. */
const LEASE_TAKEN = "native_lease_taken";
/** The device row changed under this request: asking again is safe. */
const LEASE_CONTENTION = "native_lease_contention";
/** The operator is in a call on another device: neither a takeover nor a rotation may cut it. */
const LEASE_ON_CALL = "native_lease_on_call";
/** A replaced iPhone lease: only an explicit takeover brings it back. */
const LEASE_STALE = "native_lease_stale";
/** Credential rotations per operator on one server instance (TEST shares its Telnyx account with production). */
const ROTATION_LIMIT = { limit: 6, windowMs: 10 * 60 * 1000, message: "Telefón sa prepína medzi zariadeniami príliš často. Skúste to o chvíľu." };

function revokedSession(device: Pick<DeviceRow, "metadata"> | null, deviceSessionId: string): boolean {
  const metadata = device?.metadata && typeof device.metadata === "object" && !Array.isArray(device.metadata) ? device.metadata : {};
  const list = metadata.revoked_sessions;
  return Array.isArray(list) && list.some(entry => entry && typeof entry === "object" && !Array.isArray(entry) && (entry as { id?: unknown }).id === deviceSessionId);
}

export async function issueWebphoneToken(
  deps: DeviceDeps,
  input: { organizationId: string; profileId: string; userAgent?: string | null; takeover?: boolean; handoff?: boolean; deviceSessionId?: string | null;
    /** iPhone only (`mobile_rotate_on_takeover`): a lease that replaces another phone's lease gets a new credential. */
    rotateCredential?: boolean;
    /** iPhone only: the phone may cache this JWT (S8.1); the device records until when. */
    tokenCache?: boolean },
): Promise<WebphoneToken> {
  if (!deps.telnyx) throw new OperatorDeviceError(TELEPHONY_NOT_CONFIGURED_MESSAGE, 503);
  const reachable = (device: DeviceRow) => deviceIsLive(device, nowOf(deps)) || deps.deviceKind === "mobile" && nativeMobilePushReachable(device, nowOf(deps));
  // A call in progress on another device is never moved or cut: not by a takeover, not by a rotation.
  const assertNotOnCall = async () => {
    const presence = await deps.admin.from("motorist_operator_presence").select("status")
      .eq("organization_id", input.organizationId).eq("profile_id", input.profileId).maybeSingle();
    if (presence.error) throw new OperatorDeviceError("Stav operátora sa nepodarilo overiť.", 503);
    if (presence.data?.status === "on_call") throw new OperatorDeviceError("Prebiehajúci hovor nemožno presunúť pripojením iného prehliadača. Najprv ho dokončite.", 409, { code: LEASE_ON_CALL });
  };
  if (input.takeover) await assertNotOnCall();
  // Opening the dispatch on a second device must not silently steal incoming
  // calls from a live phone, even between calls. Own-token renewal is allowed.
  const current = !input.takeover || deps.deviceKind === "mobile" ? await getOperatorDevice(deps, input) : null;
  // The phone that held the replaced lease may keep a JWT of this credential in its Keychain
  // (S8.1) and log in with it before its refresh is refused. Deleting the credential at Telnyx
  // ends that JWT and the old phone's registration. Fail-closed: while a JWT issued for caching
  // may still be in use, this happens whatever the switch says now. Renewing one's own lease
  // never rotates.
  const rotating = deps.deviceKind === "mobile" && (input.rotateCredential === true || mobileTokenCacheOpen(current?.metadata, nowOf(deps)));
  // Where rotation applies, an iPhone whose lease another phone replaced never gets it back by
  // renewing (and never rotates the new phone's credential): only an explicit takeover does. The
  // check is repeated on every row this request reads, since a takeover can land in between.
  // Without rotation (switches off) a replaced lease behaves as before.
  const assertNotReplaced = (row: Pick<DeviceRow, "metadata"> | null) => {
    if (rotating && !input.takeover && input.deviceSessionId && revokedSession(row, input.deviceSessionId)) {
      throw new OperatorDeviceError("Telefón bol odpojený alebo prihlásený na inom zariadení.", 409, { code: LEASE_STALE });
    }
  };
  assertNotReplaced(current);
  if (!input.takeover) {
    const sameTab = Boolean(input.deviceSessionId && current?.device_session_id === input.deviceSessionId);
    if (current && !sameTab && reachable(current)) throw new OperatorDeviceError(TOKEN_TAKEOVER_MESSAGE, 409, { code: LEASE_TAKEN });
  }
  const force = rotating && Boolean(current?.telnyx_credential_id && current.device_session_id && current.device_session_id !== input.deviceSessionId);
  if (force) {
    if (!input.takeover) await assertNotOnCall();
    assertRateLimit(rateLimitKey("mobile-credential-rotation", input.profileId), ROTATION_LIMIT);
  }
  // No JWT is minted while a superseded credential is still alive at Telnyx.
  const device = await drainPendingDeletions(deps, await ensureOperatorCredential(deps, { ...input, force }));
  assertNotReplaced(device);
  const sameTab = Boolean(input.deviceSessionId && device.device_session_id === input.deviceSessionId);
  if (!input.takeover && !sameTab && reachable(device)) throw new OperatorDeviceError(TOKEN_TAKEOVER_MESSAGE, 409, { code: LEASE_TAKEN });
  const credentialId = device.telnyx_credential_id;
  const sipUsername = device.sip_username;
  if (!credentialId || !sipUsername) throw new OperatorDeviceError("Zariadenie nemá prihlasovacie údaje.", 500);

  const now = nowOf(deps);
  const token = await deps.telnyx.mintCredentialToken(credentialId);
  const expiresAt = decodeJwtExpiry(token) ?? new Date(now.getTime() + DEFAULT_TOKEN_TTL_MS);
  // A heartbeat already in flight must remain valid across this tab's renewal.
  const renewing = sameTab && !input.handoff;
  const deviceSessionId = renewing ? device.device_session_id! : randomUUID();

  // A refresh for a phone that is already registered and still sending
  // heartbeats must not report it as registering: the ring engine skips any
  // operator who is not "registered", so downgrading here made the operator
  // invisible until the next heartbeat and inbound calls silently walked past
  // them. Only a genuinely new or stale registration starts as "registering".
  const updated = await updateCurrentDevice(deps, device, (current) => {
    // The guarded write itself refuses a lease replaced since the last read.
    assertNotReplaced(current);
    const metadata = retainDeviceLastOnline(current, nowOf(deps));
    const revoked = rememberReplaced(deps, metadata, renewing ? null : current.device_session_id, now);
    if (input.tokenCache && deps.deviceKind === "mobile") {
      // As long as this JWT can log in at all, plus a margin; only ever extended, since an
      // earlier JWT may still be cached somewhere.
      const previous = Date.parse(String(metadata[MOBILE_TOKEN_CACHE_UNTIL] ?? "")), until = expiresAt.getTime() + MOBILE_TOKEN_CACHE_MARGIN_MS;
      metadata[MOBILE_TOKEN_CACHE_UNTIL] = new Date(Number.isFinite(previous) ? Math.max(previous, until) : until).toISOString();
    }
    return {
      last_token_issued_at: now.toISOString(),
      token_expires_at: expiresAt.toISOString(),
      device_session_id: deviceSessionId,
      registration_state: renewing && deviceIsLive(current, now) ? "registered" : "registering",
      ...(!renewing ? { device_seen_at: null } : {}),
      user_agent: input.userAgent ?? current.user_agent,
      metadata: toJson({ ...metadata, revoked_sessions: revoked }),
    };
  });
  // A slow token response cannot overwrite a newer takeover or revocation. The
  // phone asks again; the next answer says whether another device holds the lease.
  if (!updated) throw new OperatorDeviceError(TOKEN_TAKEOVER_MESSAGE, 409, { code: LEASE_CONTENTION });

  if (!renewing) {
    if (device.device_session_id) recordDeviceTransition(deps, device, "superseded");
    recordDeviceTransition(deps, updated, "registering");
  }

  return { token, expiresAt: expiresAt.toISOString(), deviceSessionId, sipUsername, credentialId };
}

/**
 * After a token was minted, before it leaves the server: a deactivation or removal that landed
 * between the route's access check and the mint would otherwise leave a freshly enrolled, live
 * credential nobody revokes. If the profile is gone or no longer active, this device and its
 * credential are revoked (a removed profile's row is gone with it, so the issued credential is
 * deleted directly) and the token is refused.
 */
export async function refuseIfAccessLost(deps: DeviceDeps, input: { organizationId: string; profileId: string }, issued: Pick<WebphoneToken, "credentialId">): Promise<void> {
  // The same predicate as the routes' own sign-in check: a deactivation always turns `active` off,
  // while a signed-in user who is still "invited" keeps the phone.
  const { data, error } = await deps.admin.from("motorist_profiles").select("active")
    .eq("organization_id", input.organizationId).eq("id", input.profileId).maybeSingle();
  if (error) throw new OperatorDeviceError("Oprávnenie sa nepodarilo overiť.", 503);
  if (data?.active === true) return;
  try {
    const revoked = await disconnectDevice(deps, input);
    if (!revoked) await deleteCredentialAtProvider(deps, issued.credentialId, "Prihlasovacie údaje odobratého používateľa sa nepodarilo zrušiť u operátora");
  } catch (revocation) {
    console.error("Revoking a token issued during an access removal failed:", revocation);
  }
  throw new OperatorDeviceError("Prístup k telefónu bol zrušený.", 403, { code: "native_access_revoked" });
}

export type TouchDeviceResult = { ok: true; device: DeviceRow } | { ok: false; reason: "unknown_device" | "stale_session" };

export async function touchDevice(
  deps: DeviceDeps,
  input: { organizationId: string; profileId: string; deviceSessionId: string; registrationState?: DeviceRow["registration_state"];
    userAgent?: string | null; audio?: { blocked: boolean; remoteMedia: boolean }; nativeVoipRegistered?: boolean },
): Promise<TouchDeviceResult> {
  const device = await getOperatorDevice(deps, input);
  if (!device) return { ok: false, reason: "unknown_device" };
  if (!input.deviceSessionId || device.device_session_id !== input.deviceSessionId) return { ok: false, reason: "stale_session" };
  const now = nowOf(deps).toISOString();
  // An `unregistered` report is the tab saying goodbye (pagehide): clear the
  // liveness stamp instead of refreshing it, or the ring plan keeps allocating
  // steps to a phone that is gone.
  const leaving = input.registrationState === "unregistered";
  const updated = await updateCurrentDevice(deps, device, (current) => {
    const snapshotNow = nowOf(deps);
    const metadata = retainDeviceLastOnline(current, snapshotNow);
    if (!leaving && (input.registrationState ?? current.registration_state) === "registered") {
      const previous = deviceLastOnlineAt(current, snapshotNow);
      metadata[LAST_ONLINE_METADATA_KEY] = previous && previous > now ? previous : now;
    }
    // Kept on the device, not on the call; retain other lifecycle metadata.
    if (input.audio) metadata.audio = { ...input.audio, at: now };
    if (deps.deviceKind === "mobile" && input.nativeVoipRegistered !== undefined) {
      metadata.native_voip = nativePushLease(current, snapshotNow,
        input.nativeVoipRegistered && !leaving && (input.registrationState ?? current.registration_state) === "registered");
    }
    return { device_seen_at: leaving ? null : now, metadata: toJson(metadata),
      ...(input.registrationState ? { registration_state: input.registrationState } : {}),
      ...(input.userAgent ? { user_agent: input.userAgent } : {}),
    };
  });
  if (!updated) return { ok: false, reason: "stale_session" };
  if (updated.registration_state !== device.registration_state) recordDeviceTransition(deps, updated, updated.registration_state === "error" ? "auth_failure" : updated.registration_state);
  return { ok: true, device: updated };
}

/** Revokes the browser session id only (the tab's next heartbeat gets 409). */
async function revokeDeviceSession(deps: DeviceDeps, device: DeviceRow): Promise<DeviceRow> {
  const updated = await updateCurrentDevice(deps, device, (current) => ({
    device_session_id: `revoked:${randomUUID()}`, registration_state: "unregistered", device_seen_at: null,
    metadata: toJson({ ...retainDeviceLastOnline(current, nowOf(deps)),
      ...(deps.deviceKind === "mobile" ? { native_revocation_session_id: current.device_session_id?.startsWith("revoked:")
        ? (current.metadata && typeof current.metadata === "object" && !Array.isArray(current.metadata) ? current.metadata.native_revocation_session_id ?? null : null)
        : current.device_session_id } : {}) }),
  }));
  if (!updated) throw new OperatorDeviceError(TOKEN_TAKEOVER_MESSAGE, 409);
  recordDeviceTransition(deps, device, "ownership_release");
  return updated;
}

/** `revoked`: whether anything was taken away (a live lease or a credential, current or pending). */
export type DisconnectResult = { device: DeviceRow; deletedCredentialId: string | null; revoked: boolean };

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
  input: { organizationId: string; profileId: string; keepCredential?: boolean; deviceSessionId?: string },
): Promise<DisconnectResult | null> {
  if (!deps.deviceKind && !input.keepCredential) {
    const web = await disconnectDevice({ ...deps, deviceKind: "web" }, input);
    const mobile = await disconnectDevice({ ...deps, deviceKind: "mobile" }, input);
    return web ?? mobile;
  }
  const device = await getOperatorDevice(deps, input);
  if (!device) return null;
  // A delayed mobile logout may never revoke a newer device's lease.
  if (input.deviceSessionId && device.device_session_id !== input.deviceSessionId) throw new OperatorDeviceError(TOKEN_TAKEOVER_MESSAGE, 409);
  // Superseded credentials still alive at Telnyx go first; while one stays alive the revocation fails.
  const revoked = await drainPendingDeletions(deps, await revokeDeviceSession(deps, device), "strict");
  // Whether this call took anything away: a live lease, a pending credential, or (below) the credential.
  const tookAway = !device.device_session_id?.startsWith("revoked:")
    || pendingCredentialEntries(revoked.metadata).length < pendingCredentialEntries(device.metadata).length;
  if (input.keepCredential || !revoked.telnyx_credential_id) return { device: revoked, deletedCredentialId: null, revoked: tookAway };

  const credentialId = revoked.telnyx_credential_id;
  await deleteCredentialAtProvider(deps, credentialId, "Telefón sme odhlásili, ale prihlasovacie údaje sa nepodarilo zrušiť u operátora");
  const cleared = await updateCurrentDevice(deps, revoked, (current) => ({
      telnyx_credential_id: null,
      sip_username: null,
      credential_expires_at: null,
      token_expires_at: null,
      metadata: toJson({ ...retainDeviceLastOnline(current, nowOf(deps)), deleted_credential_id: credentialId, deleted_credential_at: nowOf(deps).toISOString() }),
    }));
  if (!cleared) throw new OperatorDeviceError(TOKEN_TAKEOVER_MESSAGE, 409);
  return { device: cleared, deletedCredentialId: credentialId, revoked: true };
}

export function deviceIsLive(device: Pick<DeviceRow, "device_seen_at" | "registration_state"> | null, now: Date): boolean {
  if (!device) return false;
  return isDeviceLive({ deviceSeenAt: device.device_seen_at, registrationState: device.registration_state }, now);
}

export function deviceSipUri(device: DeviceRow): string | null {
  return device.sip_username ? telnyxSipUri(device.sip_username) : null;
}
