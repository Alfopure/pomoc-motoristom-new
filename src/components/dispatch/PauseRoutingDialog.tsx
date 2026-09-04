"use client";

import { useEffect, useMemo, useState } from "react";
import { Coffee, Loader2, Pause, PhoneForwarded, Smartphone, UserRoundCheck, X } from "lucide-react";

import type { Operator } from "@/domain/types";
import { DEFAULT_OPERATOR_SETTINGS, type PauseRoutingMode } from "@/lib/telephony/operator-settings";
import { formatPhoneNumberForDisplay } from "@/lib/telephony/phone";
import type { TelephonyOperatorPresence } from "@/lib/telephony/presence";

import { ConfigRequestError, loadRoutingConfig, saveOperatorSettings } from "./settings/config-client";
import { findOperator } from "./settings/operators-model";
import type { PhonePauseReason } from "./useTelephonyConsole";

export type PauseRoutingSelection = {
  pauseReasonId?: string;
};

type PauseRoutingDialogProps = {
  open: boolean;
  profileId: string | null | undefined;
  operators: Operator[];
  presences?: TelephonyOperatorPresence[];
  pauseReasons: PhonePauseReason[];
  busy?: boolean;
  onClose: () => void;
  /** Called only after the routing preference has been persisted. */
  onActivate: (selection: PauseRoutingSelection) => Promise<boolean>;
};

const MODE_OPTIONS: Array<{
  mode: PauseRoutingMode;
  icon: typeof Pause;
  title: string;
  detail: string;
}> = [
  { mode: "none", icon: Coffee, title: "Bežná pauza", detail: "Mne nič nezvoní; plán pokračuje ďalším členom." },
  { mode: "default_mobile", icon: Smartphone, title: "Môj mobil", detail: "Moju pozíciu v skupine nahradí uložené mobilné číslo." },
  { mode: "operator", icon: UserRoundCheck, title: "Zastúpi ma kolega", detail: "Moju pozíciu prevezme vybraný dostupný operátor." },
  { mode: "external_number", icon: PhoneForwarded, title: "Iný telefón", detail: "Hovor zazvoní na jednorazovo zadanom externom čísle." },
];

export function PauseRoutingDialog({
  busy = false,
  onActivate,
  onClose,
  open,
  operators,
  pauseReasons,
  presences = [],
  profileId,
}: PauseRoutingDialogProps) {
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<PauseRoutingMode>("none");
  const [defaultMobile, setDefaultMobile] = useState("");
  const [externalNumber, setExternalNumber] = useState("");
  const [forwardProfileId, setForwardProfileId] = useState("");
  const [pauseReasonId, setPauseReasonId] = useState("");

  useEffect(() => {
    if (!open || !profileId) return;
    const controller = new AbortController();
    void Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) return null;
        setLoading(true);
        setError(null);
        return loadRoutingConfig("ringGroups", { signal: controller.signal });
      })
      .then((response) => {
        if (controller.signal.aborted || !response) return;
        const operator = findOperator(response.document.operators, profileId);
        const settings = operator?.settings ?? DEFAULT_OPERATOR_SETTINGS;
        setMode(settings.pauseRoutingMode);
        setDefaultMobile(settings.defaultMobileNumber ?? "");
        setExternalNumber(settings.pauseForwardNumber ?? "");
        setForwardProfileId(settings.pauseForwardProfileId ?? "");
      })
      .catch((caught) => {
        if (controller.signal.aborted) return;
        setError(caught instanceof Error ? caught.message : "Nastavenia presmerovania sa nepodarilo načítať.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, profileId]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open, submitting]);

  const otherOperators = useMemo(
    () => operators.filter((operator) => operator.id !== profileId).sort((left, right) => left.name.localeCompare(right.name, "sk")),
    [operators, profileId],
  );
  const selectedPresence = presences.find((presence) => presence.profileId === forwardProfileId);
  const invalid =
    loading ||
    !profileId ||
    (mode === "default_mobile" && !defaultMobile.trim()) ||
    (mode === "external_number" && !externalNumber.trim()) ||
    (mode === "operator" && !forwardProfileId);

  async function submit() {
    if (submitting || busy || invalid || !profileId) return;
    setSubmitting(true);
    setError(null);
    try {
      await saveOperatorSettings(profileId, {
        defaultMobileNumber: defaultMobile.trim() || null,
        pauseRoutingMode: mode,
        pauseForwardProfileId: mode === "operator" ? forwardProfileId : null,
        pauseForwardNumber: mode === "external_number" ? externalNumber.trim() : null,
      });
      const activated = await onActivate({ ...(pauseReasonId ? { pauseReasonId } : {}) });
      if (activated) onClose();
      else setError("Pauzu sa nepodarilo aktivovať. Nastavenie presmerovania zostalo uložené.");
    } catch (caught) {
      setError(
        caught instanceof ConfigRequestError
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : "Pauzu a presmerovanie sa nepodarilo uložiť.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[2147483600] flex items-center justify-center bg-zinc-950/55 p-3 backdrop-blur-[2px]" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !submitting) onClose();
    }}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="pause-routing-title"
        className="max-h-[calc(100dvh-1.5rem)] w-full max-w-2xl overflow-y-auto rounded-xl border border-zinc-200 bg-white shadow-2xl"
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-zinc-200 bg-white px-4 py-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-800">
              <Pause size={18} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h2 id="pause-routing-title" className="text-base font-bold text-zinc-950">Pauza a zastupovanie hovorov</h2>
              <p className="mt-0.5 text-xs leading-5 text-zinc-600">Vyber, čo sa má stať s tvojou pozíciou v skupine počas pauzy.</p>
            </div>
          </div>
          <button type="button" disabled={submitting} onClick={onClose} className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 disabled:text-zinc-300" aria-label="Zavrieť">
            <X size={17} aria-hidden="true" />
          </button>
        </header>

        <div className="grid gap-4 p-4">
          {error && <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-800">{error}</div>}

          {loading ? (
            <div className="flex min-h-40 items-center justify-center gap-2 text-sm font-medium text-zinc-500"><Loader2 size={17} className="animate-spin" /> Načítavam nastavenia…</div>
          ) : (
            <>
              {pauseReasons.length > 0 && (
                <label className="grid gap-1.5 text-xs font-semibold text-zinc-700">
                  Dôvod pauzy
                  <select value={pauseReasonId} onChange={(event) => setPauseReasonId(event.target.value)} className="h-10 rounded-md border border-zinc-300 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-yellow-300">
                    <option value="">Bez uvedenia dôvodu</option>
                    {pauseReasons.map((reason) => <option key={reason.id} value={reason.id}>{reason.label}</option>)}
                  </select>
                </label>
              )}

              <div className="grid gap-2 sm:grid-cols-2">
                {MODE_OPTIONS.map((option) => {
                  const Icon = option.icon;
                  const selected = mode === option.mode;
                  return (
                    <button
                      key={option.mode}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setMode(option.mode)}
                      className={`flex min-h-20 items-start gap-3 rounded-lg border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-300 ${selected ? "border-zinc-950 bg-zinc-950 text-white" : "border-zinc-200 bg-white text-zinc-950 hover:bg-zinc-50"}`}
                    >
                      <Icon size={18} className={`mt-0.5 shrink-0 ${selected ? "text-yellow-300" : "text-zinc-500"}`} aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="block text-sm font-bold">{option.title}</span>
                        <span className={`mt-1 block text-xs leading-4 ${selected ? "text-zinc-300" : "text-zinc-500"}`}>{option.detail}</span>
                      </span>
                    </button>
                  );
                })}
              </div>

              {mode === "default_mobile" && (
                <label className="grid gap-1.5 text-xs font-semibold text-zinc-700">
                  Moje predvolené mobilné číslo
                  <input type="tel" inputMode="tel" autoComplete="tel" value={defaultMobile} onChange={(event) => setDefaultMobile(event.target.value)} placeholder="+421 900 000 000" className="h-11 rounded-md border border-zinc-300 px-3 text-base outline-none focus:ring-2 focus:ring-yellow-300" />
                  <span className="font-normal text-zinc-500">Uloží sa aj do Nastavenia → Môj telefón pre ďalšiu pauzu.</span>
                </label>
              )}

              {mode === "external_number" && (
                <label className="grid gap-1.5 text-xs font-semibold text-zinc-700">
                  Externý telefón alebo mobil
                  <input type="tel" inputMode="tel" value={externalNumber} onChange={(event) => setExternalNumber(event.target.value)} placeholder="+421 900 000 000" className="h-11 rounded-md border border-zinc-300 px-3 text-base outline-none focus:ring-2 focus:ring-yellow-300" />
                  <span className="font-normal text-zinc-500">Číslo musí byť medzi povolenými cieľmi organizácie.</span>
                </label>
              )}

              {mode === "operator" && (
                <label className="grid gap-1.5 text-xs font-semibold text-zinc-700">
                  Zastupujúci operátor
                  <select value={forwardProfileId} onChange={(event) => setForwardProfileId(event.target.value)} className="h-11 rounded-md border border-zinc-300 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-yellow-300">
                    <option value="">— vyber operátora —</option>
                    {otherOperators.map((operator) => {
                      const presence = presences.find((row) => row.profileId === operator.id);
                      return <option key={operator.id} value={operator.id}>{operator.name}{presence ? ` · ${presenceStateShort(presence)}` : ""}</option>;
                    })}
                  </select>
                  {selectedPresence && <span className={`font-normal ${selectedPresence.available ? "text-emerald-700" : "text-amber-700"}`}>Aktuálne: {selectedPresence.detail}</span>}
                </label>
              )}

              {mode !== "default_mobile" && defaultMobile && (
                <p className="text-xs text-zinc-500">Uložený mobil: {formatPhoneNumberForDisplay(defaultMobile) || defaultMobile}</p>
              )}
            </>
          )}
        </div>

        <footer className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t border-zinc-200 bg-zinc-50 px-4 py-3">
          <button type="button" disabled={submitting} onClick={onClose} className="h-10 rounded-md border border-zinc-300 bg-white px-4 text-sm font-semibold text-zinc-700 hover:bg-zinc-100 disabled:text-zinc-400">Zrušiť</button>
          <button type="button" disabled={busy || submitting || invalid} onClick={() => void submit()} className="inline-flex h-10 items-center gap-2 rounded-md bg-zinc-950 px-4 text-sm font-bold text-white hover:bg-zinc-800 disabled:bg-zinc-300 disabled:text-zinc-600">
            {submitting ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Pause size={15} aria-hidden="true" />}
            Aktivovať pauzu
          </button>
        </footer>
      </section>
    </div>
  );
}

function presenceStateShort(presence: TelephonyOperatorPresence): string {
  if (presence.state === "available") return "dostupný";
  if (presence.state === "on_call") return "telefonuje";
  if (presence.state === "ringing") return "zvoní";
  if (presence.state === "paused") return "pauza";
  if (presence.state === "offline") return "mimo radu";
  return "nedostupný";
}
