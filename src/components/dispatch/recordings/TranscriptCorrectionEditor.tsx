"use client";

import { useState } from "react";
import type { CallRecordingDetail, RecordingTranscriptSpan } from "@/lib/telephony/recording-quality";
import { isTelephonyTimeout } from "@/lib/telephony/client-request";
import { RecordingRequestError, recordingErrorMessage, recordingRequest } from "./recording-client";
import { formatRecordingTime, RecordingMessage, recordingButtonClass, recordingInputClass } from "./recording-ui";

export function TranscriptCorrectionEditor({ detail, transcriptId, onUpdated }: { detail: CallRecordingDetail; transcriptId: string; onUpdated: (detail: CallRecordingDetail) => void }) {
  const [spans, setSpans] = useState(() => detail.transcript.spans.filter((span) => span.transcriptId === transcriptId));
  const [revision, setRevision] = useState(detail.sourceRevision);
  const [revalidated, setRevalidated] = useState(false);
  const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false); const [conflict, setConflict] = useState(false); const [needsConfirmation, setNeedsConfirmation] = useState(false); const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  const stale = revision !== detail.sourceRevision;
  const original = detail.transcript.spans.filter((span) => span.transcriptId === transcriptId);
  const dirty = spans.some((span) => original.find((item) => item.id === span.id)?.text !== span.text);
  async function refresh() {
    setBusy(true); setError(null);
    try {
      const fresh = await recordingRequest<CallRecordingDetail>(`/api/telephony/calls/${encodeURIComponent(detail.callId)}/recording-detail`);
      onUpdated(fresh);
      if (!fresh.capabilities.canCorrect || fresh.access !== "full" || ["restricted", "deleted", "disabled"].includes(fresh.state)) throw new Error("Prepis už nemožno upraviť.");
      const current = fresh.transcript.spans.filter((span) => span.transcriptId === transcriptId);
      if (!current.length) throw new Error("Tento prepis už nie je aktuálny. Otvorte opravu aktuálneho prepisu.");
      setSpans((previous) => current.map((span) => ({ ...span, text: previous.find((item) => item.id === span.id)?.text ?? span.text })));
      setRevision(fresh.sourceRevision); setConflict(false); setNeedsConfirmation(true); setRevalidated(true);
    } catch (caught) { setError(recordingErrorMessage(caught)); } finally { setBusy(false); }
  }
  async function save() {
    if (busy || stale || conflict || needsConfirmation || !reason.trim() || !dirty || spans.some((span) => !span.text.trim())) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const updated = await recordingRequest<CallRecordingDetail>(`/api/telephony/calls/${encodeURIComponent(detail.callId)}/transcript`, { method: "PATCH", body: { transcriptId, sourceRevision: revision, text: spans.map((span) => span.text).join("\n"), segments: spans, reason: reason.trim() } });
      onUpdated(updated); setRevision(updated.sourceRevision); setSpans(updated.transcript.spans.filter((span) => span.transcriptId === transcriptId)); setNotice("Oprava je uložená. Hodnotenia závislé od zmenených podkladov vyžadujú novú kontrolu.");
    } catch (caught) { setError(recordingErrorMessage(caught)); if ((caught instanceof RecordingRequestError && caught.status === 409) || isTelephonyTimeout(caught)) setConflict(true); }
    finally { setBusy(false); }
  }
  function updateSpan(id: string, text: string) { setSpans((current: RecordingTranscriptSpan[]) => current.map((span) => span.id === id ? { ...span, text } : span)); setNotice(null); }
  return <div className="space-y-3 rounded-md border border-yellow-300 bg-yellow-50/40 p-3" aria-label="Oprava prepisu">
    <p className="text-sm font-semibold">Oprava textu prepisu</p><p className="text-xs text-zinc-600">Upravuje sa iba vyslovený text. Časy a identita hovorcov zostávajú naviazané na pôvodný záznam.</p>
    {spans.map((span) => <label key={span.id} className="block text-xs font-semibold text-zinc-600">{formatRecordingTime(span.startSeconds)} · {span.speakerLabel}<textarea aria-label={`Replika ${formatRecordingTime(span.startSeconds)} · ${span.speakerLabel}`} className={`${recordingInputClass} mt-1 min-h-20`} maxLength={12000} value={span.text} disabled={busy} onChange={(event) => updateSpan(span.id, event.target.value)} /></label>)}
    <label className="block text-xs font-semibold text-zinc-600">Dôvod opravy<textarea aria-label="Dôvod opravy" className={`${recordingInputClass} mt-1 min-h-20`} maxLength={2000} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} /></label>
    {error && <RecordingMessage error>{error}</RecordingMessage>}{notice && <RecordingMessage>{notice}</RecordingMessage>}
    {(stale || conflict) && <><RecordingMessage>Úpravy sú zachované. Pred uložením ich porovnajte s aktuálnym prepisom.</RecordingMessage><button type="button" className={recordingButtonClass} disabled={busy} onClick={() => void refresh()}>Načítať aktuálny prepis</button></>}
    {revalidated && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={!needsConfirmation} onChange={(event) => setNeedsConfirmation(!event.target.checked)} className="mt-1" />Porovnal som opravu s aktuálnym prepisom.</label>}
    <button type="button" className={recordingButtonClass} disabled={busy || stale || conflict || needsConfirmation || !reason.trim() || !dirty || !spans.length || spans.some((span) => !span.text.trim())} onClick={() => void save()}>{busy ? "Ukladám…" : "Uložiť opravu prepisu"}</button>
  </div>;
}
