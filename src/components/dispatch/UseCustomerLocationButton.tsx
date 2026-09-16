"use client";

import { useEffect, useRef, useState } from "react";
import type { CustomerSharedLocation, DispatchLocation } from "@/domain/types";
import type { DispatchData } from "@/data/dispatch-types";
import type { CaseDetailData } from "@/data/case-detail";

type CustomerLocationActionProps = {
  caseId: string;
  location?: CustomerSharedLocation;
  expectedUpdatedAt: string;
  currentPickup?: DispatchLocation;
  currentAddress?: string;
  disabled?: boolean;
  onApplied: (data: DispatchData) => void;
  onCaseChange?: (data: CaseDetailData) => void;
  onNotice: (message: string) => void;
};

export function UseCustomerLocationButton(props: CustomerLocationActionProps) {
  return useCustomerLocationAction(props).control;
}

/** The dialog keeps this session mounted even when its portal is closed. */
export function useCustomerLocationAction({ caseId, location: sharedLocation, expectedUpdatedAt, currentPickup, currentAddress, disabled, onApplied, onCaseChange, onNotice }: CustomerLocationActionProps) {
  const location = sharedLocation ?? { lat: 0, lng: 0, label: "", submittedAt: "" };
  const [saving, setSaving] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [pendingDisplay, setPendingDisplay] = useState<{ oldAddress: string; newAddress: string } | null>(null);
  const busy = useRef(false);
  const activeCase = useRef<string | null>(caseId);
  useEffect(() => {
    activeCase.current = caseId;
    return () => { activeCase.current = null; };
  }, [caseId]);
  const pending = useRef<{ lat: number; lng: number } | null>(null);
  const confirmationKey = JSON.stringify([caseId, expectedUpdatedAt, location.lat, location.lng, location.submittedAt]);
  const newAddress = location.address || `GPS ${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}`;
  const buttonClass = "inline-flex min-h-9 items-center justify-center rounded-lg border border-zinc-300 bg-white px-3 py-2 text-xs font-semibold text-zinc-800 hover:bg-zinc-100 disabled:opacity-40";

  function accept(detail: CaseDetailData) {
    const matches = detail.pickup?.lat === pending.current?.lat && detail.pickup?.lng === pending.current?.lng;
    onCaseChange?.(detail);
    pending.current = null;
    setUnconfirmed(false);
    setConfirmation(null);
    onNotice(matches ? "Miesto incidentu bolo nahradené GPS polohou klienta. Trasa sa aktualizuje podľa nového miesta." : "Miesto incidentu sa medzičasom opäť zmenilo. Zobrazujeme aktuálny uložený stav prípadu.");
  }

  async function reconcile() {
    const target = pending.current;
    if (!target) return;
    const response = await fetch(`/api/cases/${encodeURIComponent(caseId)}`, {
      headers: onCaseChange ? { "x-case-response": "detail-v2" } : {}, cache: "no-store", signal: AbortSignal.timeout(20_000),
    });
    const result = await response.json();
    if (activeCase.current !== caseId) return;
    const detail = (result.caseDetail ?? result.dispatchData?.dispatchCases?.find((item: CaseDetailData) => item.id === caseId)) as CaseDetailData | undefined;
    if (!response.ok || !detail || detail.id !== caseId) throw new Error("Aktuálne miesto sa nepodarilo overiť. Overte uloženie znova; zmenu znovu neposielame.");
    if (detail.pickup?.lat === target.lat && detail.pickup.lng === target.lng) {
      if (onCaseChange) accept(detail);
      else if (result.dispatchData) { onApplied(result.dispatchData); pending.current = null; setUnconfirmed(false); setConfirmation(null); onNotice("Miesto incidentu bolo nahradené GPS polohou klienta."); }
    }
    else onNotice("Nahradenie miesta zatiaľ nie je potvrdené. Obnovte prípad a skontrolujte aktuálne miesto; zmenu znovu neposielame.");
  }

  async function apply() {
    if (disabled || !sharedLocation || busy.current || !expectedUpdatedAt || (!unconfirmed && confirmation !== confirmationKey)) return;
    busy.current = true;
    setSaving(true);
    if (unconfirmed) {
      try { await reconcile(); }
      catch (error) { if (activeCase.current === caseId) onNotice(error instanceof Error ? error.message : "Výsledok zmeny zatiaľ nebolo možné overiť."); }
      finally { busy.current = false; setSaving(false); }
      return;
    }
    const mutationId = crypto.randomUUID();
    pending.current = { lat: location.lat, lng: location.lng };
    setPendingDisplay({ oldAddress: currentPickup?.address || currentPickup?.label || currentAddress || "Miesto ešte nie je zadané", newAddress });
    try {
      const response = await fetch(`/api/cases/${encodeURIComponent(caseId)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", ...(onCaseChange ? { "x-case-response": "detail-v2" } : {}) }, signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({ expectedUpdatedAt, mutationId, pickup: {
          label: "Miesto incidentu (GPS klienta)", address: newAddress,
          lat: location.lat, lng: location.lng, provider: "manual",
        } }),
      });
      const result = await response.json().catch(() => null);
      if (activeCase.current !== caseId) return;
      if (!response.ok && response.status < 500) {
        pending.current = null;
        setConfirmation(null);
        onNotice(response.status === 409 ? "Prípad sa medzičasom zmenil. Obnovte ho a skontrolujte miesto pred nahradením." : result?.error || "Miesto incidentu sa nepodarilo zmeniť.");
        return;
      }
      if (!response.ok || result?.mutationId !== mutationId || !result?.committedRevision) throw new Error("Uloženie overujeme podľa aktuálneho stavu prípadu.");
      if (result.caseDetail?.id === caseId && onCaseChange) accept(result.caseDetail);
      else if (result.dispatchData) {
        onApplied(result.dispatchData);
        pending.current = null;
        setConfirmation(null);
        const savedCase = result.dispatchData.dispatchCases?.find((item: CaseDetailData) => item.id === caseId);
        onNotice(!savedCase || (savedCase.pickup?.lat === location.lat && savedCase.pickup?.lng === location.lng) ? "Miesto incidentu bolo nahradené GPS polohou klienta." : "Miesto incidentu sa medzičasom opäť zmenilo. Zobrazujeme aktuálny uložený stav prípadu.");
      } else {
        setUnconfirmed(true);
        await reconcile();
      }
    } catch {
      if (activeCase.current !== caseId) return;
      setUnconfirmed(true);
      try { await reconcile(); }
      catch (error) { if (activeCase.current === caseId) onNotice(error instanceof Error ? error.message : "Výsledok zmeny overte obnovením prípadu."); }
    } finally { busy.current = false; setSaving(false); }
  }

  if (!sharedLocation) return { saving, control: null };
  if (saving || confirmation === confirmationKey || unconfirmed) return { saving, control: <div role="group" aria-label="Potvrdenie zmeny miesta incidentu" className="w-full rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5">
    <strong className="text-sm">Nahradiť miesto incidentu?</strong>
    <dl className="mt-2 grid gap-1"><div><dt className="inline text-zinc-600">Pôvodné miesto: </dt><dd className="inline break-words font-medium">{(saving || unconfirmed) && pendingDisplay ? pendingDisplay.oldAddress : currentPickup?.address || currentPickup?.label || currentAddress || "Miesto ešte nie je zadané"}</dd></div><div><dt className="inline text-zinc-600">Nové miesto: </dt><dd className="inline break-words font-medium">{(saving || unconfirmed) && pendingDisplay ? pendingDisplay.newAddress : newAddress}</dd></div></dl>
    <p className="mt-2 text-zinc-600">Zmení sa aj miesto pre výpočet trasy. Samotné zobrazenie GPS na mape miesto nemení.</p>
    {disabled && <p role="status" className="mt-2 font-medium">Najprv uložte rozpracované zmeny prípadu.</p>}
    <div className="mt-3 flex flex-wrap gap-2"><button type="button" disabled={disabled || saving} onClick={() => void apply()} className="inline-flex min-h-9 items-center justify-center rounded-lg border border-zinc-950 bg-zinc-950 px-3 py-2 text-xs font-semibold text-white hover:bg-zinc-800 disabled:opacity-40">{saving ? "Overujem miesto…" : unconfirmed ? "Overiť uloženie" : "Potvrdiť nahradenie"}</button>{!unconfirmed && <button type="button" disabled={saving} onClick={() => setConfirmation(null)} className={buttonClass}>Zrušiť</button>}</div>
  </div> };

  return { saving, control: <button type="button" onClick={() => setConfirmation(confirmationKey)} disabled={disabled || saving || !expectedUpdatedAt} title={disabled ? "Najprv uložte rozpracované zmeny prípadu." : "Po potvrdení nahradí miesto incidentu GPS polohou klienta."} className={buttonClass}>Nahradiť miesto incidentu</button> };
}
