"use client";

import { useEffect, useRef } from "react";
import { PhoneCall, RefreshCw, X } from "lucide-react";

import type { PhoneBarModel } from "@/lib/telephony/active-calls-model";
import { callNotificationTarget, type CallNotificationFocus as Focus } from "@/lib/telephony/call-notification-target";
import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";
import type { WebphoneSnapshot } from "@/lib/telephony/telnyx-webphone";

export function CallNotificationFocus(props: {
  focus: Focus;
  model?: PhoneBarModel;
  phone?: WebphoneSnapshot;
  configured: boolean;
  stale: boolean;
  busy: boolean;
  outboundPending: boolean;
  onRefresh: () => void;
  onDismiss: () => void;
  onReconnect: () => void;
  onAnswer: () => void;
  onPickup: (sessionId: string) => void;
}) {
  const cardRef = useRef<HTMLElement>(null);
  const target = callNotificationTarget(props);
  useEffect(() => {
    cardRef.current?.focus({ preventScroll: true });
    cardRef.current?.scrollIntoView({ block: "nearest" });
  }, [props.focus]);

  return (
    <section ref={cardRef} tabIndex={-1} data-testid="call-notification-focus" data-session-id={props.focus.sessionId} aria-label="Hovor z upozornenia" className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 outline-none focus-visible:ring-2 focus-visible:ring-amber-500">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-bold text-zinc-950"><PhoneCall size={17} aria-hidden="true" /> Hovor z upozornenia</h2>
        <button type="button" aria-label="Zavrieť upozornenie na hovor" onClick={props.onDismiss} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-amber-100"><X size={18} aria-hidden="true" /></button>
      </div>
      {target.call && <p className="truncate text-sm font-semibold text-zinc-900">{target.call.callerName ?? (formatPhoneNumberForDisplay(target.call.number) || "Neznáme číslo")} <span className="font-normal text-zinc-600">· {target.call.lineLabel}</span></p>}
      <p role="status" className="mt-1 text-xs leading-5 text-zinc-700">{target.message}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {target.canAnswer && <button type="button" onClick={props.onAnswer} className="min-h-11 rounded-md bg-emerald-700 px-3 text-xs font-bold text-white">Prijať tento hovor</button>}
        {target.canPickup && <button type="button" aria-label="Prevziať čakajúci hovor" onClick={() => props.onPickup(props.focus.sessionId)} className="min-h-11 rounded-md bg-emerald-700 px-3 text-xs font-bold text-white">Prevziať hovor</button>}
        {target.canReconnect && <button type="button" onClick={props.onReconnect} className="min-h-11 rounded-md bg-zinc-900 px-3 text-xs font-bold text-white">Použiť tento telefón</button>}
        <button type="button" aria-label="Obnoviť stav" onClick={props.onRefresh} className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-amber-300 px-3 text-xs font-semibold text-zinc-800 hover:bg-amber-100"><RefreshCw size={14} aria-hidden="true" /> Obnoviť</button>
      </div>
    </section>
  );
}
