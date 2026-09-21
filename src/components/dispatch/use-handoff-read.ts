"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export class HandoffReadError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function readHandoff<T>(url: string, signal: AbortSignal, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store", signal });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new HandoffReadError(data?.error || "Údaje sa nepodarilo načítať.", response.status);
  if (!data) throw new Error("Odpoveď s údajmi sa nepodarilo overiť.");
  return data as T;
}

/** Only handoff reads: commands keep their own receipt, error and idempotency state. */
export function useHandoffRead<T>({ enabled, read, accept, onDenied }: {
  enabled: boolean;
  read: (signal: AbortSignal) => Promise<T>;
  accept: (value: T) => void;
  onDenied: () => void;
}) {
  const [loading, setLoading] = useState(false), [error, setError] = useState(""), [halted, setHalted] = useState(false);
  const callbacks = useRef({ read, accept, onDenied });
  useLayoutEffect(() => { callbacks.current = { read, accept, onDenied }; }, [read, accept, onDenied]);
  const paused = useRef(false), denied = useRef(false);
  const control = useRef<{ cancel: () => void; request: () => void; later: () => void } | null>(null);
  const stop = useCallback((message?: string) => {
    denied.current = true; control.current?.cancel(); setHalted(true);
    if (message) setError(message);
    callbacks.current.onDenied();
  }, []);
  const pause = useCallback(() => { paused.current = true; control.current?.cancel(); }, []);
  const resume = useCallback(() => { paused.current = false; control.current?.later(); }, []);
  const retry = useCallback(() => control.current?.request(), []);
  const isHalted = useCallback(() => denied.current, []);

  useEffect(() => {
    if (!enabled || denied.current) return;
    let disposed = false, generation = 0, failures = 0, lastFinished = -Infinity;
    let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined;
    const visible = () => !disposed && !denied.current && !paused.current && document.visibilityState === "visible" && navigator.onLine;
    const cancel = () => {
      generation += 1;
      clearTimeout(timer); timer = undefined;
      controller?.abort(); controller = undefined;
      if (!disposed) setLoading(false);
    };
    const schedule = (delay: number) => {
      clearTimeout(timer); timer = undefined;
      if (visible()) timer = setTimeout(() => { timer = undefined; void run(); }, delay);
    };
    const later = () => schedule(failures ? Math.min(120_000, failures * 60_000) : 30_000 + Math.floor(Math.random() * 3001));
    const run = async () => {
      if (!visible() || controller) return;
      const current = ++generation;
      const request = new AbortController(); controller = request;
      const timeout = setTimeout(() => request.abort(new DOMException("Načítanie trvalo príliš dlho.", "TimeoutError")), 20_000);
      setLoading(true);
      try {
        const value = await callbacks.current.read(request.signal);
        if (disposed || current !== generation || request.signal.aborted) return;
        callbacks.current.accept(value); failures = 0; setError("");
      } catch (caught) {
        if (disposed || current !== generation) return;
        failures += 1;
        const message = caught instanceof Error ? caught.message : "Údaje sa nepodarilo načítať.";
        if (caught instanceof HandoffReadError && [401, 403, 404, 410].includes(caught.status)) stop(message);
        else setError(message);
      } finally {
        clearTimeout(timeout);
        if (!disposed && current === generation) {
          controller = undefined; lastFinished = Date.now(); setLoading(false); later();
        }
      }
    };
    // A focus/online/visibility burst becomes one read, including an already running read.
    const request = () => {
      if (!visible()) { cancel(); return; }
      if (controller) return;
      // Hiding cancels the next poll. A quick return must re-arm it even during
      // the cooldown, otherwise there may be no future read until another focus.
      schedule(Math.max(200, 500 - (Date.now() - lastFinished)));
    };
    const onVisibility = () => { if (document.visibilityState !== "visible") cancel(); else request(); };
    control.current = { cancel, request, later };
    request();
    window.addEventListener("focus", request); window.addEventListener("online", request);
    window.addEventListener("offline", cancel); document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancel(); disposed = true; control.current = null;
      window.removeEventListener("focus", request); window.removeEventListener("online", request);
      window.removeEventListener("offline", cancel); document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, stop]);
  return { loading, error, halted, isHalted, retry, pause, resume, stop };
}
