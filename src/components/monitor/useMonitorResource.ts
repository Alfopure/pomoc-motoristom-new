"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type MonitorResource<T> = { data: T | null; loading: boolean; error: string | null; observedAt: number | null; denied: boolean; refresh: () => void };
const visible = () => document.visibilityState !== "hidden";
/** One bounded read per interval while visible. A hidden tab owns no poll timer. */
export function useMonitorResource<T>(url: string | null, intervalMs = 60_000, minimumAttemptMs = 0): MonitorResource<T> {
  const [state, setState] = useState<Omit<MonitorResource<T>, "refresh">>({ data: null, loading: false, error: null, observedAt: null, denied: false });
  const refreshRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!url) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    let lastAttempt = -Infinity;
    const poll = async () => {
      if (stopped || controller || !visible() || Date.now() - lastAttempt < minimumAttemptMs) return;
      clearTimeout(timer);
      lastAttempt = Date.now();
      const active = new AbortController(); controller = active;
      const deadline = setTimeout(() => active.abort(), 8_000);
      setState(current => ({ ...current, loading: true }));
      try {
        const response = await fetch(url, { cache: "no-store", credentials: "same-origin", signal: active.signal });
        if (response.status === 401 || response.status === 403) {
          if (!stopped) setState({ data: null, loading: false, observedAt: null, denied: true, error: "Prístup k diagnostike nie je dostupný. Prihláste sa účtom manažéra alebo administrátora." });
          return;
        }
        if (!response.ok) throw new Error("read_failed");
        const data: unknown = await response.json();
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid_response");
        if (!stopped && !active.signal.aborted) setState({ data: data as T, loading: false, observedAt: Date.now(), denied: false, error: null });
      } catch {
        if (!stopped) setState(current => ({ ...current, loading: false, error: "Obnovenie sa nepodarilo. Posledné údaje nemusia byť aktuálne." }));
      } finally {
        clearTimeout(deadline); controller = null;
        if (!stopped && intervalMs > 0 && visible()) timer = setTimeout(poll, intervalMs);
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (document.visibilityState === "hidden") return;
      if (Date.now() - lastAttempt >= intervalMs) void poll();
      else if (intervalMs > 0) timer = setTimeout(poll, Math.max(0, intervalMs - (Date.now() - lastAttempt)));
    };
    refreshRef.current = () => { void poll(); };
    document.addEventListener("visibilitychange", visibility);
    void poll();
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); document.removeEventListener("visibilitychange", visibility); refreshRef.current = () => {}; };
  }, [url, intervalMs, minimumAttemptMs]);
  return { ...state, refresh: useCallback(() => refreshRef.current(), []) };
}

export function useMonitorClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => { if (document.visibilityState !== "hidden") setNow(Date.now()); };
    const timer = setInterval(tick, 15_000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, []);
  return now;
}
