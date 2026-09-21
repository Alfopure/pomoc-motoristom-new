"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DRAFT_PREVIEW_READ_MS, parseCaseDraftPreview, type CaseDraftPreview, type CaseDraftPreviewSnapshot } from "@/domain/case-draft-preview";

type PublisherState = "waiting" | "sharing" | "current" | "error" | "unavailable";
export function useCaseDraftPublisher(sessionId: string | null, preview: CaseDraftPreview, enabled: boolean, generation = 0) {
  const [status, setStatus] = useState<PublisherState>("waiting");
  const serialized = JSON.stringify(preview);
  const latest = useRef(serialized), request = useRef<(() => void) | null>(null);
  const sequenceBySession = useRef({ sessionId: "", sequence: 0 });
  useLayoutEffect(() => { latest.current = serialized; request.current?.(); }, [serialized]);
  useEffect(() => {
    if (!sessionId || !enabled) return;
    if (sequenceBySession.current.sessionId !== sessionId) sequenceBySession.current = { sessionId, sequence: 0 };
    let disposed = false, halted = false, acknowledged = "", failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined;
    const visible = () => !disposed && !halted && document.visibilityState === "visible" && navigator.onLine;
    const schedule = (delay = 700) => {
      if (!visible() || controller || timer || latest.current === acknowledged) return;
      timer = setTimeout(() => { timer = undefined; void publish(); }, delay);
    };
    const publish = async () => {
      if (!visible() || controller || latest.current === acknowledged) return;
      const value = latest.current;
      try { parseCaseDraftPreview(JSON.parse(value)); }
      catch { setStatus("error"); return; }
      const current = new AbortController(); controller = current;
      const timeout = setTimeout(() => current.abort(), 8_000);
      setStatus("sharing");
      try {
        const response = await fetch(`/api/cases/drafts/${sessionId}`, { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sequence: ++sequenceBySession.current.sequence, preview: JSON.parse(value) }), signal: current.signal });
        const data = await response.json();
        if (disposed || controller !== current) return;
        if (!response.ok) {
          if ([401, 403, 404, 410].includes(response.status)) halted = true;
          throw new Error("Náhľad sa nepodarilo zdieľať.");
        }
        if (data.available !== true) { halted = true; setStatus("unavailable"); return; }
        acknowledged = value; failures = 0; setStatus("current");
      } catch {
        if (disposed || controller !== current) return;
        failures++; setStatus("error");
      } finally {
        clearTimeout(timeout);
        if (controller === current) { controller = undefined; schedule(failures ? Math.min(15_000, failures * 3_000) : 700); }
      }
    };
    const wake = () => { if (visible()) schedule(); };
    const hide = () => { if (!visible()) { clearTimeout(timer); timer = undefined; } else wake(); };
    request.current = wake; schedule();
    document.addEventListener("visibilitychange", hide); window.addEventListener("online", wake); window.addEventListener("offline", hide);
    return () => {
      disposed = true; clearTimeout(timer); controller?.abort(); request.current = null;
      document.removeEventListener("visibilitychange", hide); window.removeEventListener("online", wake); window.removeEventListener("offline", hide);
    };
  }, [sessionId, enabled, generation]);
  return enabled && sessionId ? status : "waiting";
}

export function useCaseDraftPreview(sessionId: string, enabled: boolean) {
  const [snapshot, setSnapshot] = useState<CaseDraftPreviewSnapshot | null>(null);
  const [message, setMessage] = useState("Načítavam rozpracovaný prípad…");
  const [updating, setUpdating] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false, halted = false, failures = 0, generation = 0, lastSequence = -1;
    let timer: ReturnType<typeof setTimeout> | undefined, lease: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined;
    const visible = () => !disposed && !halted && document.visibilityState === "visible" && navigator.onLine;
    const clear = (text: string) => { setSnapshot(null); setMessage(text); };
    const schedule = (delay: number) => {
      clearTimeout(timer); timer = undefined;
      if (visible()) timer = setTimeout(() => { timer = undefined; void read(); }, delay);
    };
    const read = async () => {
      if (!visible() || controller) return;
      const id = ++generation, current = new AbortController(); controller = current;
      const timeout = setTimeout(() => current.abort(), 8_000); setUpdating(true);
      try {
        const response = await fetch(`/api/cases/drafts/${sessionId}`, { cache: "no-store", credentials: "same-origin", signal: current.signal });
        const data = await response.json() as CaseDraftPreviewSnapshot;
        if (disposed || id !== generation) return;
        if (!response.ok) {
          if ([401, 403, 404, 410].includes(response.status)) {
            halted = true; clear([404, 410].includes(response.status) ? "Tento návrh už nie je otvorený. Uložený prípad nájdeš v zozname prípadov." : "Prístup k návrhu už nie je dostupný.");
            return;
          }
          throw new Error();
        }
        if (data.available !== true) { halted = true; clear("Živý náhľad zatiaľ nie je dostupný."); return; }
        const expires = Date.parse(data.expiresAt);
        if (!Number.isSafeInteger(data.sequence) || data.sequence < 0 || !Number.isFinite(expires) || expires <= Date.now()) throw new Error();
        if (data.preview) parseCaseDraftPreview(data.preview);
        // An expired session can be renewed before its author republishes. An
        // authoritative empty snapshot must clear the old personal content.
        if (data.sequence === 0 && data.preview === null || data.sequence >= lastSequence) { lastSequence = data.sequence; setSnapshot(data); }
        setMessage(data.preview ? "Priebežný náhľad · údaje ešte nie sú uložené" : "Čakám na prvé vyplnené údaje…"); failures = 0;
        clearTimeout(lease);
        lease = setTimeout(() => { if (!disposed) clear("Spojenie sa nepodarilo overiť. Čakám na aktuálny náhľad…"); }, Math.min(15_000, expires - Date.now()));
      } catch {
        if (disposed || id !== generation) return;
        failures++; setMessage("Čakám na spojenie · posledný načítaný náhľad");
      } finally {
        clearTimeout(timeout);
        if (!disposed && id === generation) { controller = undefined; setUpdating(false); schedule(failures ? Math.min(15_000, failures * 3_000) : DRAFT_PREVIEW_READ_MS); }
      }
    };
    const hide = () => {
      generation++; clearTimeout(timer); clearTimeout(lease); controller?.abort(); controller = undefined;
      setUpdating(false); clear("Čakám na aktuálny náhľad…");
    };
    const resume = () => { if (!visible()) hide(); else if (!controller) schedule(150); };
    resume(); document.addEventListener("visibilitychange", resume); window.addEventListener("focus", resume); window.addEventListener("online", resume); window.addEventListener("offline", resume);
    return () => {
      disposed = true; generation++; clearTimeout(timer); clearTimeout(lease); controller?.abort();
      document.removeEventListener("visibilitychange", resume); window.removeEventListener("focus", resume); window.removeEventListener("online", resume); window.removeEventListener("offline", resume);
    };
  }, [sessionId, enabled]);
  return { snapshot: enabled ? snapshot : null, message, updating: enabled && updating };
}
