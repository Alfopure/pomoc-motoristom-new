"use client";
import { useEffect, useId, useState } from "react";
import { ChevronDown, Settings2 } from "lucide-react";
import type { RoutingNavigationTarget, RoutingSummary } from "@/lib/telephony/routing-summary";
import { telephonyJson, TELEPHONY_TIMEOUT_MS } from "@/lib/telephony/client-request";

export function RoutingSummaryPanel({ onNavigate }: { onNavigate?: (target: RoutingNavigationTarget) => void }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const [data, setData] = useState<RoutingSummary | null>(null);
  const [lineId, setLineId] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    let nextRefresh = 25_000;
    let authorizedUntil = 0;
    let timer: ReturnType<typeof setTimeout>;
    let lease: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function refresh() {
      if (pending || disposed || document.visibilityState === "hidden") return;
      pending = true;
      const requestStartedAt = Date.now();
      try {
        const result = await telephonyJson<RoutingSummary & { error?: string; code?: string }>("/api/telephony/routing-summary", { label: "pravidlá nových hovorov", timeoutMs: TELEPHONY_TIMEOUT_MS.read, signal: controller.signal });
        if (disposed) return;
        if (!result.ok || !result.body?.lines) {
          if (result.status === 401 || result.status === 403 || result.body?.code === "config_snapshot_missing") setData(null);
          setError(result.body?.code === "config_snapshot_missing" ? "Súhrn pravidiel sa sprístupní po aktivácii spoločných nastavení." : "Pravidlá sa nepodarilo overiť. Aktualizácia sa zopakuje automaticky.");
        } else {
          const validUntil = Date.parse(result.body.validUntil);
          authorizedUntil = Math.min(requestStartedAt + 30_000, validUntil);
          const remaining = authorizedUntil - Date.now();
          clearTimeout(lease);
          if (!Number.isFinite(remaining) || remaining <= 0) {
            setData(null); setError("Pravidlá čakajú na nové overenie spojenia.");
            nextRefresh = 1000;
          } else {
            setData(result.body); setError(null);
            nextRefresh = Math.max(100, Math.min(25_000, remaining));
            lease = setTimeout(() => { setData(null); setError("Pravidlá čakajú na nové overenie spojenia."); }, remaining);
          }
        }
      } catch { if (!disposed) setError("Pravidlá sa nepodarilo overiť. Aktualizácia sa zopakuje automaticky."); }
      finally { pending = false; if (!disposed) { clearTimeout(timer); timer = setTimeout(() => void refresh(), nextRefresh); } }
    }
    function resume() { if (document.visibilityState === "visible") { if (Date.now() >= authorizedUntil) setData(null); void refresh(); } }
    void refresh();
    window.addEventListener("focus", resume); window.addEventListener("online", resume); window.addEventListener("telephony-config-saved", resume); document.addEventListener("visibilitychange", resume);
    return () => { disposed = true; controller.abort(); clearTimeout(timer); clearTimeout(lease); window.removeEventListener("focus", resume); window.removeEventListener("online", resume); window.removeEventListener("telephony-config-saved", resume); document.removeEventListener("visibilitychange", resume); };
  }, []);
  const line = data?.lines.find(row => row.id === lineId) ?? data?.lines[0];
  if (!line) return <div className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-xs text-zinc-500">{error ?? (data ? "Pravidlá pre nové hovory: nie je nastavená žiadna linka." : "Načítavam pravidlá pre nové hovory…")}</div>;
  return <section aria-label="Pravidlá pre nové hovory" className="min-w-0 rounded-xl border border-zinc-200 bg-white px-3 py-2 shadow-[0_1px_3px_rgba(20,30,50,0.03)]">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2"><h2 className="text-sm font-semibold text-zinc-800">Pravidlá pre nové hovory</h2><label className="min-w-0"><span className="sr-only">Vybraná linka pre pravidlá</span><select value={line.id} onChange={event => setLineId(event.target.value)} className="max-w-full rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs">{data!.lines.map(row => <option key={row.id} value={row.id}>{row.label} · {row.phoneNumber}{row.environment === "development" ? " (test)" : ""}</option>)}</select></label><span className={`rounded-full px-2 py-1 text-[11px] font-medium ${line.status === "open" ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900"}`}>{({ open: "Otvorené", closed: "Mimo hodín", inactive: "Neaktívna", unavailable: "Treba skontrolovať" })[line.status]}</span><button type="button" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(value => !value)} className="ml-auto inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-xs font-medium text-zinc-600 hover:bg-zinc-100"><ChevronDown size={13} className={expanded ? "rotate-180" : ""} />Podrobnosti{line.branches.length > 0 ? ` (${line.branches.length})` : ""}</button>{onNavigate && <button type="button" onClick={() => onNavigate(line.target)} className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-xs font-semibold text-zinc-700 hover:bg-zinc-100"><Settings2 size={14} />{data!.canEdit ? "Upraviť smerovanie" : "Zobraziť nastavenie"}</button>}</div>
    {line.effectiveLineLabel && <p className="mt-1 text-xs text-zinc-500">Návratové číslo → pravidlá linky {line.effectiveLineLabel}</p>}
    <p className={`${expanded ? "" : "sm:line-clamp-1"} text-[13px] leading-5 text-zinc-700`}>{line.sentence}</p>
    <div id={detailsId} hidden={!expanded} className="mt-2 text-xs text-zinc-600"><div className="grid gap-2 pb-2 pt-1">{line.branches.map(branch => <div key={branch.label} className="rounded-lg border border-zinc-200 bg-zinc-50 p-2"><strong>{branch.label}:</strong> {branch.sentence}{onNavigate && <button type="button" className="ml-2 min-h-8 rounded px-2 font-semibold underline underline-offset-2" onClick={() => onNavigate(branch.target)}>Nastavenie voľby</button>}</div>)}{line.notes.map(note => <p key={note}>{note}</p>)}<p>{line.timezone ? `Časová zóna: ${line.timezone}. ` : ""}Overené {new Date(data!.checkedAt).toLocaleTimeString("sk-SK", { hour: "2-digit", minute: "2-digit", timeZone: line.timezone ?? "Europe/Bratislava" })}.</p></div></div>
    {error && <p role="status" className="mt-1 text-xs text-amber-800">{error}</p>}
  </section>;
}
