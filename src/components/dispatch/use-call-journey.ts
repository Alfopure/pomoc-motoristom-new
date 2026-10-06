"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { telephonyJson, TELEPHONY_TIMEOUT_MS } from "@/lib/telephony/client-request";
import { createCallJourneyPoller, type CallJourneyResource } from "./call-journey-poller";

type Resource<T> = CallJourneyResource<T> & { url: string };
const available = () => document.visibilityState !== "hidden" && navigator.onLine !== false;

/** View-owned read loop. A denied read removes private data; a failed refresh keeps the last confirmed snapshot. */
export function useCallJourneyResource<T extends { ok: true }>(url: string | null, intervalMs = 5_000, terminalKey?: (data: T) => string | null) {
  const [state, setState] = useState<Resource<T> | null>(null);
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!url) return;
    const poller = createCallJourneyPoller<T>({
      read: signal => telephonyJson<T & { error?: string }>(url, { timeoutMs: TELEPHONY_TIMEOUT_MS.read, label: "priebeh hovoru", signal }),
      onChange: resource => setState({ url, ...resource }),
      canPoll: available,
      intervalMs,
      terminalKey,
    });
    refreshRef.current = poller.refresh;
    document.addEventListener("visibilitychange", poller.availabilityChanged);
    window.addEventListener("online", poller.availabilityChanged);
    window.addEventListener("offline", poller.availabilityChanged);
    return () => {
      poller.stop();
      document.removeEventListener("visibilitychange", poller.availabilityChanged);
      window.removeEventListener("online", poller.availabilityChanged);
      window.removeEventListener("offline", poller.availabilityChanged);
      refreshRef.current = () => {};
    };
  }, [url, intervalMs, terminalKey]);
  const current = state?.url === url ? state : null;
  return { data: current?.data ?? null, error: current?.error ?? null, observedAt: current?.observedAt ?? null, loading: Boolean(url && (!current || current.loading)), settled: current?.settled ?? false, refresh: useCallback(() => refreshRef.current(), []) };
}

export function useCallJourneyClock(enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const tick = () => { if (document.visibilityState !== "hidden") setNow(Date.now()); };
    const timer = setInterval(tick, 1_000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, [enabled]);
  return now;
}
