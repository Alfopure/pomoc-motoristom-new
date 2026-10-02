"use client";

import { useState } from "react";
import { Flag, Loader2 } from "lucide-react";
import { useProblemReport } from "@/lib/diagnostics/useProblemReport";

export function ReportProblemButton({ className = "", compact = false }: { className?: string; compact?: boolean }) {
  const result = useProblemReport();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const phase = `${result.id}:${result.sending}:${result.status}`;
  function report() { setDismissed(null); void result.report(); }
  return <div className={`relative ${className}`}>
    <button type="button" disabled={result.busy} onClick={report} title="Nahlásiť problém" aria-label="Nahlásiť problém" className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white px-3 text-xs font-semibold text-zinc-800 hover:bg-zinc-50 disabled:opacity-60">
      {result.busy ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Flag size={15} aria-hidden="true" />}{!compact && (result.sending ? "Odosielam…" : result.status === 'queued' ? "Čaká na prijatie…" : "Nahlásiť problém")}
    </button>
    {result.attempted && dismissed !== phase && <div role="status" className="fixed inset-x-4 bottom-4 z-50 mt-2 sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:w-72 rounded-md border border-zinc-200 bg-white p-3 text-xs text-zinc-800 shadow-lg">
      <p>{result.message}</p>
      {result.id && <p className="mt-1 break-all font-mono text-[10px]">ID: {result.id}</p>}
      <button type="button" className="mt-2 font-semibold underline" onClick={() => setDismissed(phase)}>Zavrieť</button>
    </div>}
  </div>;
}
