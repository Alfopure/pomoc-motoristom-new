"use client";

import { useEffect, useRef, useState } from "react";
import { Play } from "lucide-react";
import type { CallRecordingDetail } from "@/lib/telephony/recording-quality";
import { CONTENT_LABELS } from "./recording-presentation";
import { formatRecordingTime, RecordingMessage, RecordingSection, recordingButtonClass } from "./recording-ui";

export type RecordingSeek = { segmentId: string; offsetSeconds: number; sequence: number; play: boolean };

export function RecordingPlayer({ detail, seek, onSeek }: { detail: CallRecordingDetail; seek: RecordingSeek | null; onSeek: (seconds: number, segmentId: string) => void }) {
  const selected = detail.segments.find((segment) => segment.id === seek?.segmentId && segment.canPlay && (segment.state === "ready" || segment.state === "partial"));
  return <RecordingSection title="Nahrávka a zachytené úseky">
    {selected && seek ? <SegmentAudio key={`${selected.id}:${seek.sequence}`} callId={detail.callId} segmentId={selected.id} seek={seek} /> : <p className="text-sm text-zinc-600">Vyberte dostupný úsek alebo čas pri replike.</p>}
    {detail.segments.length === 0 ? <p className="text-sm text-zinc-500">Zatiaľ nie je dostupný žiadny zvukový úsek.</p> : <div className="flex flex-wrap gap-2">
      {detail.segments.map((segment) => <button type="button" key={segment.id} disabled={!segment.canPlay || !["ready", "partial"].includes(segment.state)} onClick={() => onSeek(segment.startSeconds, segment.id)} aria-pressed={selected?.id === segment.id} className={`${recordingButtonClass} ${selected?.id === segment.id ? "border-yellow-400 bg-yellow-50" : ""}`}>
        <Play size={13} aria-hidden="true" /><span>Úsek {segment.index + 1} · {formatRecordingTime(segment.startSeconds)}–{formatRecordingTime(segment.startSeconds + segment.durationSeconds)}<span className="block text-left text-xs font-normal">{CONTENT_LABELS[segment.state]}</span></span>
      </button>)}
    </div>}
    {detail.gaps.length > 0 && <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950"><p className="font-semibold">Tieto časti hovoru chýbajú</p><ul className="mt-1 space-y-1">{detail.gaps.map((gap, index) => <li key={index}>{formatRecordingTime(gap.startSeconds)}–{formatRecordingTime(gap.endSeconds)} · {gap.reason}</li>)}</ul></div>}
    {detail.segments.some((segment) => segment.error) && <RecordingMessage>Niektoré úseky sa nepodarilo pripraviť. Ich stav nájdete pri jednotlivých častiach nahrávky.</RecordingMessage>}
  </RecordingSection>;
}

function SegmentAudio({ callId, segmentId, seek }: { callId: string; segmentId: string; seek: RecordingSeek }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const audio = audioRef.current;
    return () => { audio?.pause(); audio?.removeAttribute("src"); audio?.load(); };
  }, []);
  return <div className="space-y-2">
    <audio ref={audioRef} controls preload="metadata" className="w-full min-w-0" aria-label="Prehrávač nahrávky hovoru" src={`/api/telephony/calls/${encodeURIComponent(callId)}/recordings/${encodeURIComponent(segmentId)}/audio`} onLoadedMetadata={() => {
      const audio = audioRef.current;
      if (!audio || !Number.isFinite(audio.duration) || seek.offsetSeconds >= audio.duration) { setError("Požadovaný čas nie je v tomto zvukovom úseku dostupný."); return; }
      audio.currentTime = seek.offsetSeconds;
      if (seek.play) void audio.play().catch(() => setError("Prehrávanie spustite tlačidlom v prehrávači."));
    }} onError={() => setError("Zvuk sa nepodarilo načítať. Obnovte detail; prístup alebo dostupnosť záznamu sa mohli zmeniť.")} />
    {error && <RecordingMessage error>{error}</RecordingMessage>}
  </div>;
}
