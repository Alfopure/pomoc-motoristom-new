import { nextBackoffDelayMs } from "@/lib/telephony/client-request";

/**
 * How often the console re-reads telephony state.
 *
 * The console used to poll `calls/active` every 750-1000 ms regardless of
 * whether anyone was looking at it, and every other reader ran on a flat
 * interval. With several tabs open per operator that is the dominant source of
 * Supabase reads and Vercel invocations in the whole application.
 *
 * Two rules shape everything here:
 *
 * 1. Responsiveness only matters where a human is watching a live call. A
 *    hidden tab has nobody to be responsive to, and an idle console has
 *    nothing changing quickly.
 * 2. Freshness is bounded by the server anyway. `calls/active` reuses an
 *    organization-wide provider snapshot for 3 seconds, so polling it at 1 Hz
 *    cannot produce fresher data than polling it at 0.5 Hz -- it only produces
 *    more database reads.
 *
 * Control actions are deliberately NOT scheduled here. They always request a
 * fresh capture, because trading correctness for cadence on a hangup or a
 * redirect is exactly what must never happen.
 */

/** What the operator is doing, which decides how fast the console must react. */
export type TelephonyPollActivity = "in_call" | "ringing" | "idle";

export const ACTIVE_CALL_POLL_MS = {
  /** Unchanged: a live or ringing call in a visible tab stays at 750 ms. */
  engagedVisible: 750,
  engagedHidden: 3_000,
  /** Raised from 1 s: the server-side snapshot cache is 3 s wide. */
  idleVisible: 2_000,
  idleHidden: 15_000,
} as const;

/**
 * Cadence while the Supabase Realtime channel is connected (design 2b).
 *
 * A connected channel makes every server-side telephony write ring a doorbell
 * in this browser, and the console refetches immediately. Polling then stops
 * being the way updates arrive and becomes the safety net for the one thing
 * broadcast cannot cover: a message lost while the socket was healthy enough
 * not to report an error. So it relaxes -- but it never stops, because a
 * console showing a stale live call is worse than a few extra reads.
 *
 * Values are floors, never ceilings: the relaxed delay is only used when it is
 * *slower* than the polling-only delay, so a hidden tab keeps its longer sleep.
 */
export const REALTIME_ACTIVE_CALL_POLL_MS = {
  engagedVisible: 3_000,
  engagedHidden: 10_000,
  idleVisible: 10_000,
  idleHidden: 30_000,
} as const;

export const SUPPORT_POLL_MS = {
  /** presence, workplace-selection and call history. */
  visible: 10_000,
  hidden: 30_000,
} as const;

export const TAKEOVER_POLL_MS = {
  /** A handover is a 30-second decision, so it stays responsive while live. */
  activeVisible: 4_000,
  activeHidden: 15_000,
  /** No request in flight: this is a "has anything appeared?" check. */
  idleVisible: 20_000,
  idleHidden: 60_000,
} as const;

/** Failing endpoints back off to this ceiling rather than hammering. */
export const POLL_BACKOFF_MAX_MS = 30_000;

export function activeCallPollDelayMs(input: {
  activity: TelephonyPollActivity;
  documentHidden: boolean;
  consecutiveFailures?: number;
  /** True only while the org's Realtime channel reports SUBSCRIBED. */
  realtimeConnected?: boolean;
  random?: () => number;
}) {
  const table = input.realtimeConnected ? REALTIME_ACTIVE_CALL_POLL_MS : ACTIVE_CALL_POLL_MS;
  const engaged = input.activity !== "idle";
  const relaxed = engaged
    ? (input.documentHidden ? table.engagedHidden : table.engagedVisible)
    : (input.documentHidden ? table.idleHidden : table.idleVisible);
  const polling = engaged
    ? (input.documentHidden ? ACTIVE_CALL_POLL_MS.engagedHidden : ACTIVE_CALL_POLL_MS.engagedVisible)
    : (input.documentHidden ? ACTIVE_CALL_POLL_MS.idleHidden : ACTIVE_CALL_POLL_MS.idleVisible);
  const base = Math.max(relaxed, polling);
  return withBackoff(base, input.consecutiveFailures, input.random);
}

export function supportPollDelayMs(input: {
  documentHidden: boolean;
  consecutiveFailures?: number;
  random?: () => number;
}) {
  const base = input.documentHidden ? SUPPORT_POLL_MS.hidden : SUPPORT_POLL_MS.visible;
  return withBackoff(base, input.consecutiveFailures, input.random);
}

export function takeoverPollDelayMs(input: {
  hasOpenRequest: boolean;
  documentHidden: boolean;
  consecutiveFailures?: number;
  random?: () => number;
}) {
  const base = input.hasOpenRequest
    ? (input.documentHidden ? TAKEOVER_POLL_MS.activeHidden : TAKEOVER_POLL_MS.activeVisible)
    : (input.documentHidden ? TAKEOVER_POLL_MS.idleHidden : TAKEOVER_POLL_MS.idleVisible);
  return withBackoff(base, input.consecutiveFailures, input.random);
}

/**
 * Derives the activity level from what the console already knows. A ringing
 * call counts as engaged even before it is answered: that is precisely the
 * moment the operator needs the fastest updates.
 */
export function telephonyPollActivity(input: {
  hasBrowserCall: boolean;
  liveCallCount: number;
}): TelephonyPollActivity {
  if (input.hasBrowserCall) return "in_call";
  return input.liveCallCount > 0 ? "ringing" : "idle";
}

function withBackoff(baseMs: number, consecutiveFailures = 0, random?: () => number) {
  if (consecutiveFailures <= 0) return baseMs;
  return nextBackoffDelayMs({
    baseMs,
    consecutiveFailures,
    maxMs: Math.max(baseMs, POLL_BACKOFF_MAX_MS),
    random,
  });
}
