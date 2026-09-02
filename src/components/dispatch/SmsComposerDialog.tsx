"use client";

import { useEffect, useRef, useState } from "react";
import { Link2, Loader2, MapPin, MessageSquareText, Send, X } from "lucide-react";
import type { DispatchData } from "@/data/dispatch-types";
import { MAX_CUSTOM_SMS_LENGTH, validateCustomSmsDraft } from "@/lib/sms/custom-message";
import { renderLocationRequestSmsPreview } from "@/lib/sms/templates";

type SmsMode = "custom" | "location_request";

export type SmsComposerResult = {
  dispatchData?: DispatchData;
  sms?: {
    status?: string;
    statusDetail?: string | null;
  };
};

export function SmsComposerDialog({
  caseId,
  caseNumber,
  initialPhone = "",
  locationPhone,
  onClose,
  onSent,
  open,
}: {
  caseId?: string;
  caseNumber?: string;
  initialPhone?: string;
  locationPhone?: string;
  onClose: () => void;
  onSent?: (result: SmsComposerResult) => void;
  open: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const [phoneOverride, setPhoneOverride] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [mode, setMode] = useState<SmsMode>("custom");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const locationRecipient = (locationPhone ?? initialPhone).trim();
  const locationAvailable = Boolean(caseId && locationRecipient);
  const locationPreview = renderLocationRequestSmsPreview(caseNumber ?? "").replace("{bezpecny-link}", "https://…/l/bezpečný-link");

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => phoneRef.current?.focus());

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [initialPhone, open]);

  if (!open) return null;

  function close() {
    if (sending) return;
    setPhoneOverride(null);
    setError(null);
    setMode("custom");
    onClose();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }

    if (event.key !== "Tab") return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;

    let draft: ReturnType<typeof validateCustomSmsDraft> | null = null;

    if (mode === "custom") {
      try {
        draft = validateCustomSmsDraft({ message, toNumber: phoneOverride ?? initialPhone });
      } catch (validationError) {
        setError(validationError instanceof Error ? validationError.message : "Skontrolujte SMS údaje.");
        return;
      }
    } else if (!locationAvailable || !caseId) {
      setError("Žiadosť o polohu musí byť odoslaná z konkrétneho prípadu s telefónnym číslom klienta.");
      return;
    }

    setSending(true);
    setError(null);

    try {
      const response = await fetch(mode === "location_request" ? `/api/cases/${encodeURIComponent(caseId!)}/sms` : "/api/sms/send", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "location_request"
            ? { template: "location_request" }
            : { caseId, message: draft!.message, toNumber: draft!.toNumber },
        ),
      });
      const result = (await response.json().catch(() => null)) as (SmsComposerResult & { error?: string }) | null;

      if (!response.ok || !result) {
        throw new Error(result?.error ?? "SMS sa nepodarilo odoslať.");
      }

      setMessage("");
      setPhoneOverride(null);
      setMode("custom");
      onSent?.(result);
      onClose();
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "SMS sa nepodarilo odoslať.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[2147483640] grid place-items-center bg-zinc-950/60 p-3 backdrop-blur-[2px] sm:p-4" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sms-composer-title"
        aria-describedby="sms-composer-description"
        aria-busy={sending}
        onKeyDown={handleKeyDown}
        className="w-full max-w-lg overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl"
      >
        <div className="flex items-start gap-3 border-b border-yellow-200 bg-yellow-50 px-4 py-4 sm:px-5">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#FCD703] text-zinc-950">
            <MessageSquareText size={21} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="sms-composer-title" className="text-lg font-black text-zinc-950">Odoslať SMS</h2>
            <p id="sms-composer-description" className="mt-0.5 text-sm leading-5 text-zinc-600">
              Vyberte vlastnú správu alebo pripravenú žiadosť o GPS polohu.
            </p>
          </div>
          <button type="button" onClick={close} disabled={sending} aria-label="Zavrieť SMS" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-500 hover:bg-white disabled:opacity-40">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="grid gap-4 p-4 sm:p-5">
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-100 p-1" role="tablist" aria-label="Typ SMS správy">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "custom"}
              onClick={() => {
                setMode("custom");
                setError(null);
              }}
              className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold transition ${mode === "custom" ? "bg-white text-zinc-950 shadow-sm ring-1 ring-zinc-200" : "text-zinc-600 hover:text-zinc-900"}`}
            >
              <MessageSquareText size={16} /> Vlastná SMS
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "location_request"}
              onClick={() => {
                setMode("location_request");
                setError(null);
              }}
              className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-3 text-sm font-semibold transition ${mode === "location_request" ? "bg-[#FCD703] text-zinc-950 shadow-sm" : "text-zinc-600 hover:text-zinc-900"}`}
            >
              <MapPin size={16} /> Vyžiadať polohu
            </button>
          </div>

          {mode === "custom" ? (
            <>
              <label className="grid gap-1.5 text-sm font-semibold text-zinc-800">
                Telefónne číslo
                <input
                  ref={phoneRef}
                  type="tel"
                  value={phoneOverride ?? initialPhone}
                  onChange={(event) => {
                    setPhoneOverride(event.target.value);
                    setError(null);
                  }}
                  autoComplete="tel"
                  placeholder="0904 123 456"
                  className="h-11 rounded-lg border border-zinc-300 bg-white px-3 text-sm font-medium text-zinc-950 outline-none focus:border-yellow-500 focus:ring-2 focus:ring-yellow-200"
                />
                <span className="text-xs font-normal text-zinc-500">Môže to byť číslo z prípadu, kontaktu alebo číslo zadané ručne.</span>
              </label>

              <label className="grid gap-1.5 text-sm font-semibold text-zinc-800">
                Text správy
                <textarea
                  value={message}
                  onChange={(event) => {
                    setMessage(event.target.value);
                    setError(null);
                  }}
                  maxLength={MAX_CUSTOM_SMS_LENGTH}
                  rows={6}
                  placeholder="Napíšte správu pre klienta…"
                  className="min-h-32 resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2.5 text-sm font-medium leading-6 text-zinc-950 outline-none focus:border-yellow-500 focus:ring-2 focus:ring-yellow-200"
                />
                <span className="text-right text-xs font-normal tabular-nums text-zinc-500">{message.length} / {MAX_CUSTOM_SMS_LENGTH}</span>
              </label>
            </>
          ) : locationAvailable ? (
            <div className="grid gap-3">
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-3">
                <div className="flex items-center gap-2 text-sm font-bold text-emerald-950"><Link2 size={16} /> Bezpečný lokalizačný link</div>
                <p className="mt-1 text-xs leading-5 text-emerald-900">Odošle sa na {locationRecipient}. Link je jednorazový, platí 24 hodín a prijatá GPS neprepíše miesto incidentu.</p>
              </div>
              <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3.5">
                <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-zinc-500">Náhľad pripravenej správy</div>
                <p className="whitespace-pre-wrap break-words text-sm leading-6 text-zinc-800">{locationPreview}</p>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm leading-6 text-amber-950">
              Žiadosť o polohu sa viaže ku konkrétnemu prípadu. Najprv otvorte prípad s vyplneným telefónnym číslom klienta a potom znovu otvorte SMS.
            </div>
          )}

          {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm font-semibold text-red-800">{error}</div>}

          <div className="flex flex-col-reverse gap-2 border-t border-zinc-200 pt-4 sm:flex-row sm:justify-end">
            <button type="button" onClick={close} disabled={sending} className="inline-flex h-10 items-center justify-center rounded-lg border border-zinc-200 px-4 text-sm font-semibold text-zinc-700 hover:bg-zinc-50 disabled:opacity-40">
              Zrušiť
            </button>
            <button type="submit" disabled={sending} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-zinc-950 px-4 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-60">
              {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              {sending ? "Odosielam…" : mode === "location_request" ? "Odoslať žiadosť" : "Odoslať SMS"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
