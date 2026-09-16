"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Map, MapPin, Navigation } from "lucide-react";
import type { DispatchCase } from "@/domain/types";
import type { DispatchData } from "@/data/dispatch-types";
import type { CaseDetailData } from "@/data/case-detail";
import type { SmsHistoryEntry } from "@/lib/sms/contracts";
import { loadGoogleMaps } from "@/lib/google-maps-client";
import { formatDateTime } from "@/lib/dispatch-calculations";
import { locationRequestLabel } from "@/lib/sms/status";
import { SmsComposerDialog, type SmsComposerResult } from "./SmsComposerDialog";
import { useCustomerLocationAction } from "./UseCustomerLocationButton";

type Props = {
  open: boolean;
  onClose: () => void;
  caseItem: DispatchCase;
  disabled?: boolean;
  onApplied: (data: DispatchData) => void;
  onCaseChange?: (data: CaseDetailData) => void;
  onSent?: (result: SmsComposerResult) => void;
  onShowOnMap?: () => void;
};

/** A compact, case-bound view; preparing/sending still uses the SMS durable session. */
export function CaseLocationDialog({ open, onClose, caseItem, disabled, onApplied, onCaseChange, onSent, onShowOnMap }: Props) {
  const location = caseItem.customerSharedLocation;
  const locationKey = location ? JSON.stringify([caseItem.id, location.lat, location.lng, location.submittedAt]) : "";
  const storedAddress = location?.address?.trim();
  // Stored GPS submissions may have a generated coordinate label, not an address.
  const actualAddress = storedAddress && !/^GPS\b/i.test(storedAddress) ? storedAddress : "";
  const [resolvedPlace, setResolvedPlace] = useState<{ key: string; address: string } | null>(null);
  const [notice, setNotice] = useState<{ key: string; message: string } | null>(null);
  const [copiedKey, setCopiedKey] = useState("");
  const [requestState, setRequestState] = useState<{ caseId: string; entry: SmsHistoryEntry | null; checkedAt: number } | null>(null);
  const place = actualAddress || (resolvedPlace?.key === locationKey ? resolvedPlace.address : "");
  const latitude = location?.lat;
  const longitude = location?.lng;

  useEffect(() => {
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY;
    if (!open || actualAddress || latitude == null || longitude == null || !apiKey) return;
    let active = true;
    // Geocoding is read-only and only requested while this location is visible.
    void loadGoogleMaps(apiKey).then(async (maps) => {
      await maps.maps.importLibrary?.("geocoding");
      if (!active) return;
      const response = await new maps.maps.Geocoder().geocode({ location: { lat: latitude, lng: longitude } });
      if (active) setResolvedPlace({ key: locationKey, address: response.results[0]?.formatted_address || "" });
    }).catch(() => { if (active) setResolvedPlace({ key: locationKey, address: "" }); });
    return () => { active = false; };
  }, [open, actualAddress, latitude, longitude, locationKey]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let busy = false;
    async function refresh() {
      if (busy || controller.signal.aborted) return;
      busy = true;
      try {
        const query = new URLSearchParams({ caseId: caseItem.id, offset: "0" });
        const response = await fetch(`/api/sms?${query}`, { cache: "no-store", signal: controller.signal });
        const result = await response.json();
        if (response.ok && Array.isArray(result.messages) && !controller.signal.aborted) {
          setRequestState({ caseId: caseItem.id, entry: result.messages.find((entry: SmsHistoryEntry) => entry.location) ?? null, checkedAt: Date.now() });
        }
      } catch { /* A missing history response must not prevent viewing received GPS. */ }
      finally { busy = false; }
    }
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 10_000);
    window.addEventListener("sms-history-changed", refresh);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener("sms-history-changed", refresh); };
  }, [open, caseItem.id]);

  const latestRequest = requestState?.caseId === caseItem.id ? requestState.entry : null;
  const request = latestRequest?.location;
  const requestStatus = request?.status === "active" && Date.parse(request.expiresAt) <= (requestState?.checkedAt ?? 0) ? "expired" : request?.status;
  const actionClass = "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs font-semibold text-zinc-800 hover:bg-zinc-100";
  const coordinates = location ? `${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}` : "";
  const showNotice = (message: string) => setNotice({ key: caseItem.id, message });
  const adoption = useCustomerLocationAction({ caseId: caseItem.id, location, expectedUpdatedAt: caseItem.updatedAt, currentPickup: caseItem.pickup, currentAddress: caseItem.locationDetails.manualPickupAddress,
    disabled, onApplied, onCaseChange, onNotice: showNotice });
  async function copyCoordinates() {
    try { await navigator.clipboard.writeText(coordinates); setCopiedKey(locationKey); }
    catch { showNotice("Súradnice sa nepodarilo skopírovať. Môžete ich označiť a skopírovať ručne."); }
  }

  return <SmsComposerDialog open={open} onClose={onClose} caseId={caseItem.id} caseNumber={caseItem.caseNumber}
    initialPhone={caseItem.contact.phone} initialTemplate="location_request" locationMode locationReceived={Boolean(location)}
    locationRequestDisabled={disabled} closeDisabled={adoption.saving} onSent={onSent}
    locationPanel={<div className="grid gap-3">
      {location ? <section aria-label="Prijatá poloha klienta" className="rounded-xl border border-sky-100 bg-sky-50/70 p-3.5">
        <div className="flex items-start gap-2.5"><span className="rounded-lg bg-white p-2 text-sky-700"><MapPin size={18} aria-hidden="true" /></span><div className="min-w-0 flex-1"><div className="mb-1 flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">Poloha prijatá</h3><span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700"><Check size={12} aria-hidden="true" />GPS klienta</span></div><p className="break-words text-sm font-medium">{place || "Približná adresa nie je k dispozícii"}</p>{place && <p className="mt-0.5 text-[11px] text-zinc-500">Orientačná adresa podľa súradníc</p>}<p className="mt-1 select-text font-mono text-xs text-zinc-600">{coordinates}</p></div></div>
        <p className="mt-3 text-xs leading-5 text-zinc-600">Prijaté {formatDateTime(location.submittedAt)}{location.accuracyMeters != null ? ` · presnosť približne ${Math.round(location.accuracyMeters)} m` : " · presnosť nezistená"}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {onShowOnMap && <button type="button" disabled={adoption.saving} onClick={() => { onClose(); onShowOnMap(); }} className={actionClass}><Map size={14} aria-hidden="true" />Zobraziť na mape</button>}
          <a href={`https://www.google.com/maps/search/?api=1&query=${location.lat},${location.lng}`} target="_blank" rel="noreferrer" className={actionClass}><Navigation size={14} aria-hidden="true" />Otvoriť GPS</a>
          <button type="button" onClick={() => void copyCoordinates()} className={actionClass}>{copiedKey === locationKey ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}{copiedKey === locationKey ? "Skopírované" : "Kopírovať súradnice"}</button>
          {adoption.control}
        </div>
        {disabled && <p className="mt-2 text-xs text-zinc-600">Miesto incidentu môžete nahradiť po uložení rozpracovaných zmien.</p>}
      </section> : <div className="rounded-xl bg-zinc-50 p-3 text-sm leading-6"><strong>Poloha zatiaľ nie je k dispozícii.</strong><p className="text-xs text-zinc-600">Klient ju odošle cez odkaz v SMS. Po prijatí ju môžete zobraziť na mape alebo vložiť do prípadu.</p></div>}
      {requestStatus && requestStatus !== "used" && <p role="status" className="rounded-lg border border-zinc-200 px-3 py-2 text-xs leading-5"><strong>{requestStatus === "active" && location ? "Čakáme na novú polohu" : locationRequestLabel(requestStatus)}</strong>{requestStatus === "active" && request && <> · odkaz platí do {formatDateTime(request.expiresAt)}</>}{latestRequest?.status === "failed" && <> · SMS sa nepodarilo odoslať</>}</p>}
      {notice?.key === caseItem.id && <p role="status" className="rounded-lg bg-zinc-100 p-3 text-sm">{notice.message}</p>}
    </div>} />;
}
