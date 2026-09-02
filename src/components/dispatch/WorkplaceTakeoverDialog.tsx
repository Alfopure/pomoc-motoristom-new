"use client";

import { useEffect, useRef, useState } from "react";
import { Armchair, Clock3, Loader2, RefreshCw, X } from "lucide-react";

import type { WorkplaceTakeoverRequest } from "@/lib/telephony/workplace-takeover";

/**
 * How long past the decision deadline we keep claiming the handover is simply
 * "in progress". After this the server has demonstrably not advanced the
 * request, and the operator is told so and given their app back.
 */
export const WORKPLACE_TAKEOVER_STALL_GRACE_MS = 15_000;

export function WorkplaceTakeoverDialog({
  error,
  onAccept,
  onDecline,
  onRefresh,
  pending,
  request,
}: {
  error: string | null;
  onAccept: () => void;
  onDecline: () => void;
  onRefresh?: () => void;
  pending: "accept" | "decline" | null;
  request?: WorkplaceTakeoverRequest;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [hidden, setHidden] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const acceptRef = useRef<HTMLButtonElement>(null);
  const declineRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!request) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [request]);

  useEffect(() => {
    if (!request || hidden) return;
    if (error) errorRef.current?.focus();
    else if (request.status === "accepted") dialogRef.current?.focus();
    else declineRef.current?.focus();
  }, [error, hidden, request]);

  const active = Boolean(request) &&
    (request?.status === "pending" || request?.status === "accepted") &&
    !hidden;

  useEffect(() => {
    // Bound the scroll lock to the *visible* overlay, not to the request.
    // Tying it to the request left the page unscrollable after the dialog
    // stopped rendering any controls.
    if (!active) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [active]);

  if (!request || (request.status !== "pending" && request.status !== "accepted")) return null;

  const accepted = request.status === "accepted";
  const deadline = accepted ? request.handoffExpiresAt : request.expiresAt;
  const secondsLeft = Math.max(0, Math.ceil((Date.parse(deadline ?? request.expiresAt) - now) / 1_000));
  const decisionElapsed = !accepted && secondsLeft <= 0;
  // The server has had the decision window plus a grace period to advance a
  // pending request. Past that we stop pretending a handover is under way.
  const stalled = decisionElapsed &&
    now - Date.parse(request.expiresAt) > WORKPLACE_TAKEOVER_STALL_GRACE_MS;
  if (accepted && secondsLeft <= 0) return null;

  if (hidden) {
    return (
      <div className="fixed inset-x-0 bottom-0 z-[2147483640] flex justify-center p-3 sm:bottom-4">
        <div
          role="status"
          className="flex max-w-lg items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-semibold text-amber-950 shadow-lg"
        >
          <Armchair size={17} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            {request.requesterName} preberá pracovisko {request.extension}.
          </span>
          <button
            type="button"
            onClick={() => setHidden(false)}
            className="shrink-0 rounded-lg bg-zinc-950 px-3 py-1.5 text-xs font-bold text-white outline-none hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-yellow-400"
          >
            Zobraziť žiadosť
          </button>
        </div>
      </div>
    );
  }

  function keepFocus(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setHidden(true);
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? []);
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current || document.activeElement === errorRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="fixed inset-0 z-[2147483640] grid place-items-center bg-zinc-950/65 p-3 backdrop-blur-[2px] sm:p-4"
      onMouseDown={(event) => {
        // Dismissing only hides the overlay. It never cancels the server-side
        // handover, which keeps running and stays visible as a footer chip.
        if (event.target === event.currentTarget) setHidden(true);
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="takeover-request-title"
        aria-describedby="takeover-request-description"
        aria-busy={Boolean(pending)}
        tabIndex={-1}
        onKeyDown={keepFocus}
        className="max-h-[calc(100dvh-1.5rem)] w-full max-w-lg overflow-y-auto overscroll-contain rounded-2xl border border-zinc-200 bg-white shadow-2xl outline-none"
      >
        <div className={`border-b px-5 py-4 ${stalled ? "border-red-200 bg-red-50" : "border-yellow-200 bg-yellow-50"}`}>
          <div className="flex items-start gap-3">
            <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${stalled ? "bg-red-200 text-red-950" : "bg-yellow-200 text-yellow-950"}`}>
              <Armchair size={21} aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h2 id="takeover-request-title" className="text-pretty text-xl font-black leading-6 text-zinc-950">
                  {accepted
                    ? "Pracovisko sa bezpečne odovzdáva"
                    : stalled
                      ? "Server nepotvrdil odovzdanie"
                      : decisionElapsed ? "Spúšťam odovzdanie pracoviska" : "Chceš zostať na tomto pracovisku?"}
                </h2>
                {!accepted && !stalled && <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-amber-300 bg-white px-3 py-1.5 text-sm font-black tabular-nums text-amber-900">
                  <Clock3 size={15} aria-hidden="true" /> {secondsLeft} s
                </span>}
                <button
                  type="button"
                  aria-label="Skryť a pracovať ďalej"
                  onClick={() => setHidden(true)}
                  className="shrink-0 rounded-lg p-1.5 text-zinc-500 outline-none hover:bg-white/70 hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-yellow-400"
                >
                  <X size={18} aria-hidden="true" />
                </button>
              </div>
              <p id="takeover-request-description" className="mt-1 text-sm leading-5 text-zinc-700">
                {accepted
                  ? request.acceptedBy === "timeout"
                    ? `Čas na odmietnutie uplynul. Pracovisko ${request.extension} odovzdávame používateľovi ${request.requesterName}.`
                    : `Pracovisko ${request.extension} odovzdávame používateľovi ${request.requesterName}.`
                  : stalled
                    ? `Odovzdanie pracoviska ${request.extension} používateľovi ${request.requesterName} sa nepotvrdilo. Môžeš pracovať ďalej; hovory prijímaš normálne.`
                    : decisionElapsed
                      ? `Pracovisko ${request.extension} teraz bezpečne odovzdávame používateľovi ${request.requesterName}.`
                      : `${request.requesterName} chce prevziať pracovisko ${request.extension}, ktoré teraz používaš.`}
              </p>
            </div>
          </div>
        </div>

        <div className="px-5 py-4">
          <div className={`rounded-xl border px-4 py-3 text-sm font-semibold leading-5 ${
            stalled
              ? "border-red-200 bg-red-50 text-red-950"
              : accepted || decisionElapsed
                ? "border-emerald-200 bg-emerald-50 text-emerald-950"
                : "border-amber-200 bg-amber-50 text-amber-950"
          }`}>
            {stalled ? (
              <span>Toto okno ťa nemá blokovať. Zavri ho a pokračuj v práci; stav si môžeš kedykoľvek obnoviť.</span>
            ) : accepted || decisionElapsed ? (
              <span className="flex items-center gap-2">
                <Loader2 size={17} className="shrink-0 motion-safe:animate-spin" aria-hidden="true" />
                Nie je potrebné nič stláčať. Hovor sa nepreruší; ak práve prebieha, odovzdanie naň bezpečne počká.
              </span>
            ) : (
              <>
                Ak chceš zostať, stlač <strong>Nie, zostávam tu</strong>. Ak nič neurobíš, po skončení časovača sa pracovisko odovzdá automaticky.
              </>
            )}
          </div>

          {error && (
            <div
              ref={errorRef}
              role="alert"
              tabIndex={-1}
              className="mt-3 rounded-xl border border-red-300 bg-red-50 px-3 py-2.5 text-sm font-semibold leading-5 text-red-900 outline-none focus-visible:ring-2 focus-visible:ring-red-400"
            >
              {error}
            </div>
          )}

          <div className="mt-5 grid gap-2 sm:grid-cols-2">
            {!accepted && !decisionElapsed && (
              <button
                ref={declineRef}
                type="button"
                onClick={onDecline}
                disabled={Boolean(pending)}
                className="min-h-11 rounded-lg border border-zinc-300 bg-white px-4 text-sm font-bold text-zinc-800 outline-none hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:cursor-wait disabled:text-zinc-400"
              >
                {pending === "decline" ? "Odmietam…" : "Nie, zostávam tu"}
              </button>
            )}
            {!accepted && !decisionElapsed && <button
              ref={acceptRef}
              type="button"
              onClick={onAccept}
              disabled={Boolean(pending)}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-zinc-950 px-4 text-sm font-black text-white outline-none hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-zinc-500"
            >
              {pending === "accept" && <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden="true" />}
              {pending === "accept"
                ? "Bezpečne odovzdávam…"
                : "Áno, odovzdať teraz"}
            </button>}

            {/* Always reachable, in every phase: the operator must never be left
                with a modal that offers nothing at all. */}
            <button
              type="button"
              onClick={() => setHidden(true)}
              className="min-h-11 rounded-lg border border-zinc-300 bg-white px-4 text-sm font-bold text-zinc-800 outline-none hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2"
            >
              Skryť a pracovať ďalej
            </button>
            {onRefresh && (
              <button
                type="button"
                onClick={onRefresh}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-zinc-300 bg-white px-4 text-sm font-bold text-zinc-800 outline-none hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2"
              >
                <RefreshCw size={15} aria-hidden="true" /> Obnoviť stav
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
