"use client";

import { useEffect, useState } from "react";
import { Loader2, PhoneForwarded, UserRound, X } from "lucide-react";

import { telephonyJson, TELEPHONY_TIMEOUT_MS } from "@/lib/telephony/client-request";
import { formatPhoneNumberForDisplay, isDialablePhoneInput } from "@/lib/telephony/phone";

export type TransferTargetOption = {
  profileId: string;
  displayName: string;
  role: string;
  available: boolean;
  status: string;
  deviceLive: boolean;
};

export type TransferRequest = { profileId?: string; number?: string };

/** Which action the picker feeds: blind transfer, attended consult or "add a third party". */
export type TransferPickerMode = "transfer" | "consult" | "add-party";

const PICKER_TITLES: Record<TransferPickerMode, string> = {
  transfer: "Prepojiť hovor",
  consult: "Konzultovať s",
  "add-party": "Pridať do hovoru",
};

const PICKER_SUBMIT_LABELS: Record<TransferPickerMode, string> = {
  transfer: "Prepojiť",
  consult: "Volať",
  "add-party": "Pridať",
};

const STATUS_LABELS: Record<string, string> = {
  available: "Dostupný",
  ringing: "Zvoní",
  on_call: "Na hovore",
  after_call_work: "Dopisuje",
  paused: "Pauza",
  offline: "Odhlásený",
};

/**
 * Picks the destination of a blind transfer or an attended consultation.
 *
 * Colleagues come from `GET /api/telephony/calls/[id]/transfer-targets`, which
 * already applies the presence and device-liveness rules; unavailable people
 * stay visible but disabled, because "why can I not transfer to Peter" is a
 * question the bar should answer rather than hide.
 */
export function CallTransferPicker({
  sessionId,
  mode,
  busy,
  onCancel,
  onSubmit,
}: {
  sessionId: string;
  mode: TransferPickerMode;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (target: TransferRequest) => void;
}) {
  const [targets, setTargets] = useState<TransferTargetOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [externalNumber, setExternalNumber] = useState("");

  useEffect(() => {
    const controller = new AbortController();

    async function loadTargets() {
      try {
        const result = await telephonyJson<{ targets?: TransferTargetOption[]; error?: string }>(
          `/api/telephony/calls/${encodeURIComponent(sessionId)}/transfer-targets`,
          { label: "ciele prepojenia", signal: controller.signal, timeoutMs: TELEPHONY_TIMEOUT_MS.read },
        );
        if (!result.ok || !Array.isArray(result.body?.targets)) {
          throw new Error(result.body?.error ?? "Kolegov sa nepodarilo načítať.");
        }
        setTargets(result.body.targets);
        setError(null);
      } catch (loadError) {
        if (controller.signal.aborted) return;
        setTargets([]);
        setError(loadError instanceof Error ? loadError.message : "Kolegov sa nepodarilo načítať.");
      }
    }

    void loadTargets();
    return () => controller.abort();
  }, [sessionId]);

  const externalValid = isDialablePhoneInput(externalNumber);
  const title = PICKER_TITLES[mode];

  return (
    <section
      aria-label={title}
      className="w-80 max-w-[calc(100vw-24px)] rounded-xl border border-zinc-200 bg-white p-3 text-zinc-950 shadow-2xl"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold">{title}</h3>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100"
          aria-label="Zavrieť"
        >
          <X size={15} />
        </button>
      </div>

      {error && <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-semibold text-red-900">{error}</p>}

      <div className="mt-2 grid max-h-56 gap-1 overflow-y-auto pr-1">
        {targets === null && (
          <span className="flex items-center gap-2 px-1 py-2 text-xs font-medium text-zinc-500">
            <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden="true" />
            Načítavam kolegov…
          </span>
        )}
        {targets?.length === 0 && !error && (
          <span className="px-1 py-2 text-xs font-medium text-zinc-500">Žiadny kolega nie je prihlásený.</span>
        )}
        {targets?.map((target) => (
          <button
            key={target.profileId}
            type="button"
            disabled={!target.available || busy}
            onClick={() => onSubmit({ profileId: target.profileId })}
            className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-zinc-200 px-2 py-1.5 text-left text-xs font-semibold transition hover:border-zinc-400 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:border-zinc-100 disabled:bg-zinc-50 disabled:text-zinc-400"
            title={target.available ? undefined : "Kolega nie je dostupný."}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <UserRound size={13} className="shrink-0" aria-hidden="true" />
              <span className="truncate">{target.displayName}</span>
            </span>
            <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${target.available ? "bg-emerald-100 text-emerald-900" : "bg-zinc-100 text-zinc-600"}`}>
              {STATUS_LABELS[target.status] ?? target.status}
            </span>
          </button>
        ))}
      </div>

      <form
        className="mt-3 border-t border-zinc-200 pt-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!externalValid || busy) return;
          onSubmit({ number: externalNumber.trim() });
        }}
      >
        <label className="text-[11px] font-bold uppercase tracking-wide text-zinc-500" htmlFor="transfer-external-number">
          Externé číslo
        </label>
        <div className="mt-1 flex gap-1.5">
          <input
            id="transfer-external-number"
            type="tel"
            inputMode="tel"
            autoComplete="off"
            value={externalNumber}
            onChange={(event) => setExternalNumber(event.target.value)}
            placeholder="+421 900 000 000"
            className="h-9 min-w-0 flex-1 rounded-md border border-zinc-200 px-2 text-sm outline-none ring-yellow-300 transition focus:ring-2"
          />
          <button
            type="submit"
            disabled={!externalValid || busy}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md bg-zinc-950 px-2.5 text-xs font-bold text-white transition hover:bg-zinc-800 disabled:bg-zinc-300 disabled:text-zinc-600"
          >
            {busy ? <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden="true" /> : <PhoneForwarded size={13} aria-hidden="true" />}
            {PICKER_SUBMIT_LABELS[mode]}
          </button>
        </div>
        {externalNumber.trim() && !externalValid && (
          <p className="mt-1 text-[11px] font-semibold text-red-700">Zadajte platné telefónne číslo.</p>
        )}
        {externalValid && (
          <p className="mt-1 text-[11px] font-medium text-zinc-500">{formatPhoneNumberForDisplay(externalNumber)}</p>
        )}
      </form>
    </section>
  );
}
