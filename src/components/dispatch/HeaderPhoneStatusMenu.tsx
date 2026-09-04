"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, Loader2, Pause, Phone, PhoneCall, PhoneOff, X } from "lucide-react";

import type { OperatorPresenceStatus } from "@/lib/supabase/database.types";
import type { WebphoneSnapshot } from "@/lib/telephony/telnyx-webphone";

import { presenceLabel } from "./my-phone-model";
import { phoneTakeoverAvailable } from "./phone-bar-model";
import type { PhonePresenceAction } from "./useTelephonyConsole";

type HeaderPhoneStatusMenuProps = {
  busy: boolean;
  onChange: (action: PhonePresenceAction) => void;
  onRequestPause: () => void;
  onDismissNotice: () => void;
  onTakeover: () => void;
  notice: string | null;
  phone: WebphoneSnapshot;
  status: string | null;
};

const TRIGGER_TONES = {
  ok: "border-emerald-400/50 bg-emerald-500/15 text-emerald-100 hover:bg-emerald-500/25",
  warn: "border-amber-400/50 bg-amber-500/15 text-amber-100 hover:bg-amber-500/25",
  error: "border-red-400/50 bg-red-500/15 text-red-100 hover:bg-red-500/25",
  neutral: "border-white/15 bg-white/10 text-zinc-200 hover:bg-white/15",
} satisfies Record<"ok" | "warn" | "error" | "neutral", string>;

const REGISTRATION_BADGE_TONES = {
  ok: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  warn: "bg-amber-50 text-amber-700 ring-amber-200",
  error: "bg-red-50 text-red-700 ring-red-200",
  neutral: "bg-zinc-100 text-zinc-600 ring-zinc-200",
} satisfies Record<keyof typeof TRIGGER_TONES, string>;

function presenceTone(status: string | null): keyof typeof TRIGGER_TONES {
  if (status === "available") return "ok";
  if (status === "paused" || status === "after_call_work" || status === "ringing" || status === "on_call") return "warn";
  return "neutral";
}

export function HeaderPhoneStatusMenu({
  busy,
  onChange,
  onRequestPause,
  onDismissNotice,
  onTakeover,
  notice,
  phone,
  status,
}: HeaderPhoneStatusMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const availabilityLabel = presenceLabel(status as OperatorPresenceStatus | null);
  const connected = phone.registration.tone === "ok";
  const summaryLabel = notice ? "Chyba telefónie" : connected ? `${phone.registration.label} · ${availabilityLabel}` : phone.registration.label;
  const tone = notice ? "error" : connected ? presenceTone(status) : phone.registration.tone;
  const canTakeover = phoneTakeoverAvailable(phone.status);

  useEffect(() => {
    if (!open) return;

    function closeOnOutsidePointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function changePresence(action: PhonePresenceAction) {
    setOpen(false);
    onChange(action);
  }

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        data-testid="phone-registration"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={notice ? `Chyba telefónie: ${notice}` : `Telefón: ${phone.registration.label}; dostupnosť: ${availabilityLabel}`}
        title={notice ?? `${phone.registration.detail} Dostupnosť: ${availabilityLabel}.`}
        className={`inline-flex h-9 items-center gap-1.5 rounded-md border px-2 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-300 ${TRIGGER_TONES[tone]}`}
      >
        {busy ? (
          <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden="true" />
        ) : notice ? (
          <AlertTriangle size={14} aria-hidden="true" />
        ) : connected ? (
          <PhoneCall size={14} aria-hidden="true" />
        ) : (
          <PhoneOff size={14} aria-hidden="true" />
        )}
        <span className="hidden sm:inline">{summaryLabel}</span>
        <ChevronDown size={13} className={`hidden transition-transform sm:block ${open ? "rotate-180" : ""}`} aria-hidden="true" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Stav telefónu a dostupnosť"
          className="absolute right-0 top-[calc(100%+0.55rem)] z-[2147483500] w-[min(20rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-zinc-200 bg-white text-zinc-950 shadow-2xl"
        >
          {notice && (
            <div role="alert" className="flex items-start gap-2 border-b border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-semibold leading-5 text-red-800">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">{notice}</span>
              <button type="button" onClick={onDismissNotice} className="inline-flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-red-100" aria-label="Zavrieť chybu telefónie">
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          )}
          <div className="flex items-start justify-between gap-3 border-b border-zinc-200 px-3.5 py-3">
            <span className="flex min-w-0 items-start gap-2.5">
              <Phone size={16} className="mt-0.5 shrink-0 text-zinc-500" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-xs font-bold text-zinc-950">Telefón v prehliadači</span>
                <span className="mt-0.5 block text-[11px] leading-4 text-zinc-500">{phone.registration.detail}</span>
              </span>
            </span>
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${REGISTRATION_BADGE_TONES[phone.registration.tone]}`}>
              {phone.registration.label}
            </span>
          </div>

          {canTakeover && (
            <div className="border-b border-zinc-200 p-2">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onTakeover();
                }}
                className="flex w-full items-center gap-2 rounded-md bg-zinc-950 px-2.5 py-2 text-left text-xs font-bold text-white hover:bg-zinc-800"
              >
                <PhoneCall size={14} aria-hidden="true" />
                Prevziať telefón do tohto okna
              </button>
            </div>
          )}

          <div className="p-2">
            <p className="px-2 pb-1.5 pt-0.5 text-[10px] font-bold uppercase tracking-wide text-zinc-400">Dostupnosť pre hovory</p>
            <StatusOption active={status === "available"} disabled={busy} icon={PhoneCall} label="Dostupný" onClick={() => changePresence({ status: "available" })} />
            <StatusOption
              active={status === "paused"}
              disabled={busy}
              icon={Pause}
              label="Pauza alebo presmerovanie"
              onClick={() => {
                setOpen(false);
                onRequestPause();
              }}
            />
            <StatusOption
              active={status === "offline" || !status}
              disabled={busy}
              icon={PhoneOff}
              label="Odhlásiť z telefónie"
              onClick={() => changePresence({ status: "offline" })}
            />
            <p className="mt-1 border-t border-zinc-200 px-2 pt-2 text-[11px] font-medium leading-4 text-zinc-500">Stav sa nedá zmeniť počas hovoru.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusOption({
  active,
  disabled,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  disabled: boolean;
  icon: typeof Phone;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs font-semibold transition hover:bg-zinc-100 disabled:text-zinc-400 ${active ? "bg-emerald-50 text-emerald-800" : "text-zinc-700"}`}
    >
      <Icon size={14} aria-hidden="true" />
      <span className="min-w-0 flex-1">{label}</span>
      {active && <Check size={14} aria-hidden="true" />}
    </button>
  );
}
