/**
 * Supabase Realtime Broadcast subscription for the dispatch console (design
 * §2.4, phase 2b).
 *
 * The console is correct with polling alone; this module only makes it fast.
 * The database broadcasts "something changed" on `org:<id>:telephony` whenever
 * a call session, a call leg or an operator presence row is written, and the
 * console reacts by refetching `GET /api/telephony/calls/active`. The payload
 * is never trusted or merged: the snapshot endpoint stays the single source of
 * truth, so a lost, duplicated or out-of-order message can only cost one extra
 * request, never a wrong screen.
 *
 * Two invariants shape the implementation:
 *
 * 1. **One channel per browser.** Several React components (and several
 *    consoles inside one tab) share a refcounted channel per organisation --
 *    a websocket per mounted component is exactly the load this replaces.
 * 2. **Failure is visible.** The subscriber is told when the channel is not
 *    connected so it can go back to the fast poll cadence
 *    (`activeCallPollDelayMs({ realtimeConnected })`). Silent degradation to a
 *    3-second cadence on a dead socket would be worse than not subscribing.
 */

import { nextBackoffDelayMs } from "@/lib/telephony/client-request";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

export type TelephonyRealtimeStatus = "connecting" | "connected" | "disconnected";

/** Structural subset of `RealtimeChannel` / `SupabaseClient` used here. */
export type RealtimeChannelLike = {
  on(
    type: "broadcast",
    filter: { event: string },
    callback: (payload: unknown) => void,
  ): RealtimeChannelLike;
  subscribe(callback?: (status: string, error?: unknown) => void): unknown;
  unsubscribe?(): unknown;
};

export type RealtimeClientLike = {
  channel(topic: string, options?: { config?: { private?: boolean } }): RealtimeChannelLike;
  removeChannel(channel: RealtimeChannelLike): unknown;
};

export type TelephonyRealtimeSeams = {
  createClient?: () => RealtimeClientLike;
  setTimer?: (handler: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
  random?: () => number;
};

export type TelephonyRealtimeSubscription = {
  organizationId: string;
  onChange: () => void;
  onStatus?: (status: TelephonyRealtimeStatus) => void;
  seams?: TelephonyRealtimeSeams;
};

/** Private topic carrying the organisation id the RLS policy checks. */
export function telephonyRealtimeTopic(organizationId: string): string {
  return `org:${organizationId}:telephony`;
}

/**
 * Maps the Supabase subscribe callback status to the three states the console
 * cares about. Anything that is not `SUBSCRIBED` counts as disconnected: the
 * console must poll fast whenever it is not certain messages are arriving.
 */
export function telephonyRealtimeStatusFrom(status: string): TelephonyRealtimeStatus {
  if (status === "SUBSCRIBED") return "connected";
  if (status === "CLOSED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") return "disconnected";
  return "connecting";
}

export const REALTIME_RESUBSCRIBE_MS = { base: 1_000, max: 30_000 } as const;

/** Delay before the channel is re-created after a CLOSED / CHANNEL_ERROR. */
export function realtimeResubscribeDelayMs(consecutiveFailures: number, random?: () => number): number {
  return nextBackoffDelayMs({
    baseMs: REALTIME_RESUBSCRIBE_MS.base,
    consecutiveFailures,
    maxMs: REALTIME_RESUBSCRIBE_MS.max,
    random,
  });
}

type Entry = {
  client: RealtimeClientLike;
  channel: RealtimeChannelLike | null;
  status: TelephonyRealtimeStatus;
  failures: number;
  timer: number | null;
  listeners: Set<TelephonyRealtimeSubscription>;
  seams: Required<Omit<TelephonyRealtimeSeams, "createClient">>;
  closed: boolean;
};

const entries = new Map<string, Entry>();

/**
 * Subscribes to the organisation's telephony topic and returns the
 * unsubscribe. The channel is created on the first subscriber and torn down
 * when the last one leaves.
 */
export function subscribeTelephonyRealtime(input: TelephonyRealtimeSubscription): () => void {
  const topic = telephonyRealtimeTopic(input.organizationId);
  const existing = entries.get(topic);
  const entry = existing ?? createEntry(topic, input.seams ?? {});

  // The listener is registered before the channel opens, so a synchronous
  // SUBSCRIBED (or an immediate failure) cannot be lost.
  entry.listeners.add(input);
  if (!existing) openChannel(topic, entry);
  input.onStatus?.(entry.status);

  return () => {
    entry.listeners.delete(input);
    if (entry.listeners.size > 0) return;
    closeEntry(topic, entry);
  };
}

function createEntry(topic: string, seams: TelephonyRealtimeSeams): Entry {
  const entry: Entry = {
    client: (seams.createClient ?? defaultClient)(),
    channel: null,
    status: "connecting",
    failures: 0,
    timer: null,
    listeners: new Set(),
    seams: {
      setTimer: seams.setTimer ?? ((handler, ms) => window.setTimeout(handler, ms)),
      clearTimer: seams.clearTimer ?? ((id) => window.clearTimeout(id)),
      random: seams.random ?? Math.random,
    },
    closed: false,
  };
  entries.set(topic, entry);
  return entry;
}

/** Test seam: drops every channel (the console never needs this). */
export function resetTelephonyRealtime(): void {
  for (const [topic, entry] of entries) closeEntry(topic, entry);
}

export function telephonyRealtimeStatus(organizationId: string): TelephonyRealtimeStatus | null {
  return entries.get(telephonyRealtimeTopic(organizationId))?.status ?? null;
}

function defaultClient(): RealtimeClientLike {
  // Assignable without a cast: `RealtimeClientLike` is a structural subset of
  // the real client, which is what keeps the tests honest.
  return createSupabaseBrowserClient();
}

function openChannel(topic: string, entry: Entry) {
  if (entry.closed) return;
  setStatus(entry, "connecting");
  const channel = entry.client.channel(topic, { config: { private: true } });
  entry.channel = channel;
  channel
    // A single wildcard handler: every table's INSERT/UPDATE/DELETE means the
    // same thing to the console -- refetch the snapshot.
    .on("broadcast", { event: "*" }, () => {
      if (entry.closed) return;
      for (const listener of entry.listeners) listener.onChange();
    })
    .subscribe((status) => {
      if (entry.closed) return;
      const next = telephonyRealtimeStatusFrom(status);
      setStatus(entry, next);
      if (next === "connected") {
        entry.failures = 0;
        // A reconnect may have missed messages, so the first thing a healthy
        // channel does is ask for the current state.
        for (const listener of entry.listeners) listener.onChange();
        return;
      }
      if (next === "disconnected") scheduleReopen(topic, entry);
    });
}

function scheduleReopen(topic: string, entry: Entry) {
  if (entry.closed || entry.timer !== null) return;
  entry.failures += 1;
  const delay = realtimeResubscribeDelayMs(entry.failures, entry.seams.random);
  entry.timer = entry.seams.setTimer(() => {
    entry.timer = null;
    if (entry.closed || entry.listeners.size === 0) return;
    if (entry.channel) entry.client.removeChannel(entry.channel);
    entry.channel = null;
    openChannel(topic, entry);
  }, delay);
}

function setStatus(entry: Entry, status: TelephonyRealtimeStatus) {
  if (entry.status === status) return;
  entry.status = status;
  for (const listener of entry.listeners) listener.onStatus?.(status);
}

function closeEntry(topic: string, entry: Entry) {
  entry.closed = true;
  if (entry.timer !== null) {
    entry.seams.clearTimer(entry.timer);
    entry.timer = null;
  }
  if (entry.channel) entry.client.removeChannel(entry.channel);
  entry.channel = null;
  entry.listeners.clear();
  entries.delete(topic);
}
