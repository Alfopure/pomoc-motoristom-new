"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, CircleDashed, LockKeyhole, RefreshCw, TriangleAlert, WifiOff } from "lucide-react";
import { useCaseCollaborationStore } from "./CaseCollaborationProvider";
import { caseSyncPanelPosition, caseSyncPresentation, UNAVAILABLE_CASE_SYNC_SNAPSHOT } from "./case-sync-status";
import styles from "./CaseSyncIndicator.module.css";

const emptySubscribe = () => () => {};
const unavailableSnapshot = () => UNAVAILABLE_CASE_SYNC_SNAPSHOT;
const onlineSnapshot = () => navigator.onLine;
const serverOnlineSnapshot = () => true;
function subscribeOnline(listener: () => void) {
  window.addEventListener("online", listener); window.addEventListener("offline", listener);
  return () => { window.removeEventListener("online", listener); window.removeEventListener("offline", listener); };
}

export function CaseSyncIndicator({ className, topBarsRef }: { className?: string; topBarsRef?: RefObject<HTMLDivElement | null> }) {
  const store = useCaseCollaborationStore();
  const snapshot = useSyncExternalStore(store?.subscribeSync ?? emptySubscribe, store?.getSyncSnapshot ?? unavailableSnapshot, unavailableSnapshot);
  const online = useSyncExternalStore(subscribeOnline, onlineSnapshot, serverOnlineSnapshot);
  const status = caseSyncPresentation(snapshot, online);
  const [mode, setMode] = useState<"hover" | "pinned" | null>(null);
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressFocus = useRef(false);
  const id = useId();
  const open = mode !== null;
  const problem = ["error", "expired", "denied", "offline"].includes(status.kind);
  const Icon = status.kind === "current" ? CheckCircle2 : status.kind === "denied" ? LockKeyhole : status.kind === "offline" ? WifiOff : problem ? TriangleAlert : status.kind === "updating" ? RefreshCw : CircleDashed;
  function cancelClose() { if (closeTimer.current) clearTimeout(closeTimer.current); closeTimer.current = null; }
  function closeHover() { cancelClose(); if (mode === "hover") closeTimer.current = setTimeout(() => setMode(current => current === "hover" ? null : current), 120); }
  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current) return;
      const viewport = window.visualViewport;
      const width = viewport?.width ?? window.innerWidth;
      const next = caseSyncPanelPosition(trigger.current.getBoundingClientRect(), {
        left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0, width,
        height: viewport?.height ?? window.innerHeight, bottomInset: window.innerWidth < 1024 ? 72 : 0,
      }, topBarsRef?.current?.getBoundingClientRect().bottom ?? 0);
      if (!next) { setMode(null); setPosition(null); return; }
      setPosition(current => current && current.top === next.top && current.left === next.left && current.width === next.width && current.maxHeight === next.maxHeight ? current : next);
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) setMode(null);
      // Never consume the click or move focus: phone controls retain their original gesture.
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const restoreFocus = event.target instanceof Node && (trigger.current?.contains(event.target) || panel.current?.contains(event.target));
      setMode(null);
      if (restoreFocus) { suppressFocus.current = true; trigger.current?.focus({ preventScroll: true }); suppressFocus.current = false; }
    };
    const visibility = () => { if (document.visibilityState !== "visible") setMode(null); };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    if (topBarsRef?.current) observer?.observe(topBarsRef.current);
    if (trigger.current) observer?.observe(trigger.current);
    place();
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place); window.visualViewport?.addEventListener("scroll", place);
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape); document.addEventListener("visibilitychange", visibility);
    return () => {
      observer?.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place); window.visualViewport?.removeEventListener("scroll", place);
      document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); document.removeEventListener("visibilitychange", visibility);
    };
  }, [open, topBarsRef]);

  // A polite announcement changes only on a problem/recovery, never on each periodic read.
  const announcement = problem ? status.label : snapshot.lastVerifiedAt !== null ? "Prípady a upozornenia boli úspešne overené." : "";
  return <>
    <button ref={trigger} type="button" className={`${styles.trigger} ${className ?? ""}`} data-state={status.kind}
      aria-label={`Stav aktualizácií: ${status.label}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      aria-describedby={mode === "hover" ? id : undefined}
      onPointerEnter={event => { if (event.pointerType === "mouse") { cancelClose(); setMode(current => current ?? "hover"); } }}
      onPointerLeave={closeHover}
      onFocus={() => { if (!suppressFocus.current) setMode(current => current ?? "hover"); }}
      onBlur={event => { if (mode === "hover" && !(event.relatedTarget instanceof Node && panel.current?.contains(event.relatedTarget))) setMode(null); }}
      onClick={() => {
        cancelClose(); setMode(current => current === "pinned" ? null : "pinned");
        if (mode !== "pinned") window.requestAnimationFrame(() => panel.current?.focus({ preventScroll: true }));
      }}>
      <Icon size={16} aria-hidden="true" className={status.spinning ? styles.spinning : undefined} />
    </button>
    <span className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    {open && typeof document !== "undefined" && createPortal(<div ref={panel} id={id} tabIndex={mode === "pinned" ? -1 : undefined} role={mode === "pinned" ? "dialog" : "tooltip"}
      aria-label={mode === "pinned" ? "Prípady a upozornenia — stav aktualizácií" : undefined}
      className={styles.panel} data-state={status.kind} style={position ?? { visibility: "hidden" }}
      onPointerEnter={cancelClose} onPointerLeave={closeHover}
      onBlur={event => { if (mode === "hover" && !(event.relatedTarget instanceof Node && (panel.current?.contains(event.relatedTarget) || trigger.current?.contains(event.relatedTarget)))) setMode(null); }}>
      <strong className={styles.heading}>Prípady a upozornenia</strong>
      <p className={styles.status}><Icon size={16} aria-hidden="true" className={status.spinning ? styles.spinning : undefined} /><span>{status.label}</span></p>
      <p className={styles.verified}>{snapshot.lastVerifiedAt === null ? "Zatiaľ bez úspešného overenia." : <>Posledné overenie o <time dateTime={new Date(snapshot.lastVerifiedAt).toISOString()}>{new Date(snapshot.lastVerifiedAt).toLocaleTimeString("sk-SK", { hour: "2-digit", minute: "2-digit" })}</time></>}</p>
      <p className={styles.detail}>{status.detail}</p>
      {mode === "pinned" && status.retry && store && <button type="button" className={styles.retry} disabled={snapshot.inFlight} onClick={() => store.resume()}>{snapshot.inFlight ? "Overujem…" : "Skúsiť znova"}</button>}
    </div>, document.body)}
  </>;
}
