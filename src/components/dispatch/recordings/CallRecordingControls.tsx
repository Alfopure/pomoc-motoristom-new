"use client";

import { useEffect, useState } from "react";
import { Circle, Square } from "lucide-react";
import type { CallRecordingDetail } from "@/lib/telephony/recording-quality";
import { recordingErrorMessage, recordingRequest } from "./recording-client";
import { LIVE_LABELS } from "./recording-presentation";
import { RecordingMessage, recordingButtonClass } from "./recording-ui";
import { useRecordingResource } from "./use-recording-resource";

/** Drop-in live-call control; mutations never optimistically report a stopped recorder. */
export function CallRecordingControls({ callId }: { callId: string }) {
  const resource = useRecordingResource<CallRecordingDetail>(`/api/telephony/calls/${encodeURIComponent(callId)}/recording-detail`);
  if (resource.error) return <p role="status" className="text-xs text-zinc-600">Stav nahrávania sa nepodarilo overiť. <button type="button" onClick={resource.refresh} className="underline">Obnoviť</button></p>;
  if (!resource.data) return <p role="status" className="text-xs text-zinc-500">Overujem stav nahrávania…</p>;
  return <RecordingControlActions detail={resource.data} onUpdated={resource.replace} />;
}

export function RecordingControlActions({ detail, onUpdated }: { detail: CallRecordingDetail; onUpdated: (detail: CallRecordingDetail) => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [needsRefresh, setNeedsRefresh] = useState(false);
  const retry = detail.liveState === "failed" || detail.liveState === "unknown";
  const canStop = detail.capabilities.canControl && ["notice", "starting", "recording", "failed", "unknown"].includes(detail.liveState);
  useEffect(() => {
    if (busy || !detail.capabilities.canControl && !["notice", "starting", "recording", "stopping", "unknown"].includes(detail.liveState)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void recordingRequest<CallRecordingDetail>(`/api/telephony/calls/${encodeURIComponent(detail.callId)}/recording-detail`, { signal: controller.signal }).then((updated) => {
        if (!controller.signal.aborted) onUpdated(updated);
      }).catch((caught) => {
        if (!controller.signal.aborted) { setError(recordingErrorMessage(caught)); setNeedsRefresh(true); }
      });
    }, 5000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [busy, detail, onUpdated]);
  async function refresh() {
    setBusy(true);
    try { const updated = await recordingRequest<CallRecordingDetail>(`/api/telephony/calls/${encodeURIComponent(detail.callId)}/recording-detail`); onUpdated(updated); setNeedsRefresh(false); setError(null); }
    catch (caught) { setError(recordingErrorMessage(caught)); } finally { setBusy(false); }
  }
  async function stop() {
    if (!canStop || busy || needsRefresh) return;
    setBusy(true); setError(null);
    try {
      await recordingRequest<unknown>(`/api/telephony/calls/${encodeURIComponent(detail.callId)}/recording-control`, { method: "POST", body: { action: retry ? "retry_stop" : "stop" } });
      const updated = await recordingRequest<CallRecordingDetail>(`/api/telephony/calls/${encodeURIComponent(detail.callId)}/recording-detail`); onUpdated(updated);
    } catch (caught) { setError(recordingErrorMessage(caught)); setNeedsRefresh(true); }
    finally { setBusy(false); }
  }
  return <div className="space-y-2" aria-label="Ovládanie nahrávania">
    <div className="flex flex-wrap items-center justify-between gap-2"><p role="status" className="flex items-center gap-2 text-sm font-medium text-zinc-700"><Circle size={11} className={detail.liveState === "recording" ? "fill-red-500 text-red-500" : "text-zinc-400"} aria-hidden="true" />{needsRefresh ? "Stav nahrávania je potrebné overiť" : LIVE_LABELS[detail.liveState]}</p>
      {canStop && <button type="button" className={recordingButtonClass} disabled={busy || needsRefresh} onClick={() => void stop()}><Square size={12} />{busy ? "Overujem zastavenie…" : retry ? "Znova overiť zastavenie" : "Zastaviť nahrávanie"}</button>}
    </div>
    {detail.liveState === "stopping" && <p className="text-xs text-amber-800">Zastavenie ešte nie je potvrdené. Neoznamujte účastníkom, že sa už nenahráva.</p>}
    {detail.suppressed && <p className="text-xs text-zinc-500">Automatické obnovenie nahrávania je pre tento hovor zablokované.</p>}
    {error && <RecordingMessage error>{error}</RecordingMessage>}{needsRefresh && <button type="button" className={recordingButtonClass} disabled={busy} onClick={() => void refresh()}>Overiť aktuálny stav</button>}
  </div>;
}
