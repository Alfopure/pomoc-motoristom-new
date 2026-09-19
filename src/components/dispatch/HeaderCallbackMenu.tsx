"use client";

import { useRef } from "react";
import { ChevronDown, PhoneOutgoing } from "lucide-react";
import { useCallbackQueue } from "@/lib/telephony/callback-queue-store";
import { CallbackQueuePanel } from "./CallbackQueuePanel";

export function HeaderCallbackMenu({ scopeKey, organizationId, configured, onOpenQueue, onCallBack, onChanged }: {
  scopeKey: string;
  organizationId?: string;
  configured: boolean;
  onOpenQueue: () => void;
  onCallBack?: (requestId: string, verificationId?: string) => Promise<void>;
  onChanged?: () => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const { queue, loaded, error } = useCallbackQueue(scopeKey, organizationId);
  const count = queue.openTotal ?? queue.open.length;
  return <details ref={menu} className="group relative" onKeyDown={(event) => {
    if (event.key === "Escape" && menu.current) { menu.current.open = false; menu.current.querySelector("summary")?.focus(); }
  }}>
    <summary className={`flex h-9 cursor-pointer list-none items-center gap-1.5 rounded-md border px-2 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 [&::-webkit-details-marker]:hidden ${count > 0 ? "border-amber-300 bg-amber-50 text-amber-950" : "border-zinc-200 bg-zinc-50 text-zinc-700"}`} aria-label={`Spätné volania: ${loaded && !error ? count : "stav sa overuje"}`}>
      <PhoneOutgoing size={15} aria-hidden="true" /><span className="hidden xl:inline">Spätné volania</span>
      <span className="rounded-md bg-black/5 px-1.5 py-0.5 font-bold tabular-nums" aria-live="polite">{loaded && !error ? count : "…"}</span>
      <ChevronDown size={13} className="group-open:rotate-180" aria-hidden="true" />
    </summary>
    <div className="fixed left-2 right-2 top-14 z-[85] max-h-[min(75vh,42rem)] overflow-y-auto overscroll-contain rounded-xl border border-zinc-200 bg-white text-zinc-950 shadow-xl sm:absolute sm:left-auto sm:right-0 sm:top-[calc(100%+8px)] sm:w-[min(25rem,calc(100vw-1rem))]">
      <button type="button" className="min-h-10 w-full px-3 text-left text-xs font-semibold hover:bg-zinc-50" onClick={() => { if (menu.current) menu.current.open = false; onOpenQueue(); }}>Otvoriť ústredňu a všetky spätné volania</button>
      <CallbackQueuePanel configured={configured} scopeKey={scopeKey} organizationId={organizationId} onCallBack={onCallBack} onChanged={onChanged} />
    </div>
  </details>;
}
