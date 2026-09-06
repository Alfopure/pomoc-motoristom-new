"use client";

import { useState } from "react";
import { CheckCircle2, MessageSquare, Save } from "lucide-react";
import { QUALITY_CRITERIA, type CallRecordingDetail, type OperatorQualityEvaluation, type QualityCriterion, type QualityEvidence, type QualityReviewInput, type QualityVerdict } from "@/lib/telephony/recording-quality";
import { isTelephonyTimeout } from "@/lib/telephony/client-request";
import { RecordingRequestError, recordingErrorMessage, recordingRequest } from "./recording-client";
import { qualityPercent, VERDICT_LABELS } from "./recording-presentation";
import { formatRecordingTime, RecordingMessage, RecordingSection, recordingButtonClass, recordingInputClass } from "./recording-ui";

type Props = { detail: CallRecordingDetail; evaluation: OperatorQualityEvaluation; onSeek: (evidence: QualityEvidence) => void; onUpdated: (detail: CallRecordingDetail) => void };

export function OperatorQualityCard({ detail, evaluation, onSeek, onUpdated }: Props) {
  const [editing, setEditing] = useState(false);
  const [appealing, setAppealing] = useState(false);
  const approved = evaluation.review?.status === "approved";
  const outdated = !approved && (detail.analysis?.status === "stale" || detail.analysis?.status === "failed");
  const criteria = approved ? evaluation.review!.criteria : evaluation.criteria;
  const score = outdated && !approved ? null : approved ? evaluation.review!.score : evaluation.score;
  const coverage = outdated && !approved ? null : approved ? evaluation.review!.coverage : evaluation.coverage;
  const blocked = detail.state === "restricted" || detail.state === "deleted" || detail.state === "disabled" || detail.access === "restricted";
  if (blocked) return null;
  return <RecordingSection title={evaluation.operatorName} accessory={<span className={`rounded-full px-2 py-1 text-xs font-semibold ${approved ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900"}`}>{approved ? "Skontrolované človekom" : evaluation.review?.status === "stale" ? "Čaká na novú kontrolu" : "AI návrh · vyžaduje kontrolu"}</span>}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><p className="text-2xl font-semibold tabular-nums text-zinc-950">{score == null ? "Nedostatok podkladov" : `${score}/100`}</p><p className="mt-1 text-xs text-zinc-600">Pokrytie podkladmi {qualityPercent(coverage)} · {evaluation.rubricVersion}</p></div>
      {approved && <CheckCircle2 size={25} className="text-emerald-600" aria-hidden="true" />}
    </div>
    {evaluation.review?.status === "stale" && <RecordingMessage>Podklady sa zmenili — hodnotenie je vyradené z trendu a čaká na novú kontrolu.</RecordingMessage>}
    {evaluation.eligibilityReasons.length > 0 && <ul className="space-y-1 text-sm text-zinc-600">{evaluation.eligibilityReasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
    <p className="text-xs leading-5 text-zinc-500">Neisté kritérium nedostáva nulu. Automatický pozdrav sa nepripisuje operátorovi; podiel reči sám osebe nemení skóre.</p>
    {(evaluation.speechSeconds !== undefined || evaluation.speechShare !== undefined || evaluation.connectedSeconds !== undefined) && <div className="rounded-md bg-zinc-50 p-3"><h4 className="text-xs font-semibold text-zinc-600">Komunikácia tohto operátora · odhad</h4><dl className="mt-2 grid grid-cols-3 gap-2 text-xs"><div><dt className="text-zinc-500">Reč</dt><dd className="mt-1 font-semibold tabular-nums">{formatRecordingTime(evaluation.speechSeconds)}</dd></div><div><dt className="text-zinc-500">Podiel reči</dt><dd className="mt-1 font-semibold tabular-nums">{qualityPercent(evaluation.speechShare)}</dd></div><div><dt className="text-zinc-500">Spojený úsek</dt><dd className="mt-1 font-semibold tabular-nums">{formatRecordingTime(evaluation.connectedSeconds)}</dd></div></dl></div>}
    <div className="divide-y divide-zinc-100">{QUALITY_CRITERIA.map((definition) => {
      const criterion = criteria.find((item) => item.id === definition.id);
      return <div key={definition.id} className="space-y-1.5 py-3">
        <div className="flex flex-wrap justify-between gap-2 text-sm"><span className="font-medium text-zinc-900">{definition.label} <span className="text-xs font-normal text-zinc-500">· váha {definition.weight}</span></span><span className="text-xs font-semibold text-zinc-600">{VERDICT_LABELS[criterion?.verdict ?? "unknown"]}</span></div>
        {criterion?.reason && <p className="text-sm text-zinc-700">{criterion.reason}</p>}
        {criterion?.applicabilityReason && <p className="text-xs text-zinc-500">Použiteľnosť: {criterion.applicabilityReason}</p>}
        {criterion?.uncertaintyReason && <p className="text-xs text-amber-800">Neistota: {criterion.uncertaintyReason}</p>}
        {criterion?.absenceWindow && <p className="text-xs text-zinc-500">Posudzované okno: {{ opening: "úvod", conversation: "rozhovor", closing: "ukončenie" }[criterion.absenceWindow]}. Neprítomnosť vyjadrenia nie je citácia.</p>}
        {detail.access === "full" && criterion?.evidence.map((evidence) => <button key={evidence.id} type="button" onClick={() => onSeek(evidence)} className="block w-full rounded-md border-l-2 border-yellow-400 bg-zinc-50 px-3 py-2 text-left text-sm text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400"><span className="block text-xs font-semibold text-zinc-500">{formatRecordingTime(evidence.startSeconds)} · {evidence.speakerLabel}</span><span className="break-words">„{evidence.text}“</span></button>)}
      </div>;
    })}</div>
    {evaluation.coaching.length > 0 && <div className="rounded-md bg-yellow-50 p-3"><h4 className="text-sm font-semibold text-zinc-900">Podnety na zlepšenie</h4><ul className="mt-1 space-y-1 text-sm text-zinc-700">{evaluation.coaching.map((note, index) => <li key={index}>{note}</li>)}</ul></div>}
    {evaluation.review && <p className="text-xs text-zinc-500">Kontrola: {evaluation.review.reviewerName} · {new Date(evaluation.review.reviewedAt).toLocaleString("sk-SK")}<span className="mt-1 block break-words">{evaluation.review.note}</span></p>}
    <div className="flex flex-wrap gap-2">
      {detail.capabilities.canReview && detail.access === "full" && <button type="button" className={recordingButtonClass} disabled={outdated} onClick={() => setEditing((value) => !value)} aria-expanded={editing}><Save size={14} />Skontrolovať hodnotenie</button>}
      {detail.capabilities.canAppeal && <button type="button" className={recordingButtonClass} onClick={() => setAppealing((value) => !value)} aria-expanded={appealing}><MessageSquare size={14} />Pripomienka k hodnoteniu</button>}
    </div>
    {editing && !outdated && <QualityReviewEditor detail={detail} evaluation={evaluation} onUpdated={onUpdated} />}
    {appealing && <QualityAppealEditor detail={detail} evaluation={evaluation} onUpdated={onUpdated} />}
  </RecordingSection>;
}

function reviewDraft(detail: CallRecordingDetail, evaluation: OperatorQualityEvaluation): QualityReviewInput {
  return { analysisId: evaluation.analysisId ?? detail.analysis!.id, operatorId: evaluation.operatorId, sourceRevision: detail.sourceRevision, expectedReviewId: evaluation.review?.status === "approved" ? evaluation.review.id : null, criteria: structuredClone(evaluation.review?.status === "approved" ? evaluation.review.criteria : evaluation.criteria), note: "" };
}

function QualityReviewEditor({ detail, evaluation, onUpdated }: Omit<Props, "onSeek">) {
  const [draft, setDraft] = useState(() => reviewDraft(detail, evaluation));
  const [busy, setBusy] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [needsConfirmation, setNeedsConfirmation] = useState(false);
  const [revalidated, setRevalidated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const stale = draft.sourceRevision !== detail.sourceRevision || draft.analysisId !== (evaluation.analysisId ?? detail.analysis?.id) || draft.expectedReviewId !== (evaluation.review?.status === "approved" ? evaluation.review.id : null);
  const evidenceOptions = detail.transcript.spans.filter((span) => span.identityVerified && ((span.role === "operator" && span.operatorId === evaluation.operatorId) || span.role === "customer"));
  const invalid = !draft.note.trim() || draft.criteria.length !== QUALITY_CRITERIA.length || draft.criteria.some((criterion) => !criterion.reason.trim() || (criterion.verdict === "not_applicable" && !criterion.applicabilityReason?.trim()) || ((criterion.verdict === "met" || criterion.verdict === "partial") && !criterion.evidence.some((evidence) => evidence.operatorId === evaluation.operatorId)) || (criterion.verdict === "not_met" && !criterion.evidence.length && !criterion.absenceWindow));
  async function refreshForReview() {
    setBusy(true); setError(null);
    try {
      const fresh = await recordingRequest<CallRecordingDetail>(`/api/telephony/calls/${encodeURIComponent(detail.callId)}/recording-detail`);
      onUpdated(fresh);
      const current = fresh.analysis?.operators.find((operator) => operator.operatorId === evaluation.operatorId);
      if (!current || !fresh.capabilities.canReview || fresh.access !== "full" || ["restricted", "deleted", "disabled"].includes(fresh.state)) throw new Error("Aktuálne podklady už nemožno schváliť.");
      const baseline = reviewDraft(fresh, current);
      setDraft((previous) => ({ ...baseline, note: previous.note, criteria: baseline.criteria.map((criterion) => {
        const edit = previous.criteria.find((item) => item.id === criterion.id);
        return edit ? { ...criterion, verdict: edit.verdict, reason: edit.reason, absenceWindow: edit.absenceWindow, applicabilityReason: edit.applicabilityReason, uncertaintyReason: edit.uncertaintyReason, evidence: edit.evidence.flatMap((evidence) => {
          const span = fresh.transcript.spans.find((item) => item.id === evidence.id && item.identityVerified && ((item.role === "operator" && item.operatorId === current.operatorId) || item.role === "customer"));
          return span ? [{ id: span.id, segmentId: span.segmentId, startSeconds: span.startSeconds, endSeconds: span.endSeconds, text: span.text, speakerLabel: span.speakerLabel, operatorId: span.operatorId }] : [];
        }) } : criterion;
      }) }));
      setNeedsRefresh(false); setNeedsConfirmation(true); setRevalidated(true);
    } catch (caught) { setError(recordingErrorMessage(caught)); }
    finally { setBusy(false); }
  }
  async function save() {
    if (busy || stale || needsRefresh || needsConfirmation || invalid) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const updated = await recordingRequest<CallRecordingDetail>(`/api/telephony/calls/${encodeURIComponent(detail.callId)}/quality/review`, { method: "POST", body: draft });
      onUpdated(updated);
      const current = updated.analysis?.operators.find((operator) => operator.operatorId === evaluation.operatorId);
      if (current && updated.analysis) setDraft({ ...reviewDraft(updated, current), note: draft.note });
      setNotice("Kontrola bola uložená podľa aktuálnych podkladov.");
    } catch (caught) {
      setError(recordingErrorMessage(caught));
      if ((caught instanceof RecordingRequestError && caught.status === 409) || isTelephonyTimeout(caught)) setNeedsRefresh(true);
    } finally { setBusy(false); }
  }
  function editCriterion(id: string, patch: Partial<QualityCriterion>) { setDraft((current) => ({ ...current, criteria: current.criteria.map((criterion) => criterion.id === id ? { ...criterion, ...patch } : criterion) })); setNotice(null); }
  return <div className="space-y-3 rounded-md border border-yellow-300 bg-yellow-50/40 p-3" aria-label={`Kontrola hodnotenia ${evaluation.operatorName}`}>
    <h4 className="text-sm font-semibold">Rozhodnutie kontrolóra</h4>
    <p className="text-xs text-zinc-600">Upravte záver a zdôvodnenie podľa dôkazov. Skóre vypočíta server; do trendu sa započíta až platne schválená verzia.</p>
    {draft.criteria.map((criterion) => <div key={criterion.id} className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_180px]">
      <label className="min-w-0 text-xs font-semibold text-zinc-600">{QUALITY_CRITERIA.find((item) => item.id === criterion.id)?.label}<textarea aria-label={`Zdôvodnenie: ${QUALITY_CRITERIA.find((item) => item.id === criterion.id)?.label ?? criterion.id}`} className={`${recordingInputClass} mt-1 min-h-20`} value={criterion.reason} maxLength={2000} disabled={busy} onChange={(event) => editCriterion(criterion.id, { reason: event.target.value })} /></label>
      <label className="min-w-0 text-xs font-semibold text-zinc-600">Záver<select aria-label={`Záver: ${QUALITY_CRITERIA.find((item) => item.id === criterion.id)?.label ?? criterion.id}`} className={`${recordingInputClass} mt-1`} value={criterion.verdict} disabled={busy} onChange={(event) => {
        const verdict = event.target.value as QualityVerdict;
        editCriterion(criterion.id, { verdict, uncertaintyReason: null, ...(verdict === "not_met" ? {} : { absenceWindow: null }), ...(verdict === "not_applicable" ? {} : { applicabilityReason: null }) });
      }}>{Object.entries(VERDICT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <details className="min-w-0 rounded-md border border-zinc-200 bg-white p-2 sm:col-span-2"><summary className="cursor-pointer text-xs font-semibold text-zinc-700">Dôkazy a použiteľnosť · {criterion.evidence.length} citácií</summary><div className="mt-2 space-y-3">
        <div className="max-h-48 space-y-2 overflow-y-auto">{evidenceOptions.map((span) => <label key={span.id} className="flex items-start gap-2 text-xs text-zinc-700"><input type="checkbox" disabled={busy || (!criterion.evidence.some((evidence) => evidence.id === span.id) && criterion.evidence.length >= 12)} checked={criterion.evidence.some((evidence) => evidence.id === span.id)} onChange={(event) => editCriterion(criterion.id, { evidence: event.target.checked ? [...criterion.evidence, { id: span.id, segmentId: span.segmentId, startSeconds: span.startSeconds, endSeconds: span.endSeconds, text: span.text, speakerLabel: span.speakerLabel, operatorId: span.operatorId }] : criterion.evidence.filter((evidence) => evidence.id !== span.id) })} className="mt-0.5 shrink-0" /><span className="min-w-0 break-words"><strong>{formatRecordingTime(span.startSeconds)} · {span.speakerLabel}</strong><span className="mt-0.5 block">{span.text}</span></span></label>)}</div>
        {criterion.verdict === "not_applicable" && <label className="block text-xs font-semibold text-zinc-600">Prečo sa kritérium nevzťahuje<textarea aria-label={`Použiteľnosť: ${criterion.id}`} className={`${recordingInputClass} mt-1`} disabled={busy} maxLength={2000} value={criterion.applicabilityReason ?? ""} onChange={(event) => editCriterion(criterion.id, { applicabilityReason: event.target.value })} /></label>}
        {criterion.verdict === "not_met" && <label className="block text-xs font-semibold text-zinc-600">Okno pre overenie chýbajúceho prejavu<select aria-label={`Okno neprítomnosti: ${criterion.id}`} className={`${recordingInputClass} mt-1`} disabled={busy} value={criterion.absenceWindow ?? ""} onChange={(event) => editCriterion(criterion.id, { absenceWindow: event.target.value ? event.target.value as QualityCriterion["absenceWindow"] : null })}><option value="">Záver je doložený citáciou</option><option value="opening">Úvod rozhovoru</option><option value="conversation">Celý relevantný rozhovor</option><option value="closing">Záver rozhovoru</option></select></label>}
        <label className="block text-xs font-semibold text-zinc-600">Zostávajúca neistota<textarea aria-label={`Neistota: ${criterion.id}`} className={`${recordingInputClass} mt-1`} disabled={busy} maxLength={2000} value={criterion.uncertaintyReason ?? ""} onChange={(event) => editCriterion(criterion.id, { uncertaintyReason: event.target.value.trim() ? event.target.value : null })} /></label><p className="text-xs text-zinc-500">Vyberajte iba skutočné výroky. Nezachytené časové okno ani neoverenú identitu nemožno odomknúť úpravou záveru.</p>
      </div></details>
    </div>)}
    <label className="block text-xs font-semibold text-zinc-600">Poznámka ku kontrole<textarea aria-label="Poznámka ku kontrole" className={`${recordingInputClass} mt-1 min-h-20`} value={draft.note} maxLength={2000} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, note: event.target.value }))} /></label>
    {error && <RecordingMessage error>{error}</RecordingMessage>}
    {(needsRefresh || stale) && <RecordingMessage>Vaše úpravy zostali zachované. Pred ďalším uložením načítajte a posúďte aktuálne podklady.</RecordingMessage>}
    {(needsRefresh || stale) && <button type="button" className={recordingButtonClass} disabled={busy} onClick={() => void refreshForReview()}>Načítať aktuálne podklady</button>}
    {revalidated && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={!needsConfirmation} onChange={(event) => setNeedsConfirmation(!event.target.checked)} className="mt-1" />Skontroloval som úpravy podľa aktuálnych podkladov.</label>}
    {notice && <RecordingMessage>{notice}</RecordingMessage>}
    <button type="button" className={`${recordingButtonClass} border-yellow-400 bg-yellow-300`} disabled={busy || stale || needsRefresh || needsConfirmation || invalid} onClick={() => void save()}>{busy ? "Ukladám…" : "Schváliť hodnotenie"}</button>
  </div>;
}

function QualityAppealEditor({ detail, evaluation, onUpdated }: Omit<Props, "onSeek">) {
  const [note, setNote] = useState(""); const [busy, setBusy] = useState(false); const [sent, setSent] = useState(false); const [uncertain, setUncertain] = useState(false); const [error, setError] = useState<string | null>(null);
  async function submit() {
    if (!note.trim() || busy || sent || uncertain) return;
    setBusy(true); setError(null);
    try { const updated = await recordingRequest<CallRecordingDetail>(`/api/telephony/calls/${encodeURIComponent(detail.callId)}/quality/appeal`, { method: "POST", body: { reviewId: evaluation.review?.id ?? null, note: note.trim() } }); onUpdated(updated); setSent(true); }
    catch (caught) { setError(recordingErrorMessage(caught)); if (isTelephonyTimeout(caught)) setUncertain(true); }
    finally { setBusy(false); }
  }
  return <div className="space-y-2 rounded-md border border-zinc-200 p-3"><label className="block text-xs font-semibold text-zinc-600">Čo potrebujete preveriť<textarea aria-label="Čo potrebujete preveriť" className={`${recordingInputClass} mt-1 min-h-24`} maxLength={2000} disabled={busy || sent || uncertain} value={note} onChange={(event) => setNote(event.target.value)} /></label>
    {error && <RecordingMessage error>{error}</RecordingMessage>}{uncertain && <RecordingMessage>Potvrdenie neprišlo včas. Pripomienku automaticky neposielame znova; overte jej prijatie s kontrolórom.</RecordingMessage>}{sent && <RecordingMessage>Pripomienka bola uložená na preverenie. Týmto krokom sa skóre nezmenilo.</RecordingMessage>}
    <button type="button" className={recordingButtonClass} disabled={busy || sent || uncertain || !note.trim()} onClick={() => void submit()}>{busy ? "Odosielam…" : "Odoslať pripomienku"}</button>
  </div>;
}
