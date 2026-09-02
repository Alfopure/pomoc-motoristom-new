"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from "react";
import { FilePlus2, FolderOpen, GripHorizontal, Hash, Loader2, Mic, MicOff, PhoneCall, PhoneForwarded, PhoneOff } from "lucide-react";
import type { TelephonyTransferTransport } from "@/lib/telephony/call-control";
import type { TelephonyRedirectDestination } from "@/lib/telephony/commands";
import type { BrowserWebphoneCallStatus, BrowserWebphoneMode, BrowserWebphoneRegistrationStatus } from "@/lib/telephony/webphone-client";
import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";
import { CallTransferPicker } from "./CallTransferPicker";

export function RemoteAudio({ audioRef }: { audioRef: RefObject<HTMLAudioElement | null> }) {
  return <audio ref={audioRef} autoPlay className="hidden" />;
}

export function describePhoneState(
  registration: BrowserWebphoneRegistrationStatus,
  call: BrowserWebphoneCallStatus,
  mode: BrowserWebphoneMode,
): { label: string; dot: string; pulse: boolean } {
  if (call === "incoming") return { label: "Prichádzajúci hovor", dot: "bg-amber-500", pulse: true };
  if (call === "outgoing") return { label: "Vytáčam…", dot: "bg-amber-500", pulse: true };
  if (call === "in_call") return { label: "Hovor prebieha", dot: "bg-emerald-500", pulse: false };
  if (registration === "registered") return { label: mode === "mock" ? "Pripravený (test)" : "Pripravený volať", dot: "bg-emerald-500", pulse: false };
  if (registration === "connecting") return { label: "Pripájam…", dot: "bg-zinc-400", pulse: true };
  if (registration === "disconnecting") return { label: "Odpájam…", dot: "bg-zinc-400", pulse: true };
  if (registration === "failed") return { label: "Pripojenie zlyhalo", dot: "bg-red-500", pulse: false };
  return { label: "Vypnuté", dot: "bg-zinc-300", pulse: false };
}

export function formatDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

type FloatingPanelPosition = { left: number; top: number };

export function clampFloatingPanelPosition(
  position: FloatingPanelPosition,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
): FloatingPanelPosition {
  const margin = 8;
  return {
    left: Math.max(margin, Math.min(position.left, Math.max(margin, viewport.width - panel.width - margin))),
    top: Math.max(margin, Math.min(position.top, Math.max(margin, viewport.height - panel.height - margin))),
  };
}

/** A shared mouse/touch drag controller for both ringing and active-call UI. */
export function useDraggableFloatingPanel(storageKey: string) {
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
  const positionRef = useRef<FloatingPanelPosition | null>(null);
  const [position, setPositionState] = useState<FloatingPanelPosition | null>(null);

  const setPosition = useCallback((next: FloatingPanelPosition | null) => {
    positionRef.current = next;
    setPositionState(next);
  }, []);

  const clampCurrentPosition = useCallback(() => {
    const panel = panelRef.current;
    const current = positionRef.current;
    if (!panel || !current || window.innerWidth < 640) return;
    const rect = panel.getBoundingClientRect();
    const next = clampFloatingPanelPosition(
      current,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    if (next.left !== current.left || next.top !== current.top) setPosition(next);
  }, [setPosition]);

  useEffect(() => {
    if (window.innerWidth < 640) return;
    try {
      const stored = JSON.parse(window.sessionStorage.getItem(storageKey) ?? "null") as Partial<FloatingPanelPosition> | null;
      if (Number.isFinite(stored?.left) && Number.isFinite(stored?.top)) {
        window.requestAnimationFrame(() => {
          setPosition({ left: Number(stored?.left), top: Number(stored?.top) });
          window.requestAnimationFrame(clampCurrentPosition);
        });
      }
    } catch {
      // A corrupt optional UI preference must never affect call controls.
    }
  }, [clampCurrentPosition, setPosition, storageKey]);

  useEffect(() => {
    const panel = panelRef.current;
    window.addEventListener("resize", clampCurrentPosition);
    const observer = panel && typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(clampCurrentPosition)
      : null;
    if (panel && observer) observer.observe(panel);
    return () => {
      window.removeEventListener("resize", clampCurrentPosition);
      observer?.disconnect();
    };
  }, [clampCurrentPosition]);

  function onPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (window.innerWidth < 640 || event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button, a, input, select, textarea")) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPosition({ left: rect.left, top: rect.top });
    event.preventDefault();
  }

  function onPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    const panel = panelRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !panel) return;
    const rect = panel.getBoundingClientRect();
    setPosition(clampFloatingPanelPosition(
      { left: event.clientX - drag.offsetX, top: event.clientY - drag.offsetY },
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    ));
  }

  function onPointerEnd(event: ReactPointerEvent<HTMLElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    try {
      if (positionRef.current) window.sessionStorage.setItem(storageKey, JSON.stringify(positionRef.current));
    } catch {
      // Persisting the optional position is best-effort only.
    }
  }

  const style: CSSProperties | undefined = position
    ? { left: position.left, top: position.top, right: "auto", bottom: "auto" }
    : undefined;
  return {
    panelRef,
    style,
    dragHandleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
      title: "Potiahnutím presuň telefonické okno",
    },
  };
}

export function ActiveCallBar({
  callId,
  caseLabel,
  direction,
  label,
  partyName,
  partyNumber,
  inCall,
  isMuted,
  onToggleMute,
  onHangup,
  onLocalHangup,
  onDtmf,
  onRedirect,
  transferTransport,
  onNewCase,
  onOpenCase,
  avoidRightRail = false,
}: {
  callId?: string;
  caseLabel?: string;
  direction?: "inbound" | "internal" | "outbound" | null;
  label: string;
  partyName?: string;
  partyNumber?: string;
  inCall: boolean;
  isMuted: boolean;
  onToggleMute?: () => void;
  onHangup: () => void | Promise<void>;
  /**
   * Ends only this browser's SIP dialog. Offered as a last resort after a
   * provider hangup fails, and only for calls with no queue behind them.
   */
  onLocalHangup?: () => void | Promise<void>;
  onDtmf?: (tone: string) => void;
  onRedirect?: (destination: TelephonyRedirectDestination) => Promise<boolean>;
  /** How a transfer would be delivered; decides when it can be offered. */
  transferTransport?: TelephonyTransferTransport;
  onNewCase?: () => void;
  onOpenCase?: () => void;
  avoidRightRail?: boolean;
}) {
  const [showKeypad, setShowKeypad] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [hangupPending, setHangupPending] = useState(false);
  const [hangupError, setHangupError] = useState<string | null>(null);
  const [localHangupArmed, setLocalHangupArmed] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const {
    panelRef: floatingPanelRef,
    style: floatingPanelStyle,
    dragHandleProps: floatingPanelDragHandleProps,
  } = useDraggableFloatingPanel("motorist-active-call-panel-position-v1");
  const dtmfButtons = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];
  const displayNumber = formatPhoneNumberForDisplay(partyNumber);
  const displayParty = partyName?.trim() || displayNumber || "Neznáme číslo";
  const statusLabel = inCall
    ? direction === "outbound" ? "Odchádzajúci hovor" : direction === "inbound" ? "Prichádzajúci hovor" : direction === "internal" ? "Interný hovor" : "Hovor prebieha"
    : direction === "outbound" ? "Volám" : label;

  useEffect(() => {
    if (!inCall) {
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 250);
    return () => window.clearInterval(timer);
  }, [inCall]);

  async function submitHangup() {
    if (hangupPending) return;
    setHangupPending(true);
    setHangupError(null);
    setLocalHangupArmed(false);
    try {
      await onHangup();
    } catch (error) {
      setHangupError(error instanceof Error ? error.message : "Hovor sa nepodarilo ukončiť.");
    } finally {
      setHangupPending(false);
    }
  }

  async function submitLocalHangup() {
    if (!onLocalHangup || hangupPending) return;
    if (!localHangupArmed) {
      setLocalHangupArmed(true);
      return;
    }
    setHangupPending(true);
    try {
      await onLocalHangup();
      setHangupError(null);
      setLocalHangupArmed(false);
    } catch (error) {
      setHangupError(error instanceof Error ? error.message : "Hovor sa nepodarilo ukončiť ani lokálne.");
    } finally {
      setHangupPending(false);
    }
  }

  // Why the transfer button is unavailable, so the operator is never left with
  // a silently dead control.
  //
  // The gate depends on the transport, not merely on one existing. A provider
  // redirect moves a caller the PBX still owns and is valid while the call is
  // only ringing, but SIP REFER needs a confirmed dialog: offering it during
  // an early outbound INVITE would fail at the session fence.
  const transferBlockedReason = !onRedirect
    ? "Tento hovor sa z prehliadača prepojiť nedá; skús to z Ústredne."
    : !callId
      ? "Hovor ešte čaká na zápis bezpečnej identity vo VIPTel."
      : transferTransport === "browser_sip_refer" && !inCall
        ? "Prepojiť môžeš až po spojení hovoru. Zatiaľ ho môžeš zrušiť."
        : null;
  const transferAvailable = !transferBlockedReason;

  return (
    <div ref={floatingPanelRef} style={floatingPanelStyle} className={`fixed inset-x-2 bottom-[calc(78px+env(safe-area-inset-bottom))] z-[2147483400] sm:left-auto sm:right-4 sm:bottom-4 sm:w-[min(420px,calc(100vw-32px))] ${avoidRightRail ? "xl:right-[346px]" : ""}`}>
      <div className="max-h-[calc(100dvh-96px)] overflow-y-auto overflow-x-hidden overscroll-contain rounded-2xl border border-white/10 bg-zinc-950 text-white shadow-2xl sm:max-h-[calc(100dvh-32px)]">
        <div {...floatingPanelDragHandleProps} className="flex touch-none select-none items-start gap-3 border-b border-white/10 p-3.5 sm:cursor-move sm:p-4">
          <span className={`mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${inCall ? "bg-emerald-500/20 text-emerald-300" : "bg-amber-500/20 text-amber-300"}`}>
            <PhoneCall size={20} className={inCall ? "" : "motion-safe:animate-pulse"} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wide text-zinc-400">
              <span className={`h-2 w-2 rounded-full ${inCall ? "bg-emerald-400" : "bg-amber-400 motion-safe:animate-pulse"}`} />
              {statusLabel}
            </div>
            <div className="mt-1 break-words text-base font-bold leading-5 text-white">{displayParty}</div>
            {partyName && displayNumber && <div className="mt-0.5 break-all text-sm text-zinc-300">{displayNumber}</div>}
            <div className="mt-1 font-mono text-sm font-semibold tabular-nums text-zinc-300">
              {inCall ? formatDuration(seconds) : label}
            </div>
          </div>
          <GripHorizontal size={18} className="mt-1 hidden shrink-0 text-zinc-500 sm:block" aria-hidden="true" />
        </div>

        {/* Rendered in every state. Previously the grid appeared only once the
            call was connected, so while dialling the operator had a single
            "Zrusit hovor" button and no visible transfer control at all. */}
        <div className="grid grid-cols-4 gap-2 p-3">
          <button
            type="button"
            onClick={onToggleMute}
            disabled={!inCall || !onToggleMute}
            title={inCall ? undefined : "Stlmiť môžeš až po spojení hovoru."}
            aria-label={isMuted ? "Zrušiť stlmenie" : "Stlmiť"}
            className={`flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl px-1 text-center text-[11px] font-semibold leading-tight disabled:cursor-not-allowed disabled:opacity-45 ${isMuted ? "bg-amber-400 text-zinc-950" : "bg-white/10 text-white hover:bg-white/15"}`}
          >
            {isMuted ? <MicOff size={18} /> : <Mic size={18} />}
            {isMuted ? "Zapnúť" : "Stlmiť"}
          </button>
          <button
            type="button"
            disabled={!inCall || !onDtmf}
            title={inCall ? undefined : "Číselník je dostupný až počas spojeného hovoru."}
            onClick={() => {
              setShowKeypad((value) => !value);
              setShowTransfer(false);
            }}
            aria-label="Číselník"
            aria-expanded={showKeypad}
            className={`flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl px-1 text-center text-[11px] font-semibold leading-tight disabled:cursor-not-allowed disabled:opacity-45 ${showKeypad ? "bg-white/20" : "bg-white/10 hover:bg-white/15"}`}
          >
            <Hash size={18} />
            Číselník
          </button>
          <button
            type="button"
            // Transfer is gated on a usable transport, not on "connected".
            // A provider redirect is valid while the call is still ringing.
            disabled={!transferAvailable}
            title={transferBlockedReason ?? undefined}
            onClick={() => {
              setShowTransfer((value) => !value);
              setShowKeypad(false);
            }}
            aria-label="Prepojiť hovor"
            aria-expanded={showTransfer}
            className={`flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl px-1 text-center text-[11px] font-semibold leading-tight disabled:cursor-not-allowed disabled:opacity-45 ${showTransfer ? "bg-amber-400 text-zinc-950" : "bg-white/10 hover:bg-white/15"}`}
          >
            <PhoneForwarded size={18} />
            Prepojiť
          </button>
          <button
            type="button"
            onClick={() => void submitHangup()}
            disabled={hangupPending}
            aria-label={hangupPending ? "Ukončujem hovor" : "Zavesiť"}
            className="flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl bg-red-600 px-1 text-center text-[11px] font-semibold leading-tight text-white hover:bg-red-700 disabled:cursor-wait disabled:bg-red-500"
          >
            {hangupPending ? <Loader2 size={18} className="animate-spin" /> : <PhoneOff size={18} />}
            {hangupPending ? "Ukončujem…" : inCall ? "Zavesiť" : "Zrušiť"}
          </button>
        </div>
        <div className="px-3 pb-3">
          <button
            type="button"
            onClick={onOpenCase ?? onNewCase}
            disabled={!onOpenCase && !onNewCase}
            title={onOpenCase
              ? "Otvoriť prípad priradený k tomuto hovoru"
              : onNewCase
                ? "Vytvoriť prípad a priradiť k nemu tento hovor"
                : "Čakám na uloženie hovoru do histórie"}
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-amber-400 px-3 text-sm font-bold text-zinc-950 hover:bg-amber-300 disabled:cursor-wait disabled:bg-white/10 disabled:text-zinc-400"
          >
            {onOpenCase ? <FolderOpen size={17} aria-hidden="true" /> : <FilePlus2 size={17} aria-hidden="true" />}
            {onOpenCase ? caseLabel ?? "Otvoriť priradený prípad" : "Vytvoriť prípad z hovoru"}
          </button>
          {hangupError && (
            <div role="alert" className="mt-2 grid gap-2 rounded-lg bg-red-500/20 px-2.5 py-2 text-xs font-medium text-red-100">
              <span>{hangupError}</span>
              <div className="flex flex-wrap gap-1.5">
                {/* call.hangup is command-idempotent server-side, so retrying
                    cannot double-end the call. */}
                <button
                  type="button"
                  onClick={() => void submitHangup()}
                  disabled={hangupPending}
                  className="rounded-md bg-white/15 px-2 py-1 text-[11px] font-bold text-white hover:bg-white/25 disabled:opacity-50"
                >
                  Skúsiť znova
                </button>
                {transferAvailable && (
                  // For an inbound queue call a local BYE would advance the
                  // still-live caller to the next workstation. Moving the
                  // caller on is the safe alternative, never ending locally.
                  <button
                    type="button"
                    onClick={() => {
                      setShowTransfer(true);
                      setShowKeypad(false);
                    }}
                    className="rounded-md bg-white/15 px-2 py-1 text-[11px] font-bold text-white hover:bg-white/25"
                  >
                    Prepojiť na iné číslo
                  </button>
                )}
                {onLocalHangup && direction !== "inbound" && (
                  // Safe only where no queue sits behind the call: ending the
                  // browser dialog really does end it.
                  <button
                    type="button"
                    onClick={() => void submitLocalHangup()}
                    disabled={hangupPending}
                    className="rounded-md bg-red-500/40 px-2 py-1 text-[11px] font-bold text-white hover:bg-red-500/60 disabled:opacity-50"
                  >
                    {localHangupArmed ? "Naozaj ukončiť len tu?" : "Ukončiť len v prehliadači"}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
        {inCall && showKeypad && onDtmf && (
          <div className="grid grid-cols-3 gap-2 border-t border-white/10 p-3 pt-3">
            {dtmfButtons.map((tone) => (
              <button
                key={tone}
                type="button"
                onClick={() => onDtmf(tone)}
                className="h-10 rounded-lg bg-white/10 text-sm font-semibold text-white hover:bg-white/20"
              >
                {tone}
              </button>
            ))}
          </div>
        )}
        {showTransfer && transferAvailable && callId && onRedirect && (
          <div className="grid gap-3 border-t border-white/10 bg-white/5 p-3">
            <CallTransferPicker
              callId={callId}
              onRedirect={onRedirect}
              onTransferred={() => setShowTransfer(false)}
              tone="dark"
            />
          </div>
        )}
      </div>
    </div>
  );
}
