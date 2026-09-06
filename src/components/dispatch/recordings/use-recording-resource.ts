"use client";

import { useCallback, useEffect, useState } from "react";
import { recordingRequest } from "./recording-client";

/** Private data is scoped to one call; a denied refresh clears its content. */
export function useRecordingResource<T>(url: string | null) {
  const [request, setRequest] = useState(0);
  const [result, setResult] = useState<{ url: string; request: number; data: T | null; error: unknown } | null>(null);
  const refresh = useCallback(() => setRequest((current) => current + 1), []);
  const replace = useCallback((data: T) => {
    if (url) setResult((current) => current?.url === url && current.request > request ? current : { url, request, data, error: null });
  }, [url, request]);

  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    void recordingRequest<T>(url, { signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted) setResult({ url, request, data, error: null });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setResult({ url, request, data: null, error });
    });
    return () => controller.abort();
  }, [url, request]);

  // Returning rechecks permissions without discarding an in-progress review.
  // URL changes and denied reads still remove the previous private content.
  useEffect(() => {
    if (!url) return;
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [url, refresh]);

  const current = result?.url === url ? result : null;
  return { data: current?.data ?? null, error: current?.error ?? null, loading: Boolean(url && (!current || current.request !== request)), refresh, replace };
}
