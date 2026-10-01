"use client";

import { useState } from "react";
import type { DiagnosticStoredEvent, DiagnosticTimeline } from "@/lib/diagnostics/types";
import { isDiagnosticUuid } from "@/lib/diagnostics/types";
import { eventLabels, latency, operationLabels, outcomeLabels, timestamp } from "./monitor-model";
import { useMonitorResource } from "./useMonitorResource";

export function DiagnosticEvents({ events }: { events: DiagnosticStoredEvent[] }) {
  if (!events.length) return <p className="py-3 text-sm text-zinc-500">V tomto období nie sú dostupné udalosti. Chýbajúci záznam nevylučuje problém.</p>;
  return <ol className="divide-y divide-zinc-100" aria-label="Časová os udalostí">{events.map(event => <li key={event.id} className="grid gap-1 py-3 text-xs sm:grid-cols-[125px_1fr]">
    <div><time className="font-medium text-zinc-700" dateTime={event.occurredAt}>{timestamp(event.occurredAt)}</time><p className="mt-1 text-zinc-500">{event.source === "browser" ? "Prehliadač" : event.source === "server" ? "Server" : "Plánovaná úloha"}</p></div>
    <div className="min-w-0"><p className="font-semibold text-zinc-900">{event.operation ? operationLabels[event.operation] : eventLabels[event.type]} <span className="font-normal text-zinc-500">· {outcomeLabels[event.outcome]}</span></p>
      <p className="mt-1 text-zinc-600">{event.reason && <span>{event.reason} · </span>}{event.errorClass && <span>{event.errorClass} · </span>}{event.durationMs !== undefined && <span>{latency(event.durationMs)} · </span>}Verzia {event.buildId}</p>
      <details className="mt-1 text-zinc-500"><summary className="w-fit cursor-pointer">Súvislosti udalosti</summary><dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-all">
        <dt>Prijaté serverom</dt><dd>{timestamp(event.receivedAt)}</dd><dt>ID udalosti</dt><dd>{event.id}</dd><dt>Stránka / poradie</dt><dd>{event.pageId} / {event.sequence}</dd>
        <dt>Verzia servera pri prijatí</dt><dd>{event.serverBuild}</dd>
        {event.errorId && <><dt>ID technickej chyby</dt><dd>{event.errorId}</dd></>}
        {event.requestId && <><dt>Požiadavka</dt><dd>{event.requestId}</dd></>}{event.operationId && <><dt>Úkon</dt><dd>{event.operationId}</dd></>}{event.deviceSessionId && <><dt>Relácia zariadenia</dt><dd>{event.deviceSessionId}</dd></>}
      </dl></details>
    </div>
  </li>)}</ol>;
}

export function DiagnosticCallTimeline({ callSessionId }: { callSessionId: string }) {
  const [cursor, setCursor] = useState<string | null>(null);
  const params = new URLSearchParams({ callSessionId, range: "7d", pageSize: "100" });
  if (cursor) params.set("cursor", cursor);
  const resource = useMonitorResource<DiagnosticTimeline>(isDiagnosticUuid(callSessionId) ? `/api/diagnostics?${params}` : null, 0);
  const data = resource.error ? null : resource.data;
  return <div>
    <p className="text-xs text-zinc-500">Posledných 7 dní · časy prehliadača a servera sa môžu líšiť. Príčina prerušenia zostáva nezistená, pokiaľ ju nepotvrdia ďalšie dôkazy.</p>
    {resource.error && <p role="alert" className="my-3 text-sm text-amber-900">{resource.error}<button type="button" onClick={resource.refresh} className="ml-2 underline">Skúsiť znova</button></p>}
    {resource.loading && <p role="status" className="py-3 text-sm text-zinc-500">Načítavam časovú os…</p>}
    {data && <>
      <p className="mt-3 text-xs text-zinc-500">Overené: {timestamp(data.checkedAt)}</p>
      {data.legs?.length > 0 && <div className="mt-3 overflow-x-auto"><table className="w-full whitespace-nowrap text-left text-xs"><caption className="mb-2 text-left font-semibold text-zinc-800">Vetvy hovoru · serverové údaje</caption><thead><tr className="text-zinc-500"><th className="pr-3 pb-2">Úloha</th><th className="pr-3 pb-2">Prijaté</th><th className="pr-3 pb-2">Spojené</th><th className="pb-2">Ukončené</th></tr></thead><tbody>{data.legs.map(leg => <tr key={leg.id}><td className="pr-3 pb-2">{({ customer: "Volajúci", operator: "Operátor", consult: "Konzultácia", supervisor: "Dohľad", external: "Externý účastník" } as Record<string, string>)[leg.role] ?? "Účastník"}</td><td className="pr-3 pb-2">{timestamp(leg.answeredAt)}</td><td className="pr-3 pb-2">{timestamp(leg.bridgedAt)}</td><td className="pb-2">{timestamp(leg.endedAt)}</td></tr>)}</tbody></table></div>}
      <DiagnosticEvents events={data.events ?? []} />
      {data.nextCursor && <button className="rounded-md border border-zinc-300 px-3 py-2 text-xs font-semibold" type="button" onClick={() => setCursor(data.nextCursor)}>Ďalších 100 udalostí</button>}
    </>}
  </div>;
}
