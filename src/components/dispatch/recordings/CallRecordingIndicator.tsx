"use client";

import { useEffect, type Ref } from "react";
import type { CallRecordingDetail } from "@/lib/telephony/recording-quality";
import { LIVE_LABELS } from "./recording-presentation";
import { useRecordingResource } from "./use-recording-resource";

/** Keep checking every live call: an idle recorder can start after connection or unhold. */
export function CallRecordingIndicator({ callId, onClick, expanded, controls, buttonRef }: {
  callId: string;
  onClick?: () => void;
  expanded?: boolean;
  controls?: string;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const { data, error, loading, refresh } = useRecordingResource<CallRecordingDetail>(
    `/api/telephony/calls/${encodeURIComponent(callId)}/recording-detail`,
  );

  useEffect(() => {
    if (loading) return;
    const timer = setTimeout(refresh, 5000);
    return () => clearTimeout(timer);
  }, [callId, loading, refresh]);

  const state = error ? "unknown" : data?.liveState ?? "unknown";
  const label = !data && !error ? "Overujem stav nahrávania…" : LIVE_LABELS[state];
  const dotClass = state === "recording"
    ? "bg-red-500 motion-safe:animate-pulse"
    : state === "off" || state === "stopped"
      ? "bg-zinc-400"
      : "bg-amber-400";

  const content = (
    <>
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${dotClass}`} />
      <span aria-hidden="true" className="text-[10px] font-semibold leading-none tracking-wide">REC</span>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">{label}</span>
    </>
  );

  return onClick ? (
    <button ref={buttonRef} type="button" onClick={onClick} aria-expanded={expanded} aria-controls={controls} title={label} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded px-1 align-middle hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current">
      {content}
    </button>
  ) : (
    <span title={label} className="inline-flex shrink-0 items-center gap-1.5 align-middle">{content}</span>
  );
}
