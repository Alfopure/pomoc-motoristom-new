"use client";

import { useEffect, useRef } from "react";
import { PhoneForwarded, X } from "lucide-react";
import type { CallCenterCall } from "@/data/dispatch-types";
import { CallRecordingDetail } from "./recordings/CallRecordingDetail";

export function CallDetailDrawer({
  call,
  open,
  onClose,
  onNewCase,
}: {
  call: CallCenterCall | null;
  open: boolean;
  onClose: () => void;
  onNewCase: (call: CallCenterCall) => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    closeButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  const phone = call ? (call.direction === "outbound" ? call.calledNumber : call.callerNumber) : "";

  return (
    <div
      aria-hidden={!open}
      aria-labelledby="call-detail-title"
      aria-modal="true"
      inert={open ? undefined : true}
      role="dialog"
      className={`fixed inset-y-0 right-0 z-[2147483200] flex w-full max-w-3xl flex-col border-l border-zinc-200 bg-white shadow-2xl transition-transform duration-200 ${
        open ? "translate-x-0" : "pointer-events-none translate-x-full"
      }`}
    >
      <div className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-4 py-2">
        <span id="call-detail-title" className="min-w-0 break-all text-sm font-semibold text-zinc-600">
          Detail hovoru {phone}
        </span>
        <div className="flex items-center gap-2">
          {call ? (
            <button
              type="button"
              onClick={() => onNewCase(call)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-yellow-300 px-2 text-xs font-semibold text-zinc-950 hover:bg-yellow-200"
            >
              <PhoneForwarded size={13} />
              Nový prípad z hovoru
            </button>
          ) : null}
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-200 p-2 text-zinc-600 hover:bg-zinc-50"
            aria-label="Zavrieť detail hovoru"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {open && call ? <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <section className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm">
          <div className="font-semibold text-zinc-950">{call.lineLabel}</div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600">
            <span>Volajúci: {call.callerNumber}</span>
            {call.receivedNumber && <span>Volané číslo: {call.receivedNumber}</span>}
            {call.destinationNumber && <span>Finálny cieľ: {call.destinationNumber}</span>}
            {call.queueLabel && <span>Rad: {call.queueLabel}</span>}
          </div>
        </section>
        <CallRecordingDetail key={call.id} callId={call.id} />
      </div> : null}
    </div>
  );
}
