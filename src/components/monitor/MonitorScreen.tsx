"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { DiagnosticIncident, DiagnosticIncidentDetail, DiagnosticIncidentStatus, DiagnosticOverview } from "@/lib/diagnostics/types";
import { setDiagnosticIdentity } from "@/lib/diagnostics/client";
import { CallDiagnosticsCard } from "./CallDiagnosticsCard";
import { DiagnosticEvents } from "./DiagnosticTimeline";
import { MonitorTable } from "./MonitorTable";
import { ReportProblemButton } from "./ReportProblemButton";
import { canShowPercentiles, classificationLabels, duration, freshness, kindLabels, latency, moduleLabels, operationLabels, statusLabels, timestamp } from "./monitor-model";
import { useMonitorClock, useMonitorResource, type MonitorResource } from "./useMonitorResource";

type Health = { status: string };
type ExternalLinks = { sentry?: string; uptime?: string; heartbeat?: string; vercel?: string; supabase?: string };
type Props = { appVersion: string; identity?: { organizationId: string; profileId: string }; externalLinks?: ExternalLinks };
const buttonClass = "min-h-9 rounded-md border border-zinc-300 bg-white px-3 text-xs font-semibold disabled:opacity-50";
const noteClass = "mt-2 text-xs leading-5 text-zinc-500";
const warningClass = "my-3 rounded-md bg-amber-50 p-3 text-xs text-amber-900";
const tabs = { incidents: "Incidenty", operations: "Odozvy úkonov", calls: "Hovory" } as const;

export function MonitorScreen({ appVersion, identity, externalLinks = {} }: Props) {
  const [range, setRange] = useState("24h");
  const [cursor, setCursor] = useState<string | null>(null);
  const [tab, setTab] = useState<keyof typeof tabs>("incidents");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const params = new URLSearchParams({ range, pageSize: "100" });
  if (cursor) params.set("cursor", cursor);
  const overview = useMonitorResource<DiagnosticOverview>(`/api/diagnostics?${params}`);
  const live = useMonitorResource<Health>("/api/health/live", 60_000, 60_000);
  const ready = useMonitorResource<Health>("/api/health/ready", 300_000, 300_000);
  const now = useMonitorClock();
  const data = overview.data;
  const stale = freshness(data?.checkedAt ? Date.parse(data.checkedAt) : overview.observedAt, now, 120_000) !== "fresh";
  const maintenance = freshness(data?.storage?.physicalCheckedAt ? Date.parse(data.storage.physicalCheckedAt) : null, now, 600_000);
  const collectionStatus = !data ? "Neoverený" : !data.enabled ? "Vypnutý" : overview.error ? "Nedostupný" : stale ? "Zastarané údaje"
    : maintenance === "stale" ? "Údržba diagnostiky mešká" : maintenance === "unknown" ? "Údržba diagnostiky neoverená"
      : data.storage?.blocked ? "Obmedzený kvótou" : `Zapnutý · pokrytie ${data.coverage === "limited" ? "čiastočné" : "nezistené"}`;
  const profileId = identity?.profileId, organizationId = identity?.organizationId;
  useEffect(() => { if (profileId && organizationId) setDiagnosticIdentity({ profileId, organizationId }); }, [profileId, organizationId]);
  function page(value: string | null) { setCursor(value); setSelectedId(null); }
  return <main className="min-h-screen bg-zinc-100 text-zinc-900">
    <header className="bg-zinc-950 p-4 text-white"><div className="mx-auto flex max-w-[1500px] flex-wrap items-center justify-between gap-3">
      <h1 className="text-lg font-semibold text-yellow-300">Monitor prevádzky</h1>
      <span className="text-xs">{data ? { production: "PRODUKCIA", test: "TEST", development: "VÝVOJ" }[data.environment] : "Prostredie neoverené"} · <a href="/" target="_blank" rel="noopener noreferrer" className="underline">Dispečing v novej karte</a></span>
    </div></header>
    <div className="mx-auto max-w-[1500px] space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3"><p className={noteClass}>Obnova každú minútu, iba vo viditeľnej karte.</p><div className="flex gap-2"><ReportProblemButton /><button className={buttonClass} disabled={overview.loading} onClick={() => { overview.refresh(); live.refresh(); ready.refresh(); }}>Obnoviť</button></div></div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <HealthCard title="Odpoveď aplikácie" resource={live} expected="live" now={now} maxAge={120_000} frequency="60 sekúnd" />
        <HealthCard title="Pripravenosť aplikácie" resource={ready} expected="ready" now={now} maxAge={600_000} frequency="5 minút" />
        <Card title="Zber diagnostiky">
          <Badge warning={!data || !!overview.error || stale || !data.enabled || maintenance !== "fresh" || data.storage?.blocked}>{collectionStatus}</Badge>
          <p className={noteClass}>Chýbajúce udalosti nepotvrdzujú bezchybnú prevádzku.<br />Overené: {timestamp(data?.checkedAt)}
            {data?.enabled && <><br />Posledná údržba: {timestamp(data.storage?.physicalCheckedAt)}</>}
          </p>
        </Card>
        <Card title="Externý dohľad">
          {([['uptime', 'Externé HTTP kontroly', 'Externé HTTP kontroly nenakonfigurované.'], ['sentry', 'Technické stacky', 'Technické stacky nie sú pripojené.'], ['heartbeat', 'Heartbeat · nie HTTP kontrola'], ['vercel', 'Vercel'], ['supabase', 'Supabase']] as const).map(([key, label, missing]) => <p key={key} className={noteClass}>{externalLinks[key] ? <a href={externalLinks[key]} target="_blank" rel="noopener noreferrer" className="underline">{label} ↗</a> : missing}</p>)}
          <p className={noteClass}>Stav externých služieb sa tu neoveruje.</p>
        </Card>
      </div>
      {overview.error && <p role="alert" className={warningClass}>{overview.error}</p>}
      {data && stale && <p role="status" className={warningClass}>Prehľad je zastaraný. Posledné overenie: {timestamp(data.checkedAt)}.</p>}
      {data && !data.enabled && <p role="status" className={warningClass}>Zber diagnostiky je vypnutý. Prázdny zoznam nevylučuje chyby.</p>}
      <section className="rounded-lg border border-zinc-200 bg-white p-4">
        <div className="flex flex-wrap items-end justify-between gap-3"><nav className="flex flex-wrap gap-1" aria-label="Časti monitora">{Object.entries(tabs).map(([key, label]) => <button key={key} aria-current={tab === key ? "page" : undefined} onClick={() => setTab(key as keyof typeof tabs)} className={`min-h-9 rounded-md px-3 text-xs font-semibold ${tab === key ? "bg-yellow-300" : "bg-zinc-100"}`}>{label}</button>)}</nav><Select label="Obdobie monitora" value={range} options={{ "24h": "Posledných 24 hodín", "7d": "Posledných 7 dní" }} onChange={value => { setRange(value); page(null); }} /></div>
        {!data ? <p role="status" className={noteClass}>{overview.loading ? "Načítavam…" : "Údaje nie sú dostupné."}</p> : <>
          <p className={noteClass}>{timestamp(data.since)} — {timestamp(data.until)} · overené {timestamp(data.checkedAt)} · pokrytie {data.coverage === "limited" ? "čiastočné" : "nezistené"}</p>
          {tab === "incidents" && <><IncidentList incidents={data.incidents ?? []} onSelect={setSelectedId} selectedId={selectedId} /><div className="mt-3 flex gap-2">{cursor && <button className={buttonClass} onClick={() => page(null)}>Prvá strana</button>}{data.nextCursor && <button className={buttonClass} disabled={overview.loading} onClick={() => page(data.nextCursor)}>Ďalších 100 incidentov</button>}</div>{selectedId && <IncidentDetail key={selectedId} id={selectedId} onClose={() => setSelectedId(null)} onChange={overview.refresh} />}</>}
          {tab === "operations" && <Operations overview={data} />}
          {tab === "calls" && <Calls overview={data} />}
        </>}
      </section>
      <details className="rounded-lg border border-zinc-200 bg-white p-4 text-xs"><summary className="cursor-pointer font-semibold">Verzie, zdroje a úplnosť údajov</summary>
        <p className={noteClass}>Verzia obrazovky: {appVersion}. Lokálne kontroly nenahrádzajú externý dohľad. Retencia a kvóty obmedzujú zber.</p>
        {data?.builds?.map(build => <p key={build.buildId} className="mt-2 break-all">{build.buildId} · {build.events} udalostí · {timestamp(build.lastSeenAt)}</p>)}
        {data?.storage && <p className={noteClass}>Udalosti {data.storage.eventCount} · zahodené {data.storage.dropped} · účtované {Math.round(data.storage.chargedBytes / 1024)} KiB · fyzicky {data.storage.physicalBytes === null ? "nezistené" : `${(data.storage.physicalBytes / 1048576).toFixed(1)} MiB`} · overené {timestamp(data.storage.physicalCheckedAt)}{freshness(data.storage.physicalCheckedAt ? Date.parse(data.storage.physicalCheckedAt) : null, now, 600_000) === "stale" ? " (zastarané)" : ""}{data.storage.cleanupBacklog ? " · čistenie má sklz" : ""}</p>}
      </details>
    </div>
  </main>;
}

function Card({ title, children }: { title: string; children: ReactNode }) { return <section className="rounded-lg border border-zinc-200 bg-white p-4"><h2 className="mb-3 text-xs font-semibold">{title}</h2>{children}</section>; }
function Badge({ children, warning, okay }: { children: ReactNode; warning?: boolean; okay?: boolean }) { return <span className={`inline-flex rounded-md px-2 py-1 text-xs font-semibold ${warning ? "bg-amber-50 text-amber-900" : okay ? "bg-emerald-50 text-emerald-800" : "bg-zinc-100"}`}>{children}</span>; }
function Select({ label, value, options, onChange, disabled }: { label: string; value: string; options: Record<string, string>; onChange: (value: string) => void; disabled?: boolean }) {
  return <label className="grid gap-1 text-xs text-zinc-500">{label}<select className="h-9 rounded-md border border-zinc-300 bg-white px-2 text-zinc-800" value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>{Object.entries(options).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>;
}
function HealthCard({ title, resource, expected, now, maxAge, frequency }: { title: string; resource: MonitorResource<Health>; expected: string; now: number; maxAge: number; frequency: string }) {
  const state = freshness(resource.observedAt, now, maxAge);
  const okay = state === "fresh" && !resource.error && resource.data?.status === expected;
  return <Card title={title}><Badge okay={okay} warning={!okay}>{state === "stale" ? "Zastarané overenie" : resource.error ? "Kontrola neúspešná" : okay ? "Posledná kontrola v poriadku" : "Stav neoverený"}</Badge><p className={noteClass}>Zdroj: táto karta · interval {frequency}<br />Overené: {timestamp(resource.observedAt === null ? null : new Date(resource.observedAt).toISOString())}</p></Card>;
}
function IncidentList({ incidents, selectedId, onSelect }: { incidents: DiagnosticIncident[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const [status, setStatus] = useState("");
  const [evidence, setEvidence] = useState("");
  const [module, setModule] = useState("");
  const filtered = incidents.filter(item => (!status || item.status === status) && (!evidence || item.classification === evidence) && (!module || item.module === module));
  return <><div className="mt-4 flex flex-wrap items-end gap-3">
    <Select label="Stav" value={status} options={{ "": "Všetky stavy", ...statusLabels }} onChange={setStatus} />
    <Select label="Dôkazy" value={evidence} options={{ "": "Všetky úrovne", ...classificationLabels }} onChange={setEvidence} />
    <Select label="Časť aplikácie" value={module} options={{ "": "Všetky časti", ...moduleLabels }} onChange={setModule} />
    <p className={noteClass}>{filtered.length} z {incidents.length} na načítanej strane</p>
  </div>{!filtered.length ? <p className={noteClass}>Žiadne dostupné incidenty. Zber nemusí zachytiť každý problém.</p> : <MonitorTable headers={["Posledný výskyt", "Problém / časť aplikácie", "Dôkazy", "Stav", "Počet", "Detail"]} rows={filtered.map(item => ({ key: item.id, selected: selectedId === item.id, cells: [timestamp(item.lastSeenAt), <span key="label">{item.operation ? operationLabels[item.operation] : kindLabels[item.kind]}<br />{moduleLabels[item.module]} · {item.buildId ?? "verzia nezistená"}</span>, <span key="evidence">{classificationLabels[item.classification]}<br />Príčina nezistená</span>, <Badge key="status" warning={item.status === "new"}>{statusLabels[item.status]}</Badge>, item.count, <button key="detail" className="p-2 font-semibold underline" aria-label={`Detail incidentu ${item.id}`} onClick={() => onSelect(item.id)}>Detail</button>] }))} />}</>;
}
function IncidentDetail({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const resource = useMonitorResource<DiagnosticIncidentDetail>(`/api/diagnostics/incidents/${encodeURIComponent(id)}`, 0);
  const [saving, setSaving] = useState(false);
  const [mutationError, setMutationError] = useState(false);
  async function changeStatus(status: string) {
    if (saving) return;
    setSaving(true); setMutationError(false);
    try {
      const response = await fetch(`/api/diagnostics/incidents/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ status: status as DiagnosticIncidentStatus }), signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error("update_failed");
      resource.refresh(); onChange();
    } catch { setMutationError(true); }
    finally { setSaving(false); }
  }
  const data = resource.error ? null : resource.data;
  return <section className="mt-4 rounded-md border border-zinc-300 bg-zinc-50 p-4" aria-label="Detail incidentu">
    <div className="flex justify-between"><h3 className="text-sm font-semibold">Detail incidentu</h3><button className="text-xs underline" aria-label="Zavrieť incident" onClick={onClose}>Zavrieť</button></div>
    {resource.loading && <p role="status" className={noteClass}>Načítavam dôkazy…</p>}
    {resource.error && <p role="alert" className={warningClass}>{resource.error} <button className="underline" onClick={resource.refresh}>Skúsiť znova</button></p>}
    {data && <><p className={noteClass}>{classificationLabels[data.incident.classification]} · príčina nezistená<br />Prvý výskyt {timestamp(data.incident.firstSeenAt)} · {data.incident.evidenceIds.length} záznamov</p><Select label="Stav incidentu" value={data.incident.status} options={statusLabels} disabled={saving || resource.loading} onChange={value => void changeStatus(value)} />
      {mutationError && <p role="alert" className={warningClass}>Zmenu sa nepodarilo potvrdiť. Obnovte detail.</p>}<DiagnosticEvents events={data.events ?? []} />{data.incident.callSessionId && <CallDiagnosticsCard key={data.incident.callSessionId} callSessionId={data.incident.callSessionId} />}</>}
  </section>;
}
function Operations({ overview }: { overview: DiagnosticOverview }) {
  const limited = overview.coverage === "limited" || overview.storage?.blocked;
  return <><h2 className="mt-4 text-sm font-semibold">Odozvy používateľských úkonov</h2>
    {limited && <p role="status" className={warningClass}>Percentily sú skryté: neúplné merania alebo zber obmedzený kvótou.</p>}
    <p className={noteClass}>Náhodný výber pred výsledkom; percentily od 100 vzoriek rovnakého režimu. Zlyhania vo vzorke nie sú všetky chyby. Trvanie končí odpoveďou API/operácie, nezahŕňa následné vykreslenie ani počuteľný zvuk.</p>
    {!overview.operations?.length ? <p className={noteClass}>Údaje nie sú dostupné.</p> : <MonitorTable headers={["Úkon", "Vzorka", "Zlyhania vo vzorke", "Medián p50", "p95"]} rows={overview.operations.map(item => {
      const enough = !limited && canShowPercentiles(item.samples, item.insufficientData);
      return { key: `${item.operation}:${item.sampleRate}`, cells: [operationLabels[item.operation], `${item.samples} (${(item.sampleRate * 100).toLocaleString("sk-SK")} %)`, item.failedSamples, enough ? latency(item.p50Ms) : limited ? "Neúplné merania" : "Nedostatok vzoriek", enough ? latency(item.p95Ms) : "—"] };
    })} />}</>;
}
function Calls({ overview }: { overview: DiagnosticOverview }) {
  return <><h2 className="mt-4 text-sm font-semibold">Hovory podľa smeru</h2><p className={noteClass}>Existujúca evidencia bez vzorkovania. Trvanie od prijatia po koniec zahŕňa podržanie a konzultácie; nie je čistým časom rozhovoru. Neznáme trvanie nie je nula.</p>
    {!overview.calls?.length ? <p className={noteClass}>Údaje nie sú dostupné.</p> : <MonitorTable headers={["Smer", "Spolu", "Prijaté", "Neprijaté", "Aktívne", "Priemer čakania", "Priemer od prijatia po koniec"]} rows={overview.calls.map(item => ({ key: item.direction, cells: [{ inbound: "Prichádzajúce", outbound: "Odchádzajúce", internal: "Interné" }[item.direction], item.total, item.answered, item.unanswered, item.active, duration(item.averageWaitSeconds), duration(item.averageAnsweredToEndSeconds)] }))} />}</>;
}
