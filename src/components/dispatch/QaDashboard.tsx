"use client";

import { useEffect, useState } from "react";
import { Award, ClipboardCheck, Info, PhoneOutgoing } from "lucide-react";

import { TELEPHONY_TIMEOUT_MS, telephonyJson } from "@/lib/telephony/client-request";
import { CALLBACK_SOURCE_LABELS } from "@/lib/telephony/callback-queue";
import { qaTone, type QaDashboardPayload, type QaTone } from "@/lib/telephony/qa-metrics";

/**
 * Quality of service without recordings (plan "Fáza 4", QA bez prepisov).
 *
 * The previous version of this panel averaged AI scores from call transcripts.
 * Recording and transcription are out of scope by the owner's decision, so it
 * had been rendering nothing since the day the telephony was rebuilt. It now
 * reports what this call centre can actually be held to:
 *
 * * **dokumentácia** — the share of finished calls a dispatcher wrote an
 *   outcome on, per person;
 * * **spätné volania** — whether the callbacks we promised were made, and made
 *   inside the thirty minutes the caller was told.
 *
 * Self-gating: the endpoint is senior dispatcher and above, so an ordinary
 * dispatcher simply never sees the section.
 */

export function QaDashboard() {
  const [data, setData] = useState<QaDashboardPayload | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    void telephonyJson<QaDashboardPayload>("/api/telephony/qa/dashboard", {
      label: "QA prehľad",
      signal: controller.signal,
      timeoutMs: TELEPHONY_TIMEOUT_MS.read,
    })
      .then((result) => {
        if (result.ok && result.body) setData(result.body);
      })
      .catch(() => undefined);

    return () => controller.abort();
  }, []);

  if (!data) return null;

  const nothingYet = data.calls.completed === 0 && data.callbacks.created === 0;

  return (
    <section className="overflow-hidden rounded-md border border-zinc-200 bg-white md:col-span-2 xl:col-span-12">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 p-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950">
          <Award size={17} />
          Kvalita obsluhy hovorov
        </div>
        <span className="text-xs font-semibold text-zinc-500">posledných {data.lookbackDays} dní</span>
      </div>

      {!data.recordingEnabled && (
        <p className="flex items-start gap-2 border-b border-zinc-100 bg-zinc-50 px-3 py-2.5 text-xs leading-5 text-zinc-600">
          <Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            Hovory sa nenahrávajú ani neprepisujú, preto sa kvalita nehodnotí zo záznamu. Meria sa to, čo systém skutočne eviduje: či má
            ukončený hovor zapísaný výsledok a či sme stihli sľúbené spätné volanie do {data.promiseMinutes} minút.
          </span>
        </p>
      )}

      {nothingYet ? (
        <p className="px-3 py-8 text-center text-sm text-zinc-500">Za posledných {data.lookbackDays} dní zatiaľ nie sú ukončené hovory ani požiadavky na spätné volanie.</p>
      ) : (
        <>
          <div className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-4">
            <RateCard
              icon={ClipboardCheck}
              label="Zapísaný výsledok"
              rate={data.calls.documentedRate}
              detail={`${data.calls.documented} z ${data.calls.completed} ukončených hovorov`}
            />
            <RateCard
              icon={PhoneOutgoing}
              label="Spätné volania načas"
              rate={data.callbacks.onTimeRate}
              detail={`${data.callbacks.onTime} z ${data.callbacks.measured} sľúbených · ${data.callbacks.overdue} po termíne`}
            />
            <PlainCard
              label="Priemer do zavolania"
              value={data.callbacks.averageMinutesToClose === null ? "—" : `${data.callbacks.averageMinutesToClose} min`}
              detail={data.callbacks.medianMinutesToClose === null ? "Zatiaľ bez vybavených požiadaviek" : `medián ${data.callbacks.medianMinutesToClose} min`}
            />
            <PlainCard
              label="Prepojené s prípadom"
              value={data.calls.linkedRate === null ? "—" : `${data.calls.linkedRate} %`}
              detail={`${data.calls.linkedToCase} zo zapísaných hovorov má prípad`}
            />
          </div>

          <div className="grid gap-4 border-t border-zinc-100 p-3 lg:grid-cols-3">
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase text-zinc-500">Výsledky hovorov</h4>
              {data.calls.byOutcome.length === 0 ? (
                <p className="text-sm text-zinc-500">Zatiaľ nikto nezapísal výsledok hovoru.</p>
              ) : (
                <div className="space-y-1.5">
                  {data.calls.byOutcome.map((slice) => (
                    <div key={slice.outcome} className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate text-zinc-800">{slice.label}</span>
                      <span className="text-xs font-semibold text-zinc-600">{slice.calls}×</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase text-zinc-500">Spätné volania podľa zdroja</h4>
              {data.callbacks.bySource.length === 0 ? (
                <p className="text-sm text-zinc-500">Žiadne požiadavky v období.</p>
              ) : (
                <div className="space-y-1.5">
                  {data.callbacks.bySource.map((row) => (
                    <div key={row.source} className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate text-zinc-800">{CALLBACK_SOURCE_LABELS[row.source]}</span>
                      <span className="text-xs font-semibold text-zinc-600">
                        {row.done}/{row.calls} vybavených
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {data.callbacks.cancelled > 0 && (
                <p className="mt-2 text-xs text-zinc-500">{data.callbacks.cancelled}× zrušené bez zavolania.</p>
              )}
            </div>

            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase text-zinc-500">Podľa dispečera</h4>
              {data.operators.length === 0 ? (
                <p className="text-sm text-zinc-500">Žiadne hovory priradené dispečerovi.</p>
              ) : (
                <div className="space-y-1.5">
                  {data.operators.map((operator) => (
                    <div key={operator.profileId} className="flex items-center justify-between gap-2 text-sm">
                      <span className="truncate text-zinc-800">{operator.name}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="text-xs text-zinc-500">{operator.calls}×</span>
                        <RateBadge label="výsledok" rate={operator.documentedRate} />
                        {operator.callbacksHandled > 0 ? <RateBadge label="spätné" rate={operator.callbacksOnTimeRate} /> : null}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

const TONE_CARD: Record<QaTone, string> = {
  ok: "border-emerald-200 bg-emerald-50 text-emerald-900",
  warn: "border-amber-200 bg-amber-50 text-amber-900",
  alert: "border-red-200 bg-red-50 text-red-900",
  idle: "border-zinc-200 bg-white text-zinc-950",
};

const TONE_BADGE: Record<QaTone, string> = {
  ok: "bg-emerald-100 text-emerald-900",
  warn: "bg-amber-100 text-amber-900",
  alert: "bg-red-100 text-red-900",
  idle: "bg-zinc-100 text-zinc-600",
};

function RateCard({ detail, icon: Icon, label, rate }: { detail: string; icon: typeof Award; label: string; rate: number | null }) {
  const tone = qaTone(rate);
  return (
    <div className={`rounded-md border p-3 ${TONE_CARD[tone]}`}>
      <div className="flex items-center justify-between gap-2 text-xs font-semibold">
        <span>{label}</span>
        <Icon size={15} className="shrink-0 opacity-60" aria-hidden="true" />
      </div>
      <div className="mt-2 text-3xl font-bold tabular-nums tracking-tight">{rate === null ? "—" : `${rate} %`}</div>
      <div className="mt-1 text-xs opacity-80">{detail}</div>
    </div>
  );
}

function PlainCard({ detail, label, value }: { detail: string; label: string; value: string }) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-3">
      <div className="text-xs font-semibold text-zinc-600">{label}</div>
      <div className="mt-2 text-3xl font-bold tabular-nums tracking-tight text-zinc-950">{value}</div>
      <div className="mt-1 text-xs text-zinc-500">{detail}</div>
    </div>
  );
}

function RateBadge({ label, rate }: { label: string; rate: number | null }) {
  if (rate === null) return <span className="text-xs text-zinc-400">–</span>;
  return <span className={`rounded-md px-1.5 py-0.5 text-xs font-bold ${TONE_BADGE[qaTone(rate)]}`}>{`${label} ${rate} %`}</span>;
}
