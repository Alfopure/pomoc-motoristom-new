"use client";

import { useRef, useState } from "react";
import { Flag, Loader2 } from "lucide-react";
import { reportDiagnosticProblem } from "@/lib/diagnostics/client";

export function ReportProblemButton({ className = "", compact = false }: { className?: string; compact?: boolean }) {
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ id: string; confirmed: boolean } | null>(null);
  const pending = useRef(false);
  async function report() {
    if (pending.current) return;
    pending.current = true; setSending(true); setResult(null);
    try { setResult(await reportDiagnosticProblem()); }
    catch { setResult({ id: "", confirmed: false }); }
    finally { pending.current = false; setSending(false); }
  }
  return <div className={`relative ${className}`}>
    <button type="button" disabled={sending} onClick={() => void report()} title="Nahlásiť problém" aria-label="Nahlásiť problém" className="inline-flex min-h-9 items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white px-3 text-xs font-semibold text-zinc-800 hover:bg-zinc-50 disabled:opacity-60">
      {sending ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Flag size={15} aria-hidden="true" />}{!compact && (sending ? "Odosielam…" : "Nahlásiť problém")}
    </button>
    {result && <div role="status" className="fixed inset-x-4 bottom-4 z-50 mt-2 sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:w-72 rounded-md border border-zinc-200 bg-white p-3 text-xs text-zinc-800 shadow-lg">
      <p>{result.confirmed ? "Hlásenie bolo prijaté." : result.id ? "Prijatie zatiaľ nie je potvrdené. Hlásenie sa pokúsi odoslať po obnovení spojenia." : "Hlásenie sa nepodarilo odoslať. Skontrolujte prihlásenie a skúste znova."}</p>
      {result.confirmed && <p className="mt-1 break-all font-mono text-[10px]">ID: {result.id}</p>}
      <button type="button" className="mt-2 font-semibold underline" onClick={() => setResult(null)}>Zavrieť</button>
    </div>}
  </div>;
}
