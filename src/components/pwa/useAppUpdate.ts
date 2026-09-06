"use client";

import { useEffect, useState } from "react";

const CHECK_INTERVAL_MS = 5 * 60_000;
const RESUME_THROTTLE_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;

type AppUpdateEnvironment = {
  window: EventTarget;
  document: EventTarget & { readonly visibilityState: DocumentVisibilityState };
  isOnline: () => boolean;
  fetch: (url: string, init: RequestInit) => Promise<Pick<Response, "ok" | "json">>;
};

/** Discovery only: the caller decides when it is safe to reload the document. */
export function useAppUpdate(loadedVersion: string): boolean {
  // An RSC refresh must not replace the baseline of the JavaScript already
  // running in this document with the version of a newer server response.
  const [documentVersion] = useState(loadedVersion);
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => watchAppUpdates(documentVersion, setUpdateAvailable, {
    window,
    document,
    isOnline: () => navigator.onLine !== false,
    fetch: (url, init) => fetch(url, init),
  }), [documentVersion]);

  return updateAvailable;
}

/** Browser effects are injectable so the network and resume contract is tested without a DOM renderer. */
export function watchAppUpdates(
  loadedVersion: string,
  onChange: (updateAvailable: boolean) => void,
  environment: AppUpdateEnvironment,
): () => void {
  const baseline = validVersion(loadedVersion);
  if (!baseline) return () => {};

  let disposed = false;
  let lastAttempt = -Infinity;
  let lastCheckFailed = false;
  let sawOffline = false;
  let retryAfterOnline = false;
  let pending: { controller: AbortController; timeout: ReturnType<typeof setTimeout> } | null = null;

  async function check() {
    if (disposed) return;
    if (!environment.isOnline()) {
      sawOffline = true;
      return;
    }
    if (environment.document.visibilityState !== "visible" || pending) return;
    if (!retryAfterOnline && Date.now() - lastAttempt < RESUME_THROTTLE_MS) return;

    retryAfterOnline = false;
    lastAttempt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      if (pending?.controller !== controller) return;
      pending = null;
      lastCheckFailed = true;
      controller.abort();
      // An online event may arrive while the old request is still pending.
      if (retryAfterOnline) void check();
    }, REQUEST_TIMEOUT_MS);
    pending = { controller, timeout };

    try {
      const response = await environment.fetch("/api/health/live", {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        mode: "same-origin",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Version check failed");
      const payload: unknown = await response.json();
      if (disposed || controller.signal.aborted || pending?.controller !== controller) return;
      const version = payload && typeof payload === "object" && "status" in payload && payload.status === "live" && "version" in payload
        ? validVersion(payload.version)
        : null;
      if (!version) throw new Error("Unknown application version");
      lastCheckFailed = false;
      sawOffline = false;
      retryAfterOnline = false;
      // Equality, not ordering, also detects a rollback. Returning to the
      // document's original release removes a now-unnecessary update prompt.
      onChange(version !== baseline);
    } catch {
      if (!disposed && pending?.controller === controller) lastCheckFailed = true;
      // Connectivity problems never clear a previously detected update.
    } finally {
      clearTimeout(timeout);
      if (pending?.controller === controller) {
        pending = null;
        if (retryAfterOnline) void check();
      }
    }
  }

  const onResume = () => { void check(); };
  const onOffline = () => { sawOffline = true; };
  const onOnline = () => {
    if (lastCheckFailed || sawOffline) retryAfterOnline = true;
    void check();
  };
  environment.document.addEventListener("visibilitychange", onResume);
  for (const event of ["focus", "pageshow"]) environment.window.addEventListener(event, onResume);
  environment.window.addEventListener("offline", onOffline);
  environment.window.addEventListener("online", onOnline);
  const interval = setInterval(onResume, CHECK_INTERVAL_MS);
  void check();

  return () => {
    disposed = true;
    clearInterval(interval);
    environment.document.removeEventListener("visibilitychange", onResume);
    for (const event of ["focus", "pageshow"]) environment.window.removeEventListener(event, onResume);
    environment.window.removeEventListener("offline", onOffline);
    environment.window.removeEventListener("online", onOnline);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.controller.abort();
      pending = null;
    }
  };
}

function validVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const version = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(version)) return null;
  if (["development", "dev", "local", "unknown", "undefined", "null", "unset"].includes(version.toLowerCase())) return null;
  return version;
}
