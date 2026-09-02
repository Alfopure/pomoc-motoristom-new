"use client";

import { useEffect, useRef, useState } from "react";
import { FileText, Loader2, PhoneForwarded, Sparkles, X } from "lucide-react";
import type { CallCenterCall } from "@/data/dispatch-types";
import { telephonyFetch, TELEPHONY_TIMEOUT_MS } from "@/lib/telephony/client-request";

type TranscriptSegment = {
  speaker: string;
  start: number;
  end: number;
  text: string;
};

type TranscriptDetail = {
  found: boolean;
  recordingId?: string | null;
  text?: string | null;
  segments?: TranscriptSegment[];
  summary?: string | null;
  extractedFields?: Record<string, string | null>;
  qaScore?: number | null;
  qaBreakdown?: Record<string, number> | null;
  qaNotes?: Array<{ time_ref: string; note: string }>;
  qaGated?: boolean;
};

const extractedFieldLabels: Record<string, string> = {
  spz: "ŠPZ",
  lokalita: "Lokalita",
  typ_poruchy: "Porucha",
  dohodnuty_krok: "Dohodnutý krok",
  telefon: "Telefón",
};

const qaBreakdownLabels: Record<string, string> = {
  pozdrav: "Pozdrav",
  zistenie_udajov: "Zistenie údajov",
  riesenie: "Riešenie",
  dohodnuty_krok: "Dohodnutý krok",
  ton: "Tón",
  efektivita_casu: "Efektivita času",
};

export function CallDetailDrawer({
  call,
  open,
  onClose,
  onNewCase,
}: {
  call: CallCenterCall | null;
  open: boolean;
  onClose: () => void;
  onNewCase: (call: CallCenterCall) => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    closeButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  const phone = call ? (call.direction === "outbound" ? call.calledNumber : call.callerNumber) : "";

  return (
    <div
      aria-hidden={!open}
      aria-labelledby="call-detail-title"
      aria-modal="true"
      inert={open ? undefined : true}
      role="dialog"
      className={`fixed inset-y-0 right-0 z-[2147483200] flex w-full max-w-2xl flex-col border-l border-zinc-200 bg-white shadow-2xl transition-transform duration-200 ${
        open ? "translate-x-0" : "pointer-events-none translate-x-full"
      }`}
    >
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-200 px-4">
        <span id="call-detail-title" className="text-sm font-semibold uppercase tracking-normal text-zinc-600">
          Detail hovoru {phone}
        </span>
        <div className="flex items-center gap-2">
          {call ? (
            <button
              type="button"
              onClick={() => onNewCase(call)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-yellow-300 px-2 text-xs font-semibold text-zinc-950 hover:bg-yellow-200"
            >
              <PhoneForwarded size={13} />
              Nový prípad z hovoru
            </button>
          ) : null}
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-200 p-2 text-zinc-600 hover:bg-zinc-50"
            aria-label="Zavrieť detail hovoru"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {open && call ? <CallDetailContent key={call.id} call={call} /> : null}
    </div>
  );
}

function CallDetailContent({ call }: { call: CallCenterCall }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [detail, setDetail] = useState<TranscriptDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      try {
        // Recording playback returns with the next telephony provider; only
        // the stored transcript is readable until then.
        const transcriptResponse = await telephonyFetch(`/api/telephony/calls/${call.id}/transcript`, {
          label: "prepis hovoru",
          signal: controller.signal,
          timeoutMs: TELEPHONY_TIMEOUT_MS.read,
        });

        setDetail(transcriptResponse.ok ? ((await transcriptResponse.json()) as TranscriptDetail) : { found: false });
      } catch {
        if (!controller.signal.aborted) {
          setDetail({ found: false });
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    })();

    return () => controller.abort();
  }, [call]);

  const seekTo = (seconds: number) => {
    const audio = audioRef.current;

    if (audio) {
      audio.currentTime = Math.max(0, seconds);
      void audio.play().catch(() => undefined);
    }
  };

  const extractedEntries = Object.entries(detail?.extractedFields ?? {}).filter(([, value]) => value);

  return (
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <section className="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm">
          <div className="font-semibold text-zinc-950">{call.lineLabel}</div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600">
            <span>Volajúci: {call.callerNumber}</span>
            {call.receivedNumber && <span>Volané číslo: {call.receivedNumber}</span>}
            {call.destinationExtension && <span>Finálna klapka: {call.destinationExtension}</span>}
            {!call.destinationExtension && call.destinationNumber && <span>Finálny cieľ: {call.destinationNumber}</span>}
            {call.queueLabel && <span>Rad: {call.queueLabel}</span>}
          </div>
        </section>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-zinc-500">
            <Loader2 size={15} className="animate-spin" /> Načítavam prepis…
          </div>
        ) : null}

        {!loading && detail?.summary ? (
          <section className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase text-zinc-500">
              <Sparkles size={13} /> AI súhrn
            </div>
            <p className="text-sm text-zinc-800">{detail.summary}</p>
            {extractedEntries.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {extractedEntries.map(([key, value]) => (
                  <span key={key} className="inline-flex items-center rounded-md bg-white px-2 py-1 text-xs font-medium text-zinc-700 ring-1 ring-zinc-200">
                    {extractedFieldLabels[key] ?? key}: {value}
                  </span>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {!loading && typeof detail?.qaScore === "number" ? (
          <section className="rounded-md border border-zinc-200 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase text-zinc-500">Hodnotenie hovoru</span>
              <span className={`rounded-md px-2 py-0.5 text-sm font-bold ${scoreTone(detail.qaScore)}`}>{detail.qaScore}/100</span>
            </div>
            {detail.qaBreakdown ? (
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                {Object.entries(detail.qaBreakdown).map(([key, value]) => (
                  <div key={key} className="flex items-center justify-between gap-2">
                    <span className="text-zinc-600">{qaBreakdownLabels[key] ?? key}</span>
                    <span className="font-semibold text-zinc-900">{Math.round(value)}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {(detail.qaNotes ?? []).length > 0 ? (
              <ul className="mt-2 space-y-1 border-t border-zinc-100 pt-2 text-xs text-zinc-600">
                {detail.qaNotes!.map((note, index) => (
                  <li key={index}>
                    <span className="font-semibold text-zinc-800">{note.time_ref}</span> — {note.note}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}

        {!loading && detail?.qaGated ? (
          <p className="text-xs text-zinc-500">QA hodnotenie nebolo vypočítané — priradenie hovorcov v tomto zázname nie je spoľahlivé.</p>
        ) : null}

        {!loading && (detail?.segments ?? []).length > 0 ? (
          <section>
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase text-zinc-500">
              <FileText size={13} /> Prepis (klik na repliku posunie nahrávku)
            </div>
            <div className="space-y-2">
              {detail!.segments!.map((segment, index) => {
                const isDispatcher = segment.speaker === "dispecer";

                return (
                  <button
                    key={index}
                    type="button"
                    onClick={() => seekTo(segment.start)}
                    className={`block max-w-[85%] rounded-lg px-3 py-2 text-left text-sm ${
                      isDispatcher ? "ml-auto bg-yellow-100 text-zinc-900" : "mr-auto bg-zinc-100 text-zinc-800"
                    }`}
                  >
                    <span className="mb-0.5 block text-[10px] font-semibold uppercase text-zinc-500">
                      {speakerLabel(segment.speaker)} · {formatSeconds(segment.start)}
                    </span>
                    {segment.text}
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}

        {!loading && detail && !detail.found ? (
          <p className="text-sm text-zinc-500">Prepis hovoru zatiaľ nie je k dispozícii. Spracuje sa automaticky po stiahnutí nahrávky.</p>
        ) : null}
      </div>
  );
}

function speakerLabel(speaker: string) {
  if (speaker === "dispecer") {
    return "Dispečer";
  }

  if (speaker === "volajuci") {
    return "Volajúci";
  }

  return speaker;
}

function formatSeconds(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function scoreTone(score: number) {
  if (score >= 80) {
    return "bg-green-100 text-green-800";
  }

  if (score >= 60) {
    return "bg-yellow-100 text-yellow-800";
  }

  return "bg-red-100 text-red-700";
}
