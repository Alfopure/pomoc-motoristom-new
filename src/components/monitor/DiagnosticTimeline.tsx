"use client";

import { useState } from "react";
import type { DiagnosticStoredEvent, DiagnosticTimeline } from "@/lib/diagnostics/types";
import type { RoutingDiagnostic } from "@/lib/diagnostics/routing";
import { isDiagnosticUuid } from "@/lib/diagnostics/types";
import { voiceQualityWarning } from "@/lib/diagnostics/voice-quality";
import { eventLabels, latency, operationLabels, outcomeLabels, timestamp } from "./monitor-model";
import { useMonitorResource } from "./useMonitorResource";

export function DiagnosticEvents({ events }: { events: DiagnosticStoredEvent[] }) {
  if (!events.length) return <p className="py-3 text-sm text-zinc-500">V tomto období nie sú dostupné udalosti. Chýbajúci záznam nevylučuje problém.</p>;
  return <ol className="divide-y divide-zinc-100" aria-label="Časová os udalostí">{events.map(event => {
    const quality = voiceQualityWarning(event.sdkWarningCode);
    return <li key={event.id} className="grid gap-1 py-3 text-xs sm:grid-cols-[125px_1fr]">
    <div><time className="font-medium text-zinc-700" dateTime={event.occurredAt}>{timestamp(event.occurredAt)}</time><p className="mt-1 text-zinc-500">{event.source === "browser" ? "Prehliadač" : event.source === "server" ? "Server" : "Plánovaná úloha"}</p></div>
    <div className="min-w-0"><p className="font-semibold text-zinc-900">{event.operation ? operationLabels[event.operation] : eventLabels[event.type]} <span className="font-normal text-zinc-500">· {outcomeLabels[event.outcome]}</span></p>
      <p className="mt-1 text-zinc-600">{quality ? <span>{quality.label} · SDK {quality.code} · </span> : event.reason && <span>{event.reason} · </span>}{event.errorClass && <span>{event.errorClass} · </span>}{event.durationMs !== undefined && <span>{latency(event.durationMs)} · </span>}Verzia {event.buildId}</p>
      {quality && <p className="mt-1 text-zinc-500">Pozorovanie telefónu; samo nepotvrdzuje výpadok ani príčinu. {quality.silence ? "Ticho môže byť zámerné. " : ""}Počuteľnosť oboma smermi treba overiť pri hovore.</p>}
      <details className="mt-1 text-zinc-500"><summary className="w-fit cursor-pointer">Súvislosti udalosti</summary><dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-all">
        <dt>Prijaté serverom</dt><dd>{timestamp(event.receivedAt)}</dd><dt>ID udalosti</dt><dd>{event.id}</dd><dt>Stránka / poradie</dt><dd>{event.pageId} / {event.sequence}</dd>
        <dt>Verzia servera pri prijatí</dt><dd>{event.serverBuild}</dd>
        {event.errorId && <><dt>ID technickej chyby</dt><dd>{event.errorId}</dd></>}
        {event.requestId && <><dt>Požiadavka</dt><dd>{event.requestId}</dd></>}{event.operationId && <><dt>Úkon</dt><dd>{event.operationId}</dd></>}{event.deviceSessionId && <><dt>Relácia zariadenia</dt><dd>{event.deviceSessionId}</dd></>}
      </dl></details>
    </div>
  </li>;
  })}</ol>;
}

const routingReasons: Record<string, string> = {
  no_presence: "Chýba stav dostupnosti", offline: "Operátor je offline", paused: "Operátor má prestávku",
  ringing: "Operátor už má ponuku hovoru", on_call: "Operátor telefonuje", wrap_up: "Operátor dokončuje predchádzajúci hovor",
  no_device: "Chýba prihlásené telefónne zariadenie", device_stale: "Registrácia alebo odozva zariadenia nie je aktuálna",
  open_offer: "Operátor má inú otvorenú ponuku", attempted: "Zariadenie už bolo v tomto kroku volané",
  duplicate: "Zariadenie je v skupine opakovane", capacity: "Dosiahnutý limit súčasných vetiev hovoru",
  fanout: "Dosiahnutý limit súčasne volaných zariadení", feature_disabled: "Vytáčanie tohto cieľa je vypnuté",
  all_offers_finished: "Všetky ponuky spoločného zvonenia sa skončili", ordered_exhausted: "Postupné volanie skupiny sa skončilo",
  no_eligible_members: "V skupine nie je dostupné zariadenie na vytáčanie",
  external_number: "Prechod na záložné číslo", waiting_room: "Prechod do čakárne",
  hangup_message: "Záverečná hláška a ukončenie", callback_offer: "Ponuka spätného volania",
};
const presenceLabels: Record<string, string> = { available: "dostupný", ringing: "zvoní", on_call: "telefonuje", after_call_work: "dokončuje hovor", paused: "prestávka", offline: "offline" };
const registrationLabels: Record<string, string> = { registered: "registrované", unregistered: "neregistrované", registering: "registruje sa", error: "chyba registrácie", unknown: "nezistená" };
function plannedEnd(record: RoutingDiagnostic): string | null {
  return record.startedAt && record.ringSecs !== null ? new Date(Date.parse(record.startedAt) + record.ringSecs * 1000).toISOString() : null;
}

export function DiagnosticRoutingTimeline({ routing, truncated, unavailable, profiles = {} }: { routing?: RoutingDiagnostic[]; truncated?: boolean; unavailable?: boolean; profiles?: Record<string, string> }) {
  const records = routing ?? [];
  const firstSelection = records.find(record => record.kind === "selection" && record.selectedCount > 0);
  return <section className="my-4 rounded-md border border-zinc-200 p-3" aria-label="Smerovanie a zvonenie">
    <h3 className="text-sm font-semibold text-zinc-900">Smerovanie a zvonenie</h3>
    <p className="mt-1 text-xs leading-5 text-zinc-500">Rozhodnutia servera ukazujú výber zariadení a požadovaný čas zvonenia. Nepotvrdzujú, že mobil skutočne vydal zvuk.</p>
    {unavailable ? <p role="status" className="mt-2 text-xs text-amber-900">Rozhodnutia smerovania sa nepodarilo načítať. Ostatné údaje hovoru sú dostupné nižšie.</p> : !records.length && <p className="mt-2 text-xs text-zinc-500">Pre tento hovor nie sú dostupné podrobné rozhodnutia smerovania. Staršie hovory ich nemuseli zaznamenávať.</p>}
    {truncated && <p className="mt-2 text-xs text-amber-900">Zobrazuje sa len časť dostupných rozhodnutí alebo zariadení.</p>}
    <ol className="divide-y divide-zinc-100">{records.map((record, index) => <li className="py-3 text-xs" key={`${record.at}:${index}`}>
      <p className="font-semibold text-zinc-900"><time dateTime={record.at}>{timestamp(record.at)}</time> · {record.kind === "selection" ? "Výber zariadení" : record.kind === "completed" ? "Ukončenie skupiny" : "Záložný postup"}{record.step !== null && ` · krok ${record.step + 1}`}</p>
      {record.reason && <p className="mt-1 text-zinc-700">{routingReasons[record.reason] ?? "Dôvod nezistený"}</p>}
      {record.kind === "selection" && <p className="mt-1 text-zinc-700">{record.strategy === "all" ? "Súčasné volanie" : record.strategy === "ordered" ? "Postupné volanie" : "Volanie cieľa"} · vybrané na vytáčanie: {record.selectedCount} · vynechané: {record.skippedCount}</p>}
      {record.startedAt && record.ringSecs !== null && <p className="mt-1 text-zinc-600">Požadované zvonenie: {timestamp(record.startedAt)} → {timestamp(plannedEnd(record))} ({record.ringSecs} s)</p>}
      {record.kind === "fallback" && firstSelection && <p className="mt-1 text-zinc-600">Od prvého výberu zariadení: {latency(Math.max(0, Date.parse(record.at) - Date.parse(firstSelection.at)))}</p>}
      {record.members.length > 0 && <ul className="mt-2 space-y-2">{record.members.map((member, memberIndex) => <li key={`${member.memberId ?? member.profileId}:${member.endpoint}:${memberIndex}`} className="rounded bg-zinc-50 p-2">
        <p className="font-medium text-zinc-800">{member.endpoint === "sip" ? "Aplikačný telefón" : "Telefónne číslo"} · {member.outcome === "selected" ? "vybrané na vytáčanie" : "vynechané"}{member.reason && ` · ${routingReasons[member.reason] ?? "dôvod nezistený"}`}</p>
        <p className="mt-1 break-all text-zinc-500">{member.profileId ? profiles[member.profileId] ?? `Operátor ${member.profileId.slice(-8)} (meno nedostupné)` : "Externý cieľ"} · dostupnosť: {member.presence ? presenceLabels[member.presence] ?? "nezistená" : "nezistená"}{member.endpoint === "sip" && <> · registrácia: {member.registration ? registrationLabels[member.registration] ?? "nezistená" : "nezistená"} · posledná odozva pred {latency(member.heartbeatAgeMs)}</>}{member.openOffer && " · otvorená ponuka"}</p>
      </li>)}</ul>}
      <details className="mt-2 text-zinc-500"><summary className="w-fit cursor-pointer">Limity a kontrola ukončenia</summary><p className="mt-1">Aktívne vetvy: {record.activeLegCount} / {record.maxConcurrentLegs} · limit súčasného výberu: {record.maxFanout}{record.omittedMembers > 0 && ` · nezobrazené zariadenia: ${record.omittedMembers}`}</p>{record.deadlineAt && <p className="mt-1">Kontrola pri chýbajúcom potvrdení ukončenia: {timestamp(record.deadlineAt)}. Tento termín zahŕňa rezervu na doručenie udalosti poskytovateľa.</p>}</details>
    </li>)}</ol>
  </section>;
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
      <DiagnosticRoutingTimeline routing={data.routing} truncated={data.routingTruncated} unavailable={data.routingUnavailable} profiles={data.routingProfiles} />
      {data.legs?.length > 0 && <div className="mt-3 overflow-x-auto"><table className="w-full whitespace-nowrap text-left text-xs"><caption className="mb-2 text-left font-semibold text-zinc-800">Vetvy hovoru · serverové údaje</caption><thead><tr className="text-zinc-500"><th className="pr-3 pb-2">Úloha</th><th className="pr-3 pb-2">Prijaté</th><th className="pr-3 pb-2">Spojené</th><th className="pb-2">Ukončené</th></tr></thead><tbody>{data.legs.map(leg => <tr key={leg.id}><td className="pr-3 pb-2">{({ customer: "Volajúci", operator: "Operátor", consult: "Konzultácia", supervisor: "Dohľad", external: "Externý účastník" } as Record<string, string>)[leg.role] ?? "Účastník"}</td><td className="pr-3 pb-2">{timestamp(leg.answeredAt)}</td><td className="pr-3 pb-2">{timestamp(leg.bridgedAt)}</td><td className="pb-2">{timestamp(leg.endedAt)}</td></tr>)}</tbody></table></div>}
      <DiagnosticEvents events={data.events ?? []} />
      {data.nextCursor && <button className="rounded-md border border-zinc-300 px-3 py-2 text-xs font-semibold" type="button" onClick={() => setCursor(data.nextCursor)}>Ďalších 100 udalostí</button>}
    </>}
  </div>;
}
