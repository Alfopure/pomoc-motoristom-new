"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { activeCaseEditors, EDITOR_HEARTBEAT_MS, EDITOR_TTL_MS } from "@/domain/case-collaboration";
import type { DispatchCase, DispatchNotification } from "@/domain/types";
import { CaseCollaborationStore, type CaseCollaborationState } from "./case-collaboration-store";
import { CaseDraftPreviewItem } from "./CaseDraftPreview";

type ContextValue = { store: CaseCollaborationStore; viewerProfileId?: string };
const Context = createContext<ContextValue | null>(null);
type Props = {
  children: ReactNode; actorKey: string; viewerProfileId?: string; enabled: boolean; initialCases: DispatchCase[];
  onCasesChange?: (cases: DispatchCase[]) => void; onNotificationsChange?: (notifications: DispatchNotification[]) => void;
  onStateChange?: (state: Pick<CaseCollaborationState, "available" | "hidden" | "denied" | "stale">) => void;
};
export function CaseCollaborationProvider(props: Props) {
  return <Session key={`${props.actorKey}:${props.enabled}`} {...props} />;
}
function Session({ children, actorKey, viewerProfileId, enabled, initialCases, onCasesChange, onNotificationsChange, onStateChange }: Props) {
  const [store] = useState(() => new CaseCollaborationStore(initialCases));
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const callbacks = useRef({ onCasesChange, onNotificationsChange, onStateChange });
  useEffect(() => { callbacks.current = { onCasesChange, onNotificationsChange, onStateChange }; });
  useEffect(() => { if (enabled) store.acceptCases(initialCases); }, [enabled, initialCases, store]);
  useEffect(() => {
    if (!enabled) return;
    callbacks.current.onStateChange?.({ available: state.available, hidden: state.hidden, denied: state.denied, stale: state.stale });
    if (state.available && !state.hidden) {
      callbacks.current.onCasesChange?.(state.cases);
      callbacks.current.onNotificationsChange?.(state.notifications);
    }
    if (state.denied) { callbacks.current.onCasesChange?.([]); callbacks.current.onNotificationsChange?.([]); }
  }, [enabled, state.available, state.hidden, state.denied, state.stale, state.cases, state.notifications]);
  useEffect(() => {
    if (!enabled) return;
    store.start();
    const resume = () => { store.checkLease(); if (document.visibilityState === "visible") store.resume(); };
    window.addEventListener("focus", resume); window.addEventListener("online", resume); document.addEventListener("visibilitychange", resume);
    let cleanup = () => {};
    try {
      const client = createSupabaseBrowserClient(); const [org, profile] = actorKey.split(":");
      let user: string | undefined;
      const auth = client.auth.onAuthStateChange((event, session) => {
        if (!session || event === "SIGNED_OUT" || (user && session.user.id !== user)) store.revoke();
        if (session?.user.id) user = session.user.id;
      });
      const connected = new Set<string>();
      const topics = [`cases:${org}`, `notifications:${org}:${profile}`];
      const channels = topics.map(topic => client.channel(topic, { config: { private: true } })
        .on("broadcast", { event: "invalidate" }, store.invalidate)
        .on("broadcast", { event: "revoke" }, store.revoke)
        .on("broadcast", { event: "authorize" }, () => { store.checkLease(); store.resume(); })
        .subscribe(status => { if (status === "SUBSCRIBED") connected.add(topic); else connected.delete(topic); store.setConnected(connected.size === topics.length); }));
      let revoked = false;
      const revoke = store.subscribe(() => { if (store.getSnapshot().denied && !revoked) { revoked = true; channels.forEach(channel => void client.removeChannel(channel)); } });
      cleanup = () => { revoke(); auth.data.subscription.unsubscribe(); channels.forEach(channel => void client.removeChannel(channel)); };
    } catch { /* The bounded HTTP fallback remains authoritative. */ }
    return () => { cleanup(); store.stop(); window.removeEventListener("focus", resume); window.removeEventListener("online", resume); document.removeEventListener("visibilitychange", resume); };
  }, [actorKey, enabled, store]);
  return <Context.Provider value={enabled ? { store, viewerProfileId } : null}>{children}</Context.Provider>;
}
const fallback: CaseCollaborationState = { cases: [], notifications: [], editors: [], available: false, hidden: false, denied: false, stale: false, connected: false, authorizedUntil: 0, error: "" };
const emptySubscribe = () => () => {};
/** Status-only consumers subscribe to metadata, not every case snapshot. */
export function useCaseCollaborationStore() { return useContext(Context)?.store ?? null; }
export function useCaseCollaboration() {
  const context = useContext(Context);
  const state = useSyncExternalStore(context?.store.subscribe ?? emptySubscribe, context?.store.getSnapshot ?? (() => fallback), () => fallback);
  return { ...context, state };
}
/** Keep the mounted editor, focus and draft intact while access is rechecked. */
export function CaseAccessBoundary({ children }: { children: ReactNode }) {
  const { state } = useCaseCollaboration();
  return <>{state.hidden && <p role="status" className="p-3 text-sm text-zinc-600">{state.denied ? "Prístup k prípadom už nie je dostupný." : "Overujem prístup k aktuálnym údajom…"}</p>}<div hidden={state.hidden} style={{ display: state.hidden ? "none" : "contents" }}>{children}</div></>;
}
function usePresenceNow() { const [now, setNow] = useState(Date.now); useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(id); }, []); return now; }
export function CaseDraftActivity() {
  const { state, viewerProfileId } = useCaseCollaboration(); const now = usePresenceNow();
  if (state.hidden) return null;
  const drafts = state.editors.filter(entry => !entry.caseId && entry.profileId !== viewerProfileId && Date.parse(entry.expiresAt) > now);
  return drafts.length ? <div className="space-y-1 border-b border-sky-200 bg-sky-50 p-2" aria-label="Rozpracované nové prípady">
    {drafts.map(entry => <CaseDraftPreviewItem key={entry.sessionId} editor={entry} />)}
  </div> : null;
}
export function CaseEditorActivity({ caseId }: { caseId: string }) {
  const { state, viewerProfileId } = useCaseCollaboration(); const now = usePresenceNow();
  const editors = state.hidden ? [] : activeCaseEditors(state.editors, now, caseId, viewerProfileId);
  return editors.length ? <div role="status" className="flex flex-wrap items-center gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900"><span className="size-2 rounded-full bg-sky-500 motion-safe:animate-pulse" aria-hidden="true"/>Upravuje: {editors.map(entry => entry.displayName).join(", ")}</div> : null;
}
export function useCaseEditorPresence(caseId: string | null, active = true) {
  const { store, state } = useCaseCollaboration();
  const session = useRef<string | null>(null);
  const [readySessionId, setReadySessionId] = useState<string | null>(null);
  const [readyGeneration, setReadyGeneration] = useState(0);
  const heartbeatRequest = useRef<(() => void) | null>(null);
  const [resumeSession, setResumeSession] = useState(0);
  const latest = useRef({ state, active });
  useEffect(() => { latest.current = { state, active }; }, [state, active]);
  const stop = useCallback(() => {
    const sessionId = session.current; session.current = null;
    setReadySessionId(null);
    if (sessionId) void fetch("/api/cases/presence", { method: "POST", keepalive: true, credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "leave", sessionId, caseId }) }).catch(() => {});
    store?.invalidate();
  }, [caseId, store]);
  useEffect(() => {
    if (!store || !state.available || state.denied || !active) return;
    const sessionId = crypto.randomUUID(); session.current = sessionId;
    let running = false; let stopped = false; let acknowledgedUntil = 0;
    const heartbeat = async () => {
      if (stopped || running || session.current !== sessionId || latest.current.state.hidden || document.visibilityState !== "visible" || !navigator.onLine) return;
      if (acknowledgedUntil && Date.now() >= acknowledgedUntil) setReadySessionId(null);
      running = true;
      try {
        const response = await fetch("/api/cases/presence", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "heartbeat", sessionId, caseId }), signal: AbortSignal.timeout(8000) });
        if (response.status === 401 || response.status === 403) store.revoke();
        if (response.ok) {
          const result = await response.json();
          if (!stopped && session.current === sessionId) {
            const ready = document.visibilityState === "visible" && navigator.onLine && result.available === true && !result.ended;
            // A suspended visible tab may miss every browser lifecycle event.
            // Renewing an expired server session clears its old preview; use a
            // generation so even batched state updates force republication.
            if (ready && !caseId && acknowledgedUntil && Date.now() >= acknowledgedUntil) setReadyGeneration(value => value + 1);
            if (ready) acknowledgedUntil = Number.isFinite(Date.parse(result.expiresAt)) ? Date.parse(result.expiresAt) : Date.now() + EDITOR_TTL_MS;
            setReadySessionId(ready ? sessionId : null);
          }
        } else if (!stopped && session.current === sessionId) setReadySessionId(null);
      } catch {
        // Do not publish to a session whose heartbeat was not acknowledged.
        if (!stopped && session.current === sessionId) setReadySessionId(null);
      }
      finally { running = false; }
    };
    heartbeatRequest.current = () => void heartbeat();
    void heartbeat(); const timer = window.setInterval(() => void heartbeat(), EDITOR_HEARTBEAT_MS);
    const leave = () => stop();
    const resume = () => { if (!session.current && document.visibilityState === "visible") setResumeSession(value => value + 1); };
    const visibility = () => {
      if (caseId) { if (document.visibilityState === "visible") resume(); else leave(); }
      else {
        // A draft still exists while hidden, but content is shared only after a
        // fresh heartbeat has acknowledged its session on return.
        setReadySessionId(null);
        if (document.visibilityState === "visible") void heartbeat();
      }
    };
    const reconnect = () => { if (!caseId) { setReadySessionId(null); void heartbeat(); } };
    const disconnect = () => { if (!caseId) setReadySessionId(null); };
    // Existing editors describe visible work; a new draft still describes its existence.
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", reconnect); window.addEventListener("offline", disconnect);
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", resume);
    return () => { stopped = true; heartbeatRequest.current = null; window.clearInterval(timer); window.removeEventListener("pagehide", leave); window.removeEventListener("pageshow", resume); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("online", reconnect); window.removeEventListener("offline", disconnect); stop(); };
  }, [active, caseId, state.available, state.denied, stop, store, resumeSession]);
  useEffect(() => {
    // On reconnect the collaboration ACL read may finish after the online
    // event. A newly authorized draft should not wait for the next interval.
    if (!caseId && !state.hidden) heartbeatRequest.current?.();
  }, [caseId, state.hidden]);
  return { sessionId: () => session.current, readySessionId, readyGeneration, stop };
}
