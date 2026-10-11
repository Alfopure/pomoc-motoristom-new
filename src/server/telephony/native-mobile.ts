import { isTestLiveDeployment, type AppEnvironmentVariables } from "@/lib/app-environment";
import type { DeviceRow } from "./state/types";

/** Separate opt-ins: compiling CallKit does not establish APNs readiness. */
export function nativeVoiceTestEnabled(env: AppEnvironmentVariables = process.env): boolean {
  return isTestLiveDeployment(env) && env.MOTORIST_NATIVE_VOICE_TEST_ENABLED === "true";
}
export function nativePushTestEnabled(env: AppEnvironmentVariables = process.env): boolean {
  return nativeVoiceTestEnabled(env) && env.MOTORIST_NATIVE_VOIP_PUSH_TEST_ENABLED === "true";
}

export const NATIVE_PUSH_LEASE_MS = 7 * 24 * 60 * 60 * 1000;

/** No push token or SIP JWT in the database. A bounded, revocable lease allows
 * the router to dial the mobile SIP identity while iOS has suspended JS.
 * A cold launch renews the provider JWT using the user's secured Auth session. */
export function nativePushLease(device: DeviceRow, now: Date, registered: boolean) {
  if (!registered || !nativePushTestEnabled() || !device.device_session_id || !device.telnyx_credential_id) return null;
  const credentialExpiry = device.credential_expires_at ? Date.parse(device.credential_expires_at) : Infinity;
  const until = Math.min(now.getTime() + NATIVE_PUSH_LEASE_MS, credentialExpiry);
  if (!(until > now.getTime())) return null;
  return { v: 1, platform: "ios", deviceSessionId: device.device_session_id, until: new Date(until).toISOString() };
}

export function nativeMobilePushReachable(device: DeviceRow | null | undefined, now: Date): boolean {
  if (!device || !nativePushTestEnabled() || device.environment !== "development"
    || !device.device_session_id || !device.telnyx_credential_id || !device.sip_username
    || device.registration_state !== "registered") return false;
  const metadata = device.metadata;
  const lease = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata.native_voip : null;
  if (!lease || typeof lease !== "object" || Array.isArray(lease) || lease.v !== 1 || lease.platform !== "ios"
    || lease.deviceSessionId !== device.device_session_id || typeof lease.until !== "string") return false;
  const until = Date.parse(lease.until);
  const credentialExpiry = device.credential_expires_at ? Date.parse(device.credential_expires_at) : Infinity;
  return Number.isFinite(until) && until > now.getTime() && until <= now.getTime() + NATIVE_PUSH_LEASE_MS
    && credentialExpiry > now.getTime() && until <= credentialExpiry;
}
