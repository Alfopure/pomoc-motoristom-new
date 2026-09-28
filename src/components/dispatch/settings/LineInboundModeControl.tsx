"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";

import type { LineInboundMode } from "@/server/telephony/state/types";
import type { LineDoc } from "@/server/telephony/config-service";
import { ConfigRequestError, loadRoutingConfig, saveRoutingConfig, type RoutingConfigResponse } from "./config-client";
import { settingsInputClass } from "./settings-ui";

type Mode = LineInboundMode | null;

export function LineInboundModeControl({ line, defaultMode, canEdit, onSaved }: {
  line: LineDoc;
  defaultMode: "ring_first" | "queue_first" | null;
  canEdit: boolean;
  onSaved: (response: RoutingConfigResponse) => void;
}) {
  const [selection, setSelection] = useState<Mode>(line.inboundCallMode ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);

  async function verify(expected: Mode | null = null) {
    const latest = await loadRoutingConfig("numbers");
    const saved = latest.document.lines.find(candidate => candidate.id === line.id);
    if (!saved) throw new Error("Linku sa nepodarilo overiť.");
    const actual = saved.inboundCallMode ?? null;
    setSelection(actual);
    setUncertain(false);
    onSaved(latest);
    if (actual === expected) {
      setError(null);
      setNotice("Režim tejto linky je uložený a overený. Platí pre nové hovory.");
    } else {
      setNotice(null);
      setError("Uložený režim sa líši od zvolenej hodnoty. Zobrazuje sa aktuálny stav.");
    }
  }
  async function save(next: Mode) {
    if (!canEdit || saving || uncertain || next === selection) return;
    setSelection(next);
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await saveRoutingConfig("numbers", { lineId: line.id, patch: { inboundCallMode: next } }, { method: "PATCH" });
      const saved = response.document.lines.find(candidate => candidate.id === line.id);
      if (!saved) throw new Error("Uloženú linku sa nepodarilo overiť.");
      setSelection(saved.inboundCallMode ?? null);
      onSaved(response);
      setNotice("Režim tejto linky je uložený. Platí pre nové hovory.");
    } catch (caught) {
      if (caught instanceof ConfigRequestError && caught.status >= 400 && caught.status < 500 && caught.status !== 409) {
        setSelection(line.inboundCallMode ?? null);
        setError(caught.message);
        return;
      }
      // A lost response can follow a successful write. Read back the line
      // before reverting the selector or inviting another write.
      try {
        await verify(next);
      } catch {
        setUncertain(true);
        setError("Výsledok uloženia sa nepodarilo overiť. Pred ďalšou zmenou over aktuálny stav.");
      }
    } finally {
      setSaving(false);
    }
  }

  const inherited = defaultMode === "queue_first" ? "teraz rovno do čakárne" : defaultMode === "ring_first" ? "teraz podľa plánu zvonenia" : "nastavenie organizácie";
  return (
    <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
      <label className="grid max-w-xl gap-1 text-sm font-semibold text-zinc-950">
        Čo sa stane s hovorom na číslo {line.phoneNumber}
        <select
          className={settingsInputClass}
          disabled={!canEdit || saving || uncertain}
          value={selection ?? ""}
          onChange={event => void save((event.target.value || null) as Mode)}
        >
          <option value="">Podľa predvoľby ({inherited})</option>
          <option value="ring_first">Najprv zvoniť podľa plánu</option>
          <option value="ring_all">Najprv zvoniť všetkým naraz</option>
          <option value="ring_ordered">Najprv zvoniť postupne</option>
          <option value="queue_first">Rovno do čakárne</option>
        </select>
      </label>
      <p className="mt-2 text-xs leading-5 text-zinc-700">
        Platí len pre toto volané číslo, po úvodnej hláške, otváracích hodinách a prípadnom IVR.
        Voľby „všetkým naraz“ a „postupne“ nahradia spôsob zvonenia v krokoch zdieľaného plánu iba pre túto linku.
        V čakárni si operátor hovor vyberie ručne; potrebuje pripojený telefón v aplikácii. Zmena sa uloží hneď po výbere.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {saving && <span role="status" className="inline-flex items-center gap-1 text-xs font-medium text-amber-800"><Loader2 size={14} className="animate-spin" aria-hidden="true" />Ukladám režim čísla…</span>}
        {uncertain && <button type="button" onClick={() => void verify(selection).catch(() => setError("Stav sa stále nepodarilo overiť. Skús to znova."))} className="rounded-md border border-amber-400 bg-white px-2 py-1 text-xs font-semibold">Overiť stav</button>}
        {notice && <span role="status" className="text-xs font-medium text-emerald-800">{notice}</span>}
        {error && <span role="alert" className="text-xs font-medium text-red-700">{error}</span>}
      </div>
    </div>
  );
}
