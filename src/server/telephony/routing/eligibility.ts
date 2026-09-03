import type { OperatorPresenceStatus, RingAttemptResult } from "@/lib/supabase/database.types";

/**
 * Ring eligibility (pure). See design §2.6:
 *
 * - `external_number` members are always eligible (coverage of last resort);
 * - operators need presence `available` (or `after_call_work` whose
 *   `wrap_up_until` has passed), a device heartbeat within the last 120 s and
 *   no open offer in another session;
 * - the Telnyx dial result is the liveness truth: an immediate hangup with
 *   `USER_NOT_REGISTERED` / `UNALLOCATED_NUMBER` becomes `skipped_offline`.
 */

export const DEVICE_LIVENESS_WINDOW_MS = 120_000;

export type EligibilityMember =
  | { kind: "operator"; profileId: string }
  | { kind: "external_number"; externalNumber: string };

export type EligibilityPresence = {
  profileId: string;
  status: OperatorPresenceStatus;
  currentSessionId?: string | null;
  wrapUpUntil?: string | null;
};

export type EligibilityDevice = {
  profileId: string;
  deviceSeenAt?: string | null;
  registrationState?: string | null;
  sipUsername?: string | null;
};

export type EligibilityInput = {
  now: Date;
  presence: ReadonlyMap<string, EligibilityPresence> | EligibilityPresence[];
  devices: ReadonlyMap<string, EligibilityDevice> | EligibilityDevice[];
  /** Profile ids that currently hold an `offered` attempt in another session. */
  openOffers?: ReadonlySet<string> | string[];
  /** The session being routed; an open offer inside it does not block. */
  sessionId?: string | null;
  deviceWindowMs?: number;
};

export type IneligibilityReason =
  | "no_presence"
  | "offline"
  | "paused"
  | "ringing"
  | "on_call"
  | "wrap_up"
  | "no_device"
  | "device_stale"
  | "open_offer";

export type EligibilityDecision = { eligible: true } | { eligible: false; reason: IneligibilityReason };

function toMap<T extends { profileId: string }>(value: ReadonlyMap<string, T> | T[]): ReadonlyMap<string, T> {
  if (value instanceof Map) return value;
  return new Map((value as T[]).map((entry) => [entry.profileId, entry]));
}

function toSet(value: ReadonlySet<string> | string[] | undefined): ReadonlySet<string> {
  if (!value) return new Set();
  if (value instanceof Set) return value;
  return new Set(value as string[]);
}

function ms(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Device heartbeat freshness (`device_seen_at` within the liveness window). */
export function isDeviceLive(device: EligibilityDevice | undefined, now: Date, windowMs = DEVICE_LIVENESS_WINDOW_MS): boolean {
  if (!device) return false;
  // Only a registered phone can take an invite; `null` stays live for rows written
  // before the heartbeat reported a state.
  if (device.registrationState !== null && device.registrationState !== "registered") return false;
  const seen = ms(device.deviceSeenAt);
  if (seen === null) return false;
  return now.getTime() - seen <= windowMs;
}

/** Whether the presence row allows a new offer right now. */
export function presenceAllowsOffer(presence: EligibilityPresence | undefined, now: Date, sessionId?: string | null): EligibilityDecision {
  if (!presence) return { eligible: false, reason: "no_presence" };
  switch (presence.status) {
    case "available":
      return { eligible: true };
    case "after_call_work": {
      const until = ms(presence.wrapUpUntil);
      if (until === null || until <= now.getTime()) return { eligible: true };
      return { eligible: false, reason: "wrap_up" };
    }
    case "ringing":
      // A ring inside the same session (re-evaluation) is fine; another session's ring is not.
      if (sessionId && presence.currentSessionId === sessionId) return { eligible: true };
      return { eligible: false, reason: "ringing" };
    case "on_call":
      return { eligible: false, reason: "on_call" };
    case "paused":
      return { eligible: false, reason: "paused" };
    case "offline":
    default:
      return { eligible: false, reason: "offline" };
  }
}

export function evaluateMemberEligibility(member: EligibilityMember, input: EligibilityInput): EligibilityDecision {
  if (member.kind === "external_number") return { eligible: true };

  const presence = toMap(input.presence).get(member.profileId);
  const presenceDecision = presenceAllowsOffer(presence, input.now, input.sessionId);
  if (!presenceDecision.eligible) return presenceDecision;

  const device = toMap(input.devices).get(member.profileId);
  if (!device || !device.sipUsername) return { eligible: false, reason: "no_device" };
  if (!isDeviceLive(device, input.now, input.deviceWindowMs)) return { eligible: false, reason: "device_stale" };

  if (toSet(input.openOffers).has(member.profileId)) return { eligible: false, reason: "open_offer" };
  return { eligible: true };
}

/**
 * Maps a Telnyx `call.hangup` on an unanswered ring leg to the attempt result.
 * Causes are compared case-insensitively; `sipCause` is the numeric SIP code
 * Telnyx adds as `sip_hangup_cause`.
 */
export function classifyRingHangup(input: { hangupCause?: string | null; sipHangupCause?: string | number | null; answered?: boolean }): RingAttemptResult {
  if (input.answered) return "answered";
  const cause = (input.hangupCause ?? "").toLowerCase();
  const sip = input.sipHangupCause === null || input.sipHangupCause === undefined ? "" : String(input.sipHangupCause);

  if (["user_not_registered", "unallocated_number", "no_route_destination", "invalid_number_format", "not_found", "subscriber_absent"].includes(cause)) {
    return "skipped_offline";
  }
  if (["480", "404", "410", "604"].includes(sip)) return "skipped_offline";
  if (cause === "user_busy" || sip === "486" || sip === "600") return "busy";
  if (["originator_cancel", "lose_race", "cancelled", "canceled"].includes(cause) || sip === "487") return "cancelled";
  if (["timeout", "no_answer", "no_user_response", "call_rejected", "normal_clearing", "time_limit", "attended_transfer"].includes(cause)) return "no_answer";
  if (["normal_temporary_failure", "network_out_of_order", "service_unavailable", "bearer_capability_not_available", "unspecified", "recovery_on_timer_expire"].includes(cause)) {
    return "failed";
  }
  return "no_answer";
}

/** Terminal attempt results (no leg still ringing for this attempt). */
export function isTerminalAttempt(result: RingAttemptResult): boolean {
  return result !== "pending" && result !== "offered";
}
