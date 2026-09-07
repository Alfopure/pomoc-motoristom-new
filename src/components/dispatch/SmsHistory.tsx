"use client";

import { useEffect, useState } from "react";
import type { SmsHistoryEntry } from "@/lib/sms/contracts";
import { locationRequestLabel, smsStatusLabel } from "@/lib/sms/status";

export function SmsHistory({ caseId, active = true }: { caseId?: string; active?: boolean }) {
  const [messages, setMessages] = useState<SmsHistoryEntry[]>([]);
  const [error, setError] = useState("");
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let inFlight = false;
    async function refresh() {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      try {
        const params = new URLSearchParams({ offset: String(offset) });
        if (caseId) params.set("caseId", caseId);
        const response = await fetch(`/api/sms?${params}`, { cache: "no-store", signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Históriu sa nepodarilo načítať.");
        setMessages(result.messages); setHasMore(result.hasMore); setError("");
      } catch (error) { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Históriu sa nepodarilo načítať."); }
      finally { inFlight = false; if (!controller.signal.aborted) setLoading(false); }
    }
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 10_000);
    window.addEventListener("sms-history-changed", refresh);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener("sms-history-changed", refresh); };
  }, [active, caseId, offset]);
  return <div className="grid gap-3">
    <p className="text-xs text-zinc-500">{caseId ? "SMS tohto prípadu" : "Spoločná história vrátane SMS bez prípadu"}. Stavy sa obnovujú každých 10 sekúnd. Doručenie nepotvrdzuje prečítanie.</p>
    {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
    {loading && <p role="status" className="text-sm text-zinc-500">Načítavam históriu…</p>}
    {!loading && !messages.length && !error && <p className="rounded-lg bg-zinc-50 p-4 text-sm">Zatiaľ žiadne SMS.</p>}
    {messages.map((entry) => <article key={entry.id} className="rounded-xl border border-zinc-200 bg-white p-3.5 text-sm">
      <div className="flex flex-wrap justify-between gap-2"><strong>{entry.caseNumber || "Bez prípadu"}</strong><span className={`rounded px-2 py-0.5 text-xs font-semibold ${entry.status === "failed" ? "bg-red-50 text-red-800" : entry.status === "delivered" ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900"}`}>{smsStatusLabel(entry.status, entry.statusDetail)}</span></div>
      <p className="mt-1 font-medium">{entry.recipientName} · {entry.toNumber}</p>
      <p className="mt-1 text-xs text-zinc-500">{entry.author} · {new Date(entry.createdAt).toLocaleString("sk-SK")} · Odosielateľ: {entry.sender}</p>
      <p className="my-3 whitespace-pre-wrap break-words leading-6">{entry.body}</p>
      {entry.error && <p className="text-xs text-red-800">{entry.error}</p>}
      {entry.location && <div className="mt-3 rounded-lg bg-sky-50 p-3 text-xs leading-5 text-sky-950">
        <strong>Žiadosť: {locationRequestLabel(entry.location.status)}</strong>
        <p>Platnosť linku: {new Date(entry.location.expiresAt).toLocaleString("sk-SK")}</p>
        {entry.location.submittedAt && <p>Prijatá: {new Date(entry.location.submittedAt).toLocaleString("sk-SK")} · Presnosť: {entry.location.accuracy == null ? "nezistená" : `${entry.location.accuracy} m`}</p>}
        {entry.location.lat != null && entry.location.lng != null && <a className="font-semibold underline" href={`https://www.google.com/maps?q=${entry.location.lat},${entry.location.lng}`} target="_blank" rel="noreferrer">Zobraziť polohu na mape</a>}
        {entry.location.status === "used" && <p>V detaile prípadu použite „Použiť ako miesto incidentu“. GPS nemení miesto automaticky.</p>}
      </div>}
    </article>)}
    {(offset > 0 || hasMore) && <div className="flex items-center justify-between text-sm"><button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))} className="rounded border px-3 py-2 disabled:opacity-40">Novšie</button><span>{offset + 1} – {offset + messages.length}</span><button type="button" disabled={!hasMore} onClick={() => setOffset(offset + 50)} className="rounded border px-3 py-2 disabled:opacity-40">Staršie</button></div>}
  </div>;
}
