"use client";
import { useEffect, useState } from "react";
import type { DirectoryEntry } from "@/lib/directory";
import type { CallbackPolicy } from "@/server/callback-targets";

export function CallbackPolicyPanel({ entry, entries, canEdit }: { entry: DirectoryEntry; entries: DirectoryEntry[]; canEdit: boolean }) {
  const [policy, setPolicy] = useState<CallbackPolicy | null>(null);
  const [nonCallback, setNonCallback] = useState(false);
  const [targetId, setTargetId] = useState("");
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const endpoint = `/api/directory/contacts/${encodeURIComponent(entry.id)}/callback-policy`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(endpoint, { cache: "no-store", signal: controller.signal }).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Nastavenie spätného volania sa nepodarilo načítať.");
      if (controller.signal.aborted) return;
      setPolicy(body.policy); setNonCallback(body.policy.nonCallback); setTargetId(body.policy.targetContactId ?? "");
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [endpoint]);
  async function save() {
    if (!policy || busy) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      const response = await fetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonCallback, targetContactId: nonCallback && targetId ? targetId : null, verified, expectedRevision: policy.revision }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Nastavenie sa nepodarilo uložiť.");
      setPolicy(body.policy); setSaved(true); setVerified(false);
    } catch (error) { setError(error instanceof Error ? error.message : "Nastavenie sa nepodarilo uložiť."); }
    finally { setBusy(false); }
  }
  const target = entries.find(item => item.kind === "contact" && item.id === targetId);
  const input = "min-h-11 w-full rounded-lg border border-zinc-200 bg-white px-3 text-base";
  return <section className="space-y-3 rounded-xl border border-zinc-200 p-4" aria-label="Cieľ spätného volania">
    <h3 className="text-sm font-semibold">Spätné volanie</h3>
    <p className="text-xs leading-relaxed text-zinc-500">Pôvodné číslo zostáva v histórii. Alternatívny cieľ vyberte iba po overení, že prijíma volania za tento kontakt.</p>
    {policy && <fieldset disabled={!canEdit || busy} className="space-y-3">
      <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={nonCallback} onChange={event => { setNonCallback(event.target.checked); setVerified(false); setSaved(false); }} className="h-5 w-5 accent-zinc-900" />Toto číslo neprijíma spätné volania</label>
      {nonCallback && <>
        <label className="block space-y-1 text-sm"><span>Overený kontakt pre spätné volanie</span><select value={targetId} onChange={event => { setTargetId(event.target.value); setVerified(false); setSaved(false); }} className={input}><option value="">Bez overeného cieľa — volanie zablokovať</option>{entries.filter(item => item.kind === "contact" && item.id !== entry.id && item.active && item.phone).map(item => <option key={item.id} value={item.id}>{item.name} · {item.phone}</option>)}</select></label>
        {targetId && canEdit && <label className="flex min-h-11 items-start gap-3 text-sm"><input type="checkbox" checked={verified} onChange={event => setVerified(event.target.checked)} className="mt-1 h-5 w-5 shrink-0 accent-zinc-900" /><span>Overil/a som, že {target?.name ?? "vybraný kontakt"} ({target?.phone ?? "číslo nie je dostupné"}) prijíma spätné volania za {entry.name} ({entry.phone}).</span></label>}
      </>}
      {canEdit && <button type="button" disabled={busy || nonCallback && Boolean(targetId) && !verified} onClick={() => void save()} className="min-h-11 rounded-lg bg-zinc-900 px-4 text-sm font-semibold text-white disabled:opacity-40">{busy ? "Ukladám…" : "Uložiť cieľ spätného volania"}</button>}
    </fieldset>}
    {policy?.verifiedAt && <p className="text-xs text-zinc-500">Posledné overenie: {new Date(policy.verifiedAt).toLocaleString("sk-SK", { timeZone: "Europe/Bratislava" })}. Zmena telefónneho čísla vyžaduje nové overenie.</p>}
    {saved && <p role="status" className="text-sm text-emerald-700">Nastavenie spätného volania je uložené.</p>}
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
  </section>;
}
