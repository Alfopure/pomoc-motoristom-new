"use client";

import { lazy, Suspense, useState } from "react";
import { isDiagnosticUuid } from "@/lib/diagnostics/types";

const Timeline = lazy(() => import("./DiagnosticTimeline").then(module => ({ default: module.DiagnosticCallTimeline })));
export function CallDiagnosticsCard({ callSessionId }: { callSessionId?: string }) {
  const [open, setOpen] = useState(false);
  if (!isDiagnosticUuid(callSessionId)) return null;
  return <section className="rounded-md border border-zinc-200 bg-white p-3 text-sm">
    <button type="button" className="flex w-full items-center justify-between gap-3 text-left font-semibold text-zinc-900" aria-expanded={open} onClick={() => setOpen(value => !value)}><span>Diagnostika hovoru</span><span className="text-xs font-normal text-zinc-500">{open ? "Zavrieť" : "Zobraziť časovú os"}</span></button>
    {open && <div className="mt-3"><Suspense fallback={<p role="status">Načítavam diagnostiku…</p>}><Timeline key={callSessionId} callSessionId={callSessionId} /></Suspense></div>}
  </section>;
}
