"use client";

import { useState } from "react";
import type { DispatchCase, FleetAsset, PartnerDirectoryEntry } from "@/domain/types";
import { searchWorkspace } from "./workspace-search";

export function WorkspaceSearchWidget({ cases, contacts, fleet, onOpenCase, onOpenFleet, onDial, places }: {
  cases: DispatchCase[]; contacts: PartnerDirectoryEntry[]; fleet: FleetAsset[];
  onOpenCase: (id: string) => void; onOpenFleet: (id?: string) => void;
  onDial?: (phone: string) => Promise<void>;
  places: React.ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"local" | "places">("local");
  const [notice, setNotice] = useState<string | null>(null);
  const results = searchWorkspace(query, cases, contacts, fleet);
  return <div className="space-y-3 p-3">
    <div className="flex gap-1" aria-label="Režim vyhľadávania">{(["local", "places"] as const).map(item => <button type="button" key={item} aria-pressed={mode === item} onClick={() => setMode(item)} className={`min-h-11 flex-1 rounded-lg px-2 text-sm ${mode === item ? "bg-zinc-900 text-white" : "bg-zinc-100"}`}>{item === "local" ? "Vlastné údaje" : "Miesto"}</button>)}</div>
    <div hidden={mode !== "local"} className="space-y-2">
      <label className="block text-sm">Prípad, meno, telefón alebo EČV<input value={query} onChange={event => setQuery(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-zinc-300 px-3 text-base" placeholder="Hľadať vo vlastných údajoch" /></label>
      {results.map(result => <div key={`${result.kind}:${result.id}`} className="rounded-lg border border-zinc-200 p-2 text-sm">
        <span className="text-xs text-zinc-500">{({ case: "Prípad", contact: "Kontakt", fleet: "Flotila" })[result.kind]}</span><p className="break-words font-medium">{result.label}</p><p className="break-words text-zinc-600">{result.detail}</p>
        {result.kind !== "contact" ? <button type="button" className="min-h-11 text-sm font-semibold" onClick={() => result.kind === "case" ? onOpenCase(result.id) : onOpenFleet(result.id)}>Otvoriť</button> : result.phone && onDial && <button type="button" className="min-h-11 text-sm font-semibold" onClick={() => void onDial(result.phone!).catch(() => setNotice("Hovor sa nepodarilo spustiť."))}>Zavolať</button>}
      </div>)}
      {query && !results.length && <p className="text-sm text-zinc-500">Žiadny výsledok vo vlastných údajoch.</p>}
      <button type="button" className="min-h-11 text-left text-sm underline" onClick={() => onOpenFleet()}>Otvoriť flotilu a overenie vozidla</button>
    </div>
    {mode === "places" && places}
    {notice && <p role="status" className="text-sm">{notice}</p>}
  </div>;
}
