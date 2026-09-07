"use client";
import { useRef, useState } from "react";
import type { CustomerSharedLocation } from "@/domain/types";
import type { DispatchData } from "@/data/dispatch-types";

export function UseCustomerLocationButton({ caseId, location, disabled, onApplied, onNotice }: {
  caseId: string;
  location: CustomerSharedLocation;
  disabled?: boolean;
  onApplied: (data: DispatchData) => void;
  onNotice: (message: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  async function apply() {
    if (disabled || busy.current) return;
    busy.current = true; setSaving(true);
    try {
      const response = await fetch(`/api/cases/${encodeURIComponent(caseId)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({ pickup: { label: "Miesto incidentu (GPS klienta)", address: location.address || `GPS ${location.lat}, ${location.lng}`, lat: location.lat, lng: location.lng, provider: "manual" } }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Miesto incidentu sa nepodarilo zmeniť.");
      let data = result.dispatchData;
      if (!data && result.refreshRequired) {
        const refresh = await fetch(`/api/cases/${encodeURIComponent(caseId)}`, { cache: "no-store" });
        const refreshed = await refresh.json();
        if (refresh.ok) data = refreshed.dispatchData;
      }
      if (data) { onApplied(data); onNotice("GPS klienta bola výslovne použitá ako miesto incidentu."); }
      else onNotice("Miesto incidentu je uložené. Obnovte prípad, aby sa načítala aktuálna trasa.");
    } catch (error) { onNotice(error instanceof Error ? error.message : "Výsledok zmeny overte obnovením prípadu."); }
    finally { busy.current = false; setSaving(false); }
  }
  return <button type="button" onClick={() => void apply()} disabled={disabled || saving} title={disabled ? "Najprv uložte rozpracované zmeny prípadu." : "Zmení miesto incidentu na zobrazenú GPS polohu klienta."}
    className="inline-flex min-h-9 items-center justify-center rounded-md border border-sky-700 bg-white px-3 py-2 text-xs font-semibold text-sky-900 hover:bg-sky-100 disabled:opacity-40">{saving ? "Ukladám miesto…" : "Použiť ako miesto incidentu"}</button>;
}
