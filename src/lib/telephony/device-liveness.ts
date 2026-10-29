import { nativePushEnabled, nativePushTestEnabled } from "@/lib/app-environment";

/**
 * Freshness of an operator's browser phone registration.
 *
 * The rule lives in `src/lib` because both sides need exactly the same one:
 * the router skips a member whose device heartbeat has lapsed
 * (`routing/eligibility.ts`), and the operator screens (Phase 3) must not tell
 * a manager the phone is "connected" while the ring plan is already stepping
 * over it. Pure, no Node built-ins, so it is safe in the browser bundle.
 */

/** A heartbeat older than this means the tab is gone (design §2.6). */
export const DEVICE_LIVENESS_WINDOW_MS = 120_000;

export type DeviceLiveness = {
  deviceSeenAt?: string | null;
  registrationState?: string | null;
};

/** Device heartbeat freshness (`device_seen_at` within the liveness window). */
export function isDeviceLive(device: DeviceLiveness | undefined | null, now: Date, windowMs = DEVICE_LIVENESS_WINDOW_MS): boolean {
  if (!device) return false;
  // Only a registered phone can take an invite; `null` stays live for rows written
  // before the heartbeat reported a state.
  if (device.registrationState !== null && device.registrationState !== "registered") return false;
  if (!device.deviceSeenAt) return false;
  const seen = Date.parse(device.deviceSeenAt);
  if (Number.isNaN(seen)) return false;
  return now.getTime() - seen <= windowMs;
}

/** Shape of a mobile device needed for push liveness; no server dependencies. */
export type NativeMobileDevice = {
  environment: string; device_session_id: string | null; telnyx_credential_id: string | null;
  registration_state: string | null; sip_username: string | null; credential_expires_at: string | null; metadata: unknown;
};

export const NATIVE_PUSH_LEASE_MS = 7 * 24 * 60 * 60 * 1000;

/** No push token or SIP JWT in the database. A bounded, revocable lease allows
 * the router to dial the mobile SIP identity while iOS has suspended JS.
 * A cold launch renews the provider JWT using the user's secured Auth session. */
export function nativePushLease(device: NativeMobileDevice, now: Date, registered: boolean) {
  if (!registered || !nativePushEnabled() || !device.device_session_id || !device.telnyx_credential_id) return null;
  const credentialExpiry = device.credential_expires_at ? Date.parse(device.credential_expires_at) : Infinity;
  const until = Math.min(now.getTime() + NATIVE_PUSH_LEASE_MS, credentialExpiry);
  if (!(until > now.getTime())) return null;
  return { v: 1, platform: "ios", deviceSessionId: device.device_session_id, until: new Date(until).toISOString() };
}

/** `environment` is the device row's telephony environment: `development` on
 * the dedicated TEST, `production` on production (see `telephonyEnvironment`). */
export function nativeMobilePushReachable(device: NativeMobileDevice | null | undefined, now: Date): boolean {
  if (!device || !device.device_session_id || !device.telnyx_credential_id || !device.sip_username
    || device.registration_state !== "registered") return false;
  // Row fields first; the opt-ins (flags before identity) decide the one reachable environment.
  const expected = nativePushTestEnabled() ? "development" : nativePushEnabled() ? "production" : null;
  if (!expected || device.environment !== expected) return false;
  const metadata = device.metadata;
  const value = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, unknown>).native_voip : null;
  const lease = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!lease || typeof lease !== "object" || Array.isArray(lease) || lease.v !== 1 || lease.platform !== "ios"
    || lease.deviceSessionId !== device.device_session_id || typeof lease.until !== "string") return false;
  const until = Date.parse(lease.until);
  const credentialExpiry = device.credential_expires_at ? Date.parse(device.credential_expires_at) : Infinity;
  return Number.isFinite(until) && until > now.getTime() && until <= now.getTime() + NATIVE_PUSH_LEASE_MS
    && credentialExpiry > now.getTime() && until <= credentialExpiry;
}
