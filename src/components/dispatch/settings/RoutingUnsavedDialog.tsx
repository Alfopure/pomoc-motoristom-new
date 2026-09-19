"use client";
import { useEffect, useRef, useState } from "react";
/** Native modal provides focus trapping, Escape and focus restoration. */
export function RoutingUnsavedDialog({ onSave, onDiscard, onCancel }: { onSave: () => Promise<void>; onDiscard: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog ref={ref} onCancel={event => { event.preventDefault(); if (!saving) onCancel(); }} aria-label="Neuložené nastavenia" className="fixed inset-0 m-auto w-[calc(100%-32px)] max-w-md rounded-2xl border border-zinc-200 bg-white p-5 text-zinc-900 shadow-xl backdrop:bg-black/30"><h2 className="font-semibold">Máš neuložené zmeny skupín a plánov</h2><p className="mt-2 text-sm text-zinc-600">Pred odchodom ich ulož alebo zahoď. Pri neúspešnom uložení zostaneš v návrhu.</p><div className="mt-4 flex flex-wrap gap-2"><button type="button" disabled={saving} onClick={() => { setSaving(true); void onSave().finally(() => setSaving(false)); }} className="min-h-10 rounded-lg bg-[#FCD703] px-3 text-sm font-semibold disabled:opacity-50">{saving ? "Ukladám…" : "Uložiť a pokračovať"}</button><button type="button" disabled={saving} onClick={onDiscard} className="min-h-10 rounded-lg border border-zinc-200 px-3 text-sm font-medium disabled:opacity-50">Zahodiť a pokračovať</button><button type="button" disabled={saving} autoFocus onClick={onCancel} className="min-h-10 rounded-lg border border-zinc-200 px-3 text-sm font-medium disabled:opacity-50">Zostať</button></div></dialog>;
}
