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
