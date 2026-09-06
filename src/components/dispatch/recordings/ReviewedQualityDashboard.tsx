"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, SlidersHorizontal, X } from "lucide-react";
import { QUALITY_RUBRIC_VERSION, type QualityDashboardResponse } from "@/lib/telephony/recording-quality";
import { CallRecordingDetail } from "./CallRecordingDetail";
import { RecordingRequestError, recordingErrorMessage } from "./recording-client";
import { qualityPercent } from "./recording-presentation";
import { RecordingLoading, RecordingMessage, RecordingSection, recordingButtonClass, recordingInputClass } from "./recording-ui";
import { useRecordingResource } from "./use-recording-resource";

type Filters = { from: string; to: string; operatorId: string; language: string; status: string; rubricVersion: string };
const statusLabels = { draft: "AI návrh", approved: "Schválené", stale: "Podklady zmenené", unscorable: "Nedostatok podkladov" };
function initialFilters(): Filters {
  const now = new Date(); const start = new Date(now); start.setDate(start.getDate() - 30);
  return { from: start.toISOString().slice(0, 10), to: now.toISOString().slice(0, 10), operatorId: "", language: "", status: "", rubricVersion: QUALITY_RUBRIC_VERSION };
}
function dashboardUrl(filters: Filters, page: number) {
  const params = new URLSearchParams({ from: new Date(`${filters.from}T00:00:00`).toISOString(), to: new Date(`${filters.to}T23:59:59.999`).toISOString(), page: String(page), pageSize: "20", rubricVersion: filters.rubricVersion });
  for (const field of ["operatorId", "language", "status"] as const) if (filters[field]) params.set(field, filters[field]);
  return `/api/telephony/quality/dashboard?${params.toString()}`;
}

export function ReviewedQualityDashboard() {
  const [filters, setFilters] = useState(initialFilters); const [draft, setDraft] = useState(filters); const [page, setPage] = useState(1); const [callId, setCallId] = useState<string | null>(null);
  const [knownOperators, setKnownOperators] = useState<Array<{ operatorId: string; operatorName: string }>>([]);
  const resource = useRecordingResource<QualityDashboardResponse>(dashboardUrl(filters, page));
  // Preserve selectable names when a filtered response contains only one person.
  useEffect(() => {
    if (!resource.data) return;
    const operators = resource.data.operators;
    queueMicrotask(() => setKnownOperators((previous) => Array.from(new Map([...previous, ...operators].map((operator) => [operator.operatorId, { operatorId: operator.operatorId, operatorName: operator.operatorName }])).values())));
  }, [resource.data]);
  if (resource.error instanceof RecordingRequestError && (resource.error.status === 401 || resource.error.status === 403)) return <div className="md:col-span-2 xl:col-span-12"><RecordingMessage>Na prehľad kontroly rozhovorov potrebujete príslušné oprávnenie.</RecordingMessage></div>;
  const data = resource.data;
  return <div className="min-w-0 space-y-3 md:col-span-2 xl:col-span-12" data-testid="reviewed-quality-dashboard">
    <RecordingSection title="Kontrola rozhovorov" accessory={<span className="text-xs text-zinc-500">Trendy zo schválených kontrol</span>}>
      <p className="text-sm leading-6 text-zinc-600">AI pripravuje podklady. Personálne priemery a trend obsahujú iba aktuálne ľudské schválenia rovnakej verzie rubriky; návrhy ani zneplatnené kontroly ich nemenia.</p>
      <form className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(event) => { event.preventDefault(); if (!draft.from || !draft.to || draft.from > draft.to) return; setFilters(draft); setPage(1); }}>
        <FilterField label="Od"><input aria-label="Od" type="date" required className={recordingInputClass} value={draft.from} max={draft.to} onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))} /></FilterField>
        <FilterField label="Do"><input aria-label="Do" type="date" required className={recordingInputClass} value={draft.to} min={draft.from} onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))} /></FilterField>
        <FilterField label="Operátor"><select aria-label="Operátor" className={recordingInputClass} value={draft.operatorId} onChange={(event) => setDraft((current) => ({ ...current, operatorId: event.target.value }))}><option value="">Všetci operátori</option>{knownOperators.slice().sort((a, b) => a.operatorName.localeCompare(b.operatorName, "sk")).map((operator) => <option key={operator.operatorId} value={operator.operatorId}>{operator.operatorName}</option>)}</select></FilterField>
        <FilterField label="Jazyk"><select aria-label="Jazyk" className={recordingInputClass} value={draft.language} onChange={(event) => setDraft((current) => ({ ...current, language: event.target.value }))}><option value="">Všetky jazyky</option><option value="sk">Slovenčina</option><option value="cs">Čeština</option><option value="en">Angličtina</option><option value="de">Nemčina</option></select></FilterField>
        <FilterField label="Stav kontroly"><select aria-label="Stav kontroly" className={recordingInputClass} value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value }))}><option value="">Všetky stavy</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></FilterField>
        <FilterField label="Verzia rubriky"><select aria-label="Verzia rubriky" className={recordingInputClass} value={draft.rubricVersion} onChange={(event) => setDraft((current) => ({ ...current, rubricVersion: event.target.value }))}><option value={QUALITY_RUBRIC_VERSION}>{QUALITY_RUBRIC_VERSION}</option></select></FilterField>
        <div className="flex items-end"><button type="submit" className={`${recordingButtonClass} w-full border-yellow-400 bg-yellow-300`} disabled={resource.loading || !draft.from || !draft.to || draft.from > draft.to}><SlidersHorizontal size={15} />Použiť filtre</button></div>
        <div className="flex items-end"><button type="button" className={`${recordingButtonClass} w-full`} onClick={resource.refresh} disabled={resource.loading}>Obnoviť prehľad</button></div>
      </form>
      {resource.loading && <RecordingLoading label="Načítavam kontroly rozhovorov…" />}{resource.error != null && <RecordingMessage error>{recordingErrorMessage(resource.error)}</RecordingMessage>}
      {data && <>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">{[["Hodnotené hovory", data.totals.calls], ["Schválené kontroly", data.totals.approved], ["AI návrhy", data.totals.drafts], ["Bez dostatku podkladov", data.totals.unscorable], ["Spracovanie zlyhalo", data.totals.failed]].map(([label, count]) => <div key={label} className="rounded-md bg-zinc-50 p-3"><dt className="text-xs text-zinc-500">{label}</dt><dd className="mt-1 text-2xl font-semibold tabular-nums text-zinc-950">{count}</dd></div>)}</dl>
        {data.total === 0 && <RecordingMessage>Vybranému obdobiu a filtrom zatiaľ nezodpovedá žiadne hodnotenie. Chýbajúce výsledky neznamenajú nulové skóre.</RecordingMessage>}
        <div className="grid min-w-0 gap-4 lg:grid-cols-2"><div><h4 className="mb-2 text-sm font-semibold text-zinc-900">Schválené kontroly podľa operátora</h4>{data.operators.length === 0 ? <p className="text-sm text-zinc-500">Zatiaľ bez schválených kontrol.</p> : <div className="space-y-2">{data.operators.slice().sort((a, b) => a.operatorName.localeCompare(b.operatorName, "sk")).map((operator) => <div key={operator.operatorId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-100 p-2"><div><p className="text-sm font-medium text-zinc-900">{operator.operatorName}</p><p className="text-xs text-zinc-500">{operator.approvedCalls} schválených hovorov{operator.smallSample || operator.approvedCalls < 10 ? " · Malá vzorka" : ""}</p></div><span className="text-sm font-semibold tabular-nums text-zinc-700">{operator.smallSample || operator.approvedCalls < 10 || operator.averageScore == null ? "—" : `${Math.round(operator.averageScore)}/100`}</span></div>)}</div>}</div>
          <div><h4 className="mb-2 text-sm font-semibold text-zinc-900">Trend schválených kontrol</h4>{data.trend.length === 0 ? <p className="text-sm text-zinc-500">Pre trend ešte nie sú schválené podklady.</p> : <div className="space-y-2">{data.trend.map((period) => <div key={period.period} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-md border border-zinc-100 p-2"><div className="min-w-0"><p className="break-words text-xs font-semibold text-zinc-700">{period.period}</p><p className="text-xs text-zinc-500">{period.approvedCalls} schválených{period.approvedCalls < 10 ? " · Malá vzorka" : ""}</p></div><span className="text-sm font-semibold tabular-nums">{period.averageScore == null || period.approvedCalls < 10 ? "—" : `${Math.round(period.averageScore)}/100`}</span>{period.averageScore != null && period.approvedCalls >= 10 && <div className="col-span-2 h-1.5 overflow-hidden rounded-full bg-zinc-100" aria-hidden="true"><div className="h-full bg-yellow-400" style={{ width: `${Math.max(0, Math.min(100, period.averageScore))}%` }} /></div>}</div>)}</div>}</div>
        </div>
        <p className="text-xs text-zinc-500">Pri menej než 10 schválených hovoroch sa priemer nezobrazuje. Operátori sú zoradení podľa mena, bez poradia podľa výkonu.</p>
        <div className="divide-y divide-zinc-100 border-t border-zinc-200">{data.rows.map((row, index) => <button key={`${row.callId}:${row.operatorId}:${index}`} type="button" onClick={() => setCallId(row.callId)} className="grid w-full min-w-0 gap-2 px-1 py-3 text-left hover:bg-zinc-50 sm:grid-cols-[minmax(0,1fr)_150px_100px]"><span className="min-w-0"><span className="block break-words text-sm font-semibold text-zinc-900">{row.topic || "Hovor bez určenej témy"}</span><span className="mt-1 block text-xs text-zinc-500">{row.operatorName} · {new Date(row.startedAt).toLocaleString("sk-SK")} · {row.language?.toUpperCase() ?? "Jazyk nezistený"}</span></span><span className="text-xs text-zinc-600">{statusLabels[row.status]}<span className="mt-1 block">Pokrytie {qualityPercent(row.coverage)}</span></span><span className="text-sm font-semibold tabular-nums text-zinc-800">{row.score == null ? "Bez skóre" : `${row.score}/100`}</span></button>)}</div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-200 pt-3"><p className="text-xs text-zinc-500">{data.total ? (data.page - 1) * data.pageSize + 1 : 0}–{Math.min(data.page * data.pageSize, data.total)} z {data.total} výsledkov</p><nav className="flex items-center gap-2" aria-label="Stránkovanie kontrol"><button type="button" className={recordingButtonClass} disabled={data.page <= 1} onClick={() => setPage(data.page - 1)} aria-label="Predchádzajúca strana kontrol"><ChevronLeft size={15} /></button><span className="text-xs">{data.page} / {Math.max(1, Math.ceil(data.total / data.pageSize))}</span><button type="button" className={recordingButtonClass} disabled={data.page * data.pageSize >= data.total} onClick={() => setPage(data.page + 1)} aria-label="Nasledujúca strana kontrol"><ChevronRight size={15} /></button></nav></div>
      </>}
    </RecordingSection>
    {callId && <QualityCallDialog callId={callId} onClose={() => setCallId(null)} />}
  </div>;
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block min-w-0"><span className="mb-1 block text-xs font-semibold text-zinc-500">{label}</span>{children}</label>; }

function QualityCallDialog({ callId, onClose }: { callId: string; onClose: () => void }) {
  const container = useRef<HTMLDivElement>(null); const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    close.current?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key !== "Tab") return;
      const controls = container.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), audio[controls], [tabindex="0"]');
      if (!controls?.length) return;
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    window.addEventListener("keydown", keydown);
    return () => { window.removeEventListener("keydown", keydown); if (previous instanceof HTMLElement) previous.focus(); };
  }, [onClose]);
  return <div className="fixed inset-0 z-[2147483200] bg-zinc-950/30"><div ref={container} role="dialog" aria-modal="true" aria-labelledby="quality-call-title" className="absolute inset-y-0 right-0 flex w-full max-w-3xl flex-col border-l border-zinc-200 bg-white shadow-xl"><header className="flex shrink-0 items-center justify-between gap-3 border-b border-zinc-200 p-3"><h2 id="quality-call-title" className="text-sm font-semibold">Podklady ku kontrole hovoru</h2><button ref={close} type="button" className={recordingButtonClass} onClick={onClose} aria-label="Zavrieť podklady hovoru"><X size={18} /></button></header><div className="min-h-0 flex-1 overflow-y-auto p-3"><CallRecordingDetail key={callId} callId={callId} /></div></div></div>;
}
