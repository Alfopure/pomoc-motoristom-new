"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, PhoneForwarded, RefreshCw } from "lucide-react";
import type {
  TelephonyRedirectDestination,
  TelephonyTransferTarget,
} from "@/lib/telephony/commands";
import { telephonyFetch, TELEPHONY_TIMEOUT_MS } from "@/lib/telephony/client-request";
import { cleanPhoneInput, TelephonyPhoneInputError } from "@/lib/telephony/phone";

type CallTransferPickerProps = {
  callId: string;
  disabled?: boolean;
  onRedirect?: (destination: TelephonyRedirectDestination) => Promise<boolean>;
  onTransferred?: () => void;
  tone?: "light" | "dark";
};

export function CallTransferPicker({
  callId,
  disabled = false,
  onRedirect,
  onTransferred,
  tone = "light",
}: CallTransferPickerProps) {
  const [targets, setTargets] = useState<TelephonyTransferTarget[]>([]);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [loading, setLoading] = useState(true);
  const [pendingTarget, setPendingTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef<AbortController | null>(null);
  const dark = tone === "dark";

  /**
   * Applies one load's result only if it is still the newest. `signal.aborted`
   * is the exact test for "we cancelled this" - a timeout aborts the internal
   * controller inside telephonyFetch, not this one, so a timed-out load still
   * surfaces its error instead of leaving the spinner as the only state.
   */
  function applyLoadResult(
    controller: AbortController,
    outcome: { targets: TelephonyTransferTarget[] } | { error: unknown },
  ) {
    if (controller.signal.aborted || inFlightRef.current !== controller) return;
    inFlightRef.current = null;
    if ("targets" in outcome) {
      setTargets(outcome.targets);
      setError(null);
    } else {
      setTargets([]);
      setError(outcome.error instanceof Error
        ? outcome.error.message
        : "Dostupné pracoviská sa nepodarilo načítať.");
    }
    setLoading(false);
  }

  function startLoad(controller: AbortController) {
    inFlightRef.current = controller;
    requestTransferTargets(callId, controller.signal)
      .then((targets) => applyLoadResult(controller, { targets }))
      .catch((error: unknown) => applyLoadResult(controller, { error }));
  }

  // Manual refresh. Unlike the mount effect this runs from an event handler,
  // where a synchronous setState is allowed and wanted.
  function reloadTargets() {
    inFlightRef.current?.abort();
    setLoading(true);
    setError(null);
    startLoad(new AbortController());
  }

  useEffect(() => {
    const controller = new AbortController();
    // State is only written from the async continuation, never synchronously
    // in the effect body: `loading` already starts true.
    startLoad(controller);
    return () => controller.abort();
    // startLoad only closes over callId; depending on it identity would
    // restart the provider read at the render cadence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId]);

  async function redirect(destination: TelephonyRedirectDestination, key: string) {
    if (disabled || pendingTarget) return;
    setPendingTarget(key);
    setError(null);
    try {
      if (!onRedirect) {
        throw new Error("Prepojenie nie je pre tento hovor dostupné.");
      }
      const confirmed = await onRedirect(destination);
      if (confirmed) onTransferred?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Hovor sa nepodarilo prepojiť.");
    } finally {
      setPendingTarget(null);
    }
  }

  function submitPhoneNumber() {
    try {
      const parsed = cleanPhoneInput(phoneNumber, "Telefónne číslo");
      if (parsed.kind !== "phone") {
        throw new TelephonyPhoneInputError("Klapku vyber zo zoznamu pracovísk; sem zadaj celé telefónne číslo.");
      }
      void redirect({ destinationNumber: phoneNumber }, "phone");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Zadaj platné telefónne číslo.");
    }
  }

  const panelClass = dark ? "border-white/10 bg-black/20" : "border-zinc-200 bg-zinc-50";
  const headingClass = dark ? "text-zinc-300" : "text-zinc-600";
  const mutedClass = dark ? "text-zinc-400" : "text-zinc-600";
  const targetClass = dark
    ? "border-white/10 bg-white/10 text-white hover:border-amber-300 hover:bg-white/15"
    : "border-zinc-200 bg-white text-zinc-950 hover:border-yellow-300 hover:bg-yellow-50";
  const inputClass = dark
    ? "border-white/10 bg-zinc-900 text-white placeholder:text-zinc-500 focus:border-amber-400"
    : "border-zinc-300 bg-white text-zinc-950 placeholder:text-zinc-400 focus:border-yellow-400";

  return (
    <div className={`grid gap-3 rounded-lg border p-3 ${panelClass}`}>
      <section className="grid gap-2" aria-labelledby={`transfer-stations-${callId}`}>
        <div className="flex items-center justify-between gap-2">
          <div id={`transfer-stations-${callId}`} className={`text-xs font-bold uppercase tracking-wide ${headingClass}`}>
            Voľné pracoviská
          </div>
          <button
            type="button"
            aria-label="Obnoviť voľné pracoviská"
            // Deliberately not disabled while loading: a hung read used to
            // disable its own retry, leaving the spinner as the only state.
            disabled={disabled || Boolean(pendingTarget)}
            onClick={reloadTargets}
            className={`rounded-md p-1.5 disabled:opacity-40 ${dark ? "text-zinc-300 hover:bg-white/10" : "text-zinc-500 hover:bg-zinc-200"}`}
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
        {loading ? (
          <div className={`inline-flex items-center gap-2 py-2 text-xs font-medium ${mutedClass}`}>
            <Loader2 size={14} className="animate-spin" /> Overujem aktuálny stav klapiek…
          </div>
        ) : targets.length === 0 ? (
          <p className={`rounded-md px-2 py-2 text-xs ${dark ? "bg-white/5 text-zinc-300" : "bg-white text-zinc-600"}`}>
            Teraz nie je voľné iné registrované pracovisko.
          </p>
        ) : (
          <div className="grid gap-1.5 sm:grid-cols-2">
            {targets.map((target) => (
              <button
                key={target.extensionId}
                type="button"
                disabled={disabled || Boolean(pendingTarget)}
                onClick={() => void redirect({ destinationProfileId: target.profileId }, target.extensionId)}
                className={`flex min-h-11 items-center justify-between gap-3 rounded-md border px-2.5 py-2 text-left disabled:opacity-50 ${targetClass}`}
              >
                <span className="min-w-0">
                  <span className="block truncate text-xs font-bold">Pracovisko {target.extension}</span>
                  <span className={`block truncate text-[11px] ${mutedClass}`}>{target.operatorName}</span>
                </span>
                {pendingTarget === target.extensionId ? <Loader2 size={14} className="shrink-0 animate-spin" /> : <PhoneForwarded size={14} className="shrink-0" />}
              </button>
            ))}
          </div>
        )}
      </section>

      <form
        className={`grid gap-2 border-t pt-3 ${dark ? "border-white/10" : "border-zinc-200"}`}
        onSubmit={(event) => {
          event.preventDefault();
          submitPhoneNumber();
        }}
      >
        <label className={`text-xs font-bold uppercase tracking-wide ${headingClass}`} htmlFor={`transfer-number-${callId}`}>
          Iné telefónne číslo
        </label>
        <div className="flex gap-2">
          <input
            id={`transfer-number-${callId}`}
            type="tel"
            inputMode="tel"
            autoComplete="off"
            value={phoneNumber}
            disabled={disabled || Boolean(pendingTarget)}
            onChange={(event) => setPhoneNumber(event.target.value)}
            placeholder="0901 234 567 alebo +421…"
            className={`h-10 min-w-0 flex-1 rounded-md border px-3 text-sm outline-none disabled:opacity-50 ${inputClass}`}
          />
          <button
            type="submit"
            disabled={disabled || Boolean(pendingTarget) || !phoneNumber.trim()}
            className={`inline-flex h-10 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-bold disabled:opacity-50 ${dark ? "bg-amber-400 text-zinc-950 hover:bg-amber-300" : "bg-[#FCD703] text-zinc-950 hover:bg-yellow-300"}`}
          >
            {pendingTarget === "phone" ? <Loader2 size={14} className="animate-spin" /> : <PhoneForwarded size={14} />}
            Prepojiť
          </button>
        </div>
        <p className={`text-[11px] leading-4 ${mutedClass}`}>
          VIPTel prijme slovenský aj medzinárodný formát. Internú klapku vyber vyššie, aby sa pred odoslaním overila jej dostupnosť.
        </p>
      </form>

      {error && (
        <div role="alert" className={`grid gap-2 rounded-md px-2.5 py-2 text-xs font-medium ${dark ? "bg-red-500/20 text-red-100" : "border border-red-200 bg-red-50 text-red-800"}`}>
          <span>{error}</span>
          <button
            type="button"
            onClick={reloadTargets}
            disabled={disabled || Boolean(pendingTarget)}
            className={`justify-self-start rounded-md px-2 py-1 text-[11px] font-bold disabled:opacity-50 ${dark ? "bg-white/15 text-white hover:bg-white/25" : "border border-red-300 bg-white text-red-900 hover:bg-red-100"}`}
          >
            Skúsiť znova
          </button>
        </div>
      )}
    </div>
  );
}

async function requestTransferTargets(callId: string, signal?: AbortSignal) {
  const response = await telephonyFetch(`/api/telephony/calls/${encodeURIComponent(callId)}/transfer-targets`, {
    label: "voľné pracoviská",
    signal,
    // This read resolves fresh provider state, so it gets the snapshot budget.
    timeoutMs: TELEPHONY_TIMEOUT_MS.snapshot,
  });
  const result = (await response.json().catch(() => null)) as {
    error?: string;
    targets?: TelephonyTransferTarget[];
  } | null;
  if (!response.ok || !Array.isArray(result?.targets)) {
    throw new Error(result?.error ?? "Dostupné pracoviská sa nepodarilo načítať.");
  }
  return result.targets;
}
