"use client";

import { useEffect, useState } from "react";
import { FileText, RefreshCw, Trash2 } from "lucide-react";
import type { CallAnalysisFact, CallRecordingDetail as Detail, QualityEvidence } from "@/lib/telephony/recording-quality";
import { RecordingControlActions } from "./CallRecordingControls";
import { OperatorQualityCard } from "./OperatorQualityCard";
import { RecordingPlayer, type RecordingSeek } from "./RecordingPlayer";
import { TranscriptCorrectionEditor } from "./TranscriptCorrectionEditor";
import { canShowRecordingContent, CONTENT_LABELS, playbackTarget, qualityPercent } from "./recording-presentation";
import { recordingErrorMessage, recordingRequest } from "./recording-client";
import { formatRecordingTime, RecordingLoading, RecordingMessage, RecordingSection, recordingButtonClass, recordingInputClass } from "./recording-ui";
import { useRecordingResource } from "./use-recording-resource";

const outcomeLabels = { resolved: "Vyriešené", next_step_agreed: "Dohodnutý ďalší krok", awaiting_confirmation: "Čaká na overenie", transferred: "Prepojené", interrupted: "Prerušené", unknown: "Výsledok nezistený" };

export function CallRecordingDetail({ callId }: { callId: string }) {
  const resource = useRecordingResource<Detail>(`/api/telephony/calls/${encodeURIComponent(callId)}/recording-detail`);
  const [seek, setSeek] = useState<RecordingSeek | null>(null);
  const [seekError, setSeekError] = useState<string | null>(null);
  const [editingTranscript, setEditingTranscript] = useState<string | null>(null);
  const detail = resource.data;
  useEffect(() => {
    if (!detail || !["pending", "processing"].includes(detail.state)) return;
    const timer = setTimeout(resource.refresh, 10_000);
    return () => clearTimeout(timer);
  }, [detail, resource.refresh]);
  function seekTo(seconds: number, segmentId: string) {
    if (!detail) return;
    const target = playbackTarget(detail, seconds, segmentId);
    if (!target) { setSeek(null); setSeekError("Tento čas nie je v dostupnej nahrávke. Text môže patriť do chýbajúceho alebo neprístupného úseku."); return; }
    setSeekError(null); setSeek((current) => ({ segmentId: target.segment.id, offsetSeconds: target.offsetSeconds, sequence: (current?.sequence ?? 0) + 1, play: true }));
  }
  const evidenceSeek = (evidence: QualityEvidence) => seekTo(evidence.startSeconds, evidence.segmentId);
  return <div className="min-w-0 space-y-4" data-testid="call-recording-detail">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-semibold text-zinc-950">Záznam a kvalita hovoru</h2><button type="button" className={recordingButtonClass} onClick={resource.refresh} disabled={resource.loading}><RefreshCw size={14} />Obnoviť</button></div>
    {resource.loading && <RecordingLoading />}
    {resource.error != null && <RecordingMessage error>{recordingErrorMessage(resource.error)}</RecordingMessage>}
    {detail && <>
      <div className="flex flex-wrap gap-2 text-xs font-medium text-zinc-600"><span className="rounded-full bg-zinc-100 px-2 py-1">Nahrávka: {CONTENT_LABELS[detail.state]}</span><span className="rounded-full bg-zinc-100 px-2 py-1">Prepis: {CONTENT_LABELS[detail.transcript.status]}</span><span className="rounded-full bg-zinc-100 px-2 py-1">Analýza: {detail.analysis ? detail.analysis.status === "stale" ? "Podklady zmenené" : detail.analysis.status === "failed" ? "Zlyhala" : "Pripravená na kontrolu" : "Zatiaľ nie je dostupná"}</span></div>
      {detail.stateReason && <RecordingMessage>{detail.stateReason}</RecordingMessage>}
      {detail.access === "restricted" || ["restricted", "deleted", "disabled"].includes(detail.state) ? <RecordingMessage>{detail.state === "deleted" ? "Záznam bol odstránený alebo jeho platnosť skončila. Nahrávka ani odvodené údaje nie sú dostupné." : detail.state === "disabled" ? "Pre tento hovor nebol vytvorený záznam." : "Nahrávka, prepis a analýza tohto hovoru sú obmedzené."}</RecordingMessage> : <>
        {detail.access === "own_review" && <RecordingMessage>Máte prístup k svojmu hodnoteniu. Nahrávka a obsah zákazníckeho rozhovoru nie sú v tomto pohľade dostupné.</RecordingMessage>}
        {canShowRecordingContent(detail) && <>
          <RecordingControlActions detail={detail} onUpdated={resource.replace} />
          <RecordingPlayer detail={detail} seek={seek} onSeek={seekTo} />
          {seekError && <RecordingMessage error>{seekError}</RecordingMessage>}
          {detail.analysis && detail.analysis.status !== "failed" && <RecordingSection title="Čo sa v hovore riešilo" accessory={<span className="text-xs text-zinc-500">AI súhrn · overujte podľa záznamu</span>}>
            {detail.analysis.status === "stale" && <RecordingMessage>Podklady sa zmenili. Tento súhrn potrebuje nové spracovanie.</RecordingMessage>}
            <p className="text-sm font-semibold text-zinc-900">{detail.analysis.topic}</p><p className="whitespace-pre-wrap break-words text-sm leading-6 text-zinc-700">{detail.analysis.summary}</p>
            <dl className="grid gap-2 text-sm"><div><dt className="text-xs font-semibold uppercase text-zinc-500">Dôvod volania</dt><dd className="mt-1 text-zinc-800">{detail.analysis.reason ?? "Dôvod nebol uvedený."}</dd></div><div><dt className="text-xs font-semibold uppercase text-zinc-500">Výsledok</dt><dd className="mt-1 text-zinc-800">{outcomeLabels[detail.analysis.outcome]}</dd></div></dl>
            <FactList title="Zistené údaje" facts={detail.analysis.facts} onSeek={evidenceSeek} /><FactList title="Postup operátora" facts={detail.analysis.actions} onSeek={evidenceSeek} /><FactList title="Ďalší krok: kto, čo a kedy" facts={detail.analysis.nextSteps} onSeek={evidenceSeek} />
            {detail.analysis.warnings.map((warning, index) => <RecordingMessage key={index}>{warning}</RecordingMessage>)}
          </RecordingSection>}
          {detail.metrics && <RecordingSection title="Priebeh komunikácie" accessory={<span className="text-xs text-zinc-500">{detail.metrics.estimated ? "Rečové časy sú odhad" : "Časy zo záznamu"}</span>}>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">{[
              ["Dĺžka hovoru", formatRecordingTime(detail.metrics.durationSeconds)], ["Spojený rozhovor", formatRecordingTime(detail.metrics.connectedSeconds)], ["Podržanie", formatRecordingTime(detail.metrics.holdSeconds)], ["Reč operátora", formatRecordingTime(detail.metrics.operatorSpeechSeconds)], ["Reč zákazníka", formatRecordingTime(detail.metrics.customerSpeechSeconds)], ["Podiel reči operátora", qualityPercent(detail.metrics.operatorSpeechShare)], ["Prekrývanie reči", formatRecordingTime(detail.metrics.overlapSeconds)], ["Ticho v rozhovore", formatRecordingTime(detail.metrics.silenceSeconds)], ["Prepojenia", String(detail.metrics.transferCount)],
            ].map(([label, value]) => <div key={label} className="rounded-md bg-zinc-50 p-2"><dt className="text-xs text-zinc-500">{label}</dt><dd className="mt-1 text-base font-semibold tabular-nums text-zinc-900">{value}</dd></div>)}</dl>
            <p className="text-xs leading-5 text-zinc-500">Podiel reči = reč operátora / súčet reči operátora a zákazníka v hodnotiteľnom úseku. Nejde o podiel z celého hovoru. Podržanie ani dĺžka rozhovoru samy nemenia hodnotenie.</p>
          </RecordingSection>}
          <RecordingSection title="Časový prepis" accessory={<span className="text-xs text-zinc-500">{detail.transcript.language?.toUpperCase() ?? "Jazyk nezistený"}</span>}>
            {detail.transcript.spans.length === 0 ? <p className="text-sm text-zinc-600">{CONTENT_LABELS[detail.transcript.status]}. Prepis zatiaľ nie je dostupný.</p> : <div className="space-y-2">{detail.transcript.spans.map((span) => <button key={span.id} type="button" onClick={() => seekTo(span.startSeconds, span.segmentId)} className={`block w-full rounded-md border px-3 py-2 text-left ${span.role === "operator" && span.identityVerified ? "border-yellow-200 bg-yellow-50" : "border-zinc-100 bg-zinc-50"}`}><span className="mb-1 block text-xs font-semibold text-zinc-500">{formatRecordingTime(span.startSeconds)} · {span.identityVerified || span.role === "system" ? span.speakerLabel : "Hovoriaci · identita neoverená"}{span.role === "system" ? " · automatická hláška" : ""}</span><span className="whitespace-pre-wrap break-words text-sm text-zinc-800">{span.text}</span></button>)}</div>}
            {detail.capabilities.canCorrect && <div className="flex flex-wrap gap-2">{Array.from(new Set(detail.transcript.spans.map((span) => span.transcriptId))).map((transcriptId, index) => <button key={transcriptId} type="button" className={recordingButtonClass} onClick={() => setEditingTranscript((current) => current === transcriptId ? null : transcriptId)} aria-expanded={editingTranscript === transcriptId}><FileText size={14} />Opraviť prepis {index + 1}</button>)}</div>}
            {editingTranscript && detail.capabilities.canCorrect && <TranscriptCorrectionEditor key={editingTranscript} detail={detail} transcriptId={editingTranscript} onUpdated={resource.replace} />}
          </RecordingSection>
        </>}
        {detail.analysis?.operators.map((evaluation) => <OperatorQualityCard key={evaluation.operatorId} detail={detail} evaluation={evaluation} onSeek={evidenceSeek} onUpdated={resource.replace} />)}
        {detail.analysis && !detail.analysis.operators.length && <RecordingMessage>Pre individuálne hodnotenie zatiaľ nie sú overené podklady operátora.</RecordingMessage>}
      </>}
      {detail.access === "full" && <RecordingMaintenance detail={detail} onUpdated={resource.replace} />}
    </>}
  </div>;
}

function FactList({ title, facts, onSeek }: { title: string; facts: CallAnalysisFact[]; onSeek: (evidence: QualityEvidence) => void }) {
  if (!facts.length) return null;
  return <div><h4 className="text-xs font-semibold uppercase text-zinc-500">{title}</h4><dl className="mt-2 space-y-2">{facts.map((fact, index) => <div key={index} className="rounded-md bg-zinc-50 p-2"><dt className="text-xs font-semibold text-zinc-600">{fact.label}</dt><dd className="mt-1 break-words text-sm text-zinc-900">{fact.value ?? "Nezistené"}</dd><dd className="mt-1 flex flex-wrap gap-2">{fact.evidence.map((evidence) => <button key={evidence.id} type="button" onClick={() => onSeek(evidence)} className="min-h-8 text-xs font-medium text-zinc-600 underline decoration-yellow-400 underline-offset-4">Overiť {formatRecordingTime(evidence.startSeconds)}</button>)}</dd></div>)}</dl></div>;
}

function RecordingMaintenance({ detail, onUpdated }: { detail: Detail; onUpdated: (detail: Detail) => void }) {
  const [deleting, setDeleting] = useState(false); const [reason, setReason] = useState(""); const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [uncertain, setUncertain] = useState(false);
  if ((!detail.capabilities.canRetry && !detail.capabilities.canDelete) || ["restricted", "deleted", "disabled"].includes(detail.state)) return null;
  async function mutate(action: "retry" | "delete") {
    if (busy || uncertain || (action === "delete" && (!confirmed || !reason.trim()))) return;
    setBusy(true); setError(null);
    try { const updated = await recordingRequest<Detail>(`/api/telephony/calls/${encodeURIComponent(detail.callId)}/${action === "retry" ? "recording-retry" : "recording-detail"}`, { method: action === "retry" ? "POST" : "DELETE", body: { sourceRevision: detail.sourceRevision, ...(action === "delete" ? { reason: reason.trim() } : {}) } }); onUpdated(updated); setDeleting(false); }
    catch (caught) { setError(recordingErrorMessage(caught)); setUncertain(true); } finally { setBusy(false); }
  }
  async function refresh() { setBusy(true); try { onUpdated(await recordingRequest<Detail>(`/api/telephony/calls/${encodeURIComponent(detail.callId)}/recording-detail`)); setUncertain(false); setError(null); } catch (caught) { setError(recordingErrorMessage(caught)); } finally { setBusy(false); } }
  return <div className="space-y-3 border-t border-zinc-200 pt-3"><div className="flex flex-wrap gap-2">{detail.capabilities.canRetry && <button type="button" className={recordingButtonClass} disabled={busy || uncertain} onClick={() => void mutate("retry")}>Znova zaradiť spracovanie</button>}{detail.capabilities.canDelete && <button type="button" className={recordingButtonClass} disabled={busy} onClick={() => setDeleting((current) => !current)}><Trash2 size={14} />Odstrániť záznam</button>}</div>
    {deleting && <div className="space-y-2 rounded-md border border-red-200 p-3"><label className="block text-xs font-semibold text-zinc-600">Dôvod odstránenia<textarea aria-label="Dôvod odstránenia" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={2000} className={`${recordingInputClass} mt-1`} /></label><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1" />Odstrániť dostupný záznam aj prístup k odvodeným údajom. Dokončenie odstránenia u poskytovateľov sa eviduje samostatne.</label><button type="button" className={`${recordingButtonClass} text-red-800`} disabled={busy || uncertain || !confirmed || !reason.trim()} onClick={() => void mutate("delete")}>Potvrdiť odstránenie</button></div>}
    {error && <RecordingMessage error>{error}</RecordingMessage>}{uncertain && <button type="button" className={recordingButtonClass} disabled={busy} onClick={() => void refresh()}>Overiť výsledok pred ďalším pokusom</button>}
  </div>;
}
