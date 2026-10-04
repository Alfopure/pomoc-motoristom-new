"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { telephonyJson, TELEPHONY_TIMEOUT_MS, nextBackoffDelayMs } from "@/lib/telephony/client-request";

type Resource<T> = { url: string; data: T | null; error: string | null; observedAt: number | null; loading: boolean };
const visible = () => document.visibilityState !== "hidden";

/** View-owned read loop. A denied read removes private data; a failed refresh keeps the last confirmed snapshot. */
export function useCallJourneyResource<T extends { ok: true }>(url: string | null, intervalMs = 5_000) {
  const [state, setState] = useState<Resource<T> | null>(null);
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!url) return;
    let stopped = false, denied = false, failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    const poll = async () => {
      if (stopped || controller || !visible()) return;
      clearTimeout(timer);
      const active = new AbortController(); controller = active;
      setState(current => current?.url === url ? { ...current, loading: true } : { url, data: null, error: null, observedAt: null, loading: true });
      try {
        const response = await telephonyJson<T & { error?: string }>(url, { timeoutMs: TELEPHONY_TIMEOUT_MS.read, label: "priebeh hovoru", signal: active.signal });
        if (stopped || active.signal.aborted) return;
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          denied = true;
          setState({ url, data: null, error: response.status === 404 ? "Priebeh tohto hovoru nie je dostupný." : "Na zobrazenie tohto hovoru nemáš prístup.", observedAt: null, loading: false });
          return;
        }
        if (!response.ok || response.body?.ok !== true) throw new Error(response.body?.error ?? "Priebeh hovoru sa nepodarilo obnoviť.");
        failures = 0;
        setState({ url, data: response.body, error: null, observedAt: Date.now(), loading: false });
      } catch (error) {
        if (!stopped && !active.signal.aborted) {
          failures++;
          setState(current => ({ url, data: current?.url === url ? current.data : null, observedAt: current?.url === url ? current.observedAt : null, loading: false, error: error instanceof Error ? error.message : "Priebeh hovoru sa nepodarilo obnoviť." }));
        }
      } finally {
        controller = null;
        if (!stopped && !denied && intervalMs > 0 && visible()) timer = setTimeout(poll, nextBackoffDelayMs({ baseMs: intervalMs, maxMs: 30_000, consecutiveFailures: failures }));
      }
    };
    const visibility = () => { clearTimeout(timer); if (document.visibilityState !== "hidden" && !denied) void poll(); };
    refreshRef.current = () => { denied = false; void poll(); };
    document.addEventListener("visibilitychange", visibility);
    void poll();
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); document.removeEventListener("visibilitychange", visibility); refreshRef.current = () => {}; };
  }, [url, intervalMs]);
  const current = state?.url === url ? state : null;
  return { data: current?.data ?? null, error: current?.error ?? null, observedAt: current?.observedAt ?? null, loading: Boolean(url && (!current || current.loading)), refresh: useCallback(() => refreshRef.current(), []) };
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
