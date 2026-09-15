"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowUpRight, CarFront, LoaderCircle, Search } from "lucide-react";
import { isSlovakPlate, isVin, lookupIdentityConflict, normalizeVehicleIdentifier, preferredVehicleFacts, vehicleFactConflicts, vehicleFieldLabels, type VehicleField, type VehicleIdentity, type VehicleLookupResponse } from "@/lib/vehicle-lookup";
import { requestVehicleLookup } from "@/lib/vehicle-lookup-client";
import { VehicleLookupDetails, vehicleLookupDate } from "./VehicleLookupDetails";

type Props = { compact?: boolean; active?: boolean; lookupRequest?: { id: number; value: string } };
const summaryFields: VehicleField[] = ["fuel", "color", "powerKw", "transmission", "curbWeightKg", "drivenAxles"];

/** A read-only lookup: fleet search and the toolbox share the same dated result and full detail. */
export function VehicleLookupSearch({ compact = false, active = true, lookupRequest }: Props) {
  const inputId = useId();
  const [value, setValue] = useState("");
  const [response, setResponse] = useState<VehicleLookupResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [waiting, setWaiting] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const request = useRef<AbortController | null>(null);
  const container = useRef<HTMLElement | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const consumedRequest = useRef<number | undefined>(undefined);
  const latestLookup = useRef<(input: string) => Promise<void>>(null);
  const normalized = normalizeVehicleIdentifier(value);
  const valid = isVin(normalized) || isSlovakPlate(normalized);
  if (!active && expanded) setExpanded(false);
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);
  useLayoutEffect(() => {
    const node = container.current;
    if (!compact || !active || !response || !node?.getClientRects().length) return;
    // The result increases the card's height after quick launch has scrolled.
    // Keep it readable inside the tools pane without moving the main workspace.
    const scroller = node.closest<HTMLElement>(".widget-host-scroll");
    const card = node.closest<HTMLElement>("[data-widget]");
    if (scroller && card) scroller.scrollTo({ top: scroller.scrollTop + card.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8 });
  }, [active, compact, response]);

  function changeValue(next: string) {
    request.current?.abort(); request.current = null;
    setValue(next.toUpperCase()); setResponse(null); setError(null); setLoading(false); setWaiting(0); setExpanded(false);
  }
  async function lookup(input: string) {
    const identifier = normalizeVehicleIdentifier(input);
    if (!isVin(identifier) && !isSlovakPlate(identifier)) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setValue(identifier); setResponse(null); setError(null); setLoading(true); setWaiting(0); setExpanded(false);
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const result = await requestVehicleLookup({ kind: isVin(identifier) ? "vin" : "plate", value: identifier, country: "SK" }, controller.signal, seconds => {
        if (request.current === controller) setWaiting(seconds);
      });
      if (request.current === controller && !controller.signal.aborted) setResponse(result);
    } catch (caught) {
      if (request.current === controller) setError(controller.signal.aborted ? "Dohľadávanie trvalo príliš dlho. Skúste neskôr." : caught instanceof Error ? caught.message : "Vozidlo sa nepodarilo overiť.");
    } finally {
      clearTimeout(timer);
      if (request.current === controller) { setLoading(false); setWaiting(0); }
    }
  }
  useLayoutEffect(() => { latestLookup.current = lookup; });
  useEffect(() => {
    if (!lookupRequest || !active || consumedRequest.current === lookupRequest.id) return;
    const timer = setTimeout(() => {
      consumedRequest.current = lookupRequest.id;
      void latestLookup.current?.(lookupRequest.value);
    }, 0);
    return () => clearTimeout(timer);
  }, [lookupRequest, active]);

  const result = response?.snapshot.result;
  const identity: VehicleIdentity = { [isVin(normalized) ? "vin" : "plate"]: normalized };
  const conflict = result ? response?.conflict ?? lookupIdentityConflict(result, identity) : undefined;
  const facts = result ? preferredVehicleFacts(result, true) : {};
  const conflicts = result ? vehicleFactConflicts(result, true) : {};
  const title = conflict ? "Overte identitu vozidla" : [facts.make?.value, facts.model?.value].filter(Boolean).join(" ") || "Výsledok overenia";
  return <section ref={container} aria-label="Vyhľadanie vozidla" data-testid="vehicle-lookup-search" className={compact ? "min-w-0 p-3" : "min-w-0 rounded-xl border border-zinc-200 bg-white p-4"}>
    {!compact && <div className="mb-3 flex items-start gap-2"><CarFront size={19} className="mt-0.5 shrink-0 text-zinc-500" /><div><h2 className="text-sm font-semibold">Overenie vozidla podľa EČV alebo VIN</h2><p className="mt-0.5 text-xs text-zinc-500">Technické údaje a PZP pre slovenské vozidlá.</p></div></div>}
    <label htmlFor={inputId} className="mb-1 block text-xs font-medium text-zinc-600">EČV alebo VIN</label>
    <div className="flex min-w-0 gap-2">
      <input id={inputId} value={value} onChange={event => changeValue(event.target.value)} onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); if (valid && !loading && active) void lookup(value); }
      }} maxLength={30} autoCapitalize="characters" autoComplete="off" spellCheck={false} placeholder="Zadajte EČV alebo VIN" className="h-10 min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 text-sm uppercase outline-none focus:border-yellow-500 focus:ring-2 focus:ring-yellow-200" />
      <button type="button" disabled={!valid || loading || !active} onClick={event => { opener.current = event.currentTarget; void lookup(value); }} className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg bg-yellow-300 px-3 text-xs font-semibold text-zinc-950 hover:bg-yellow-400 disabled:opacity-40">
        {loading ? <LoaderCircle size={15} className="animate-spin" /> : <Search size={15} />}Overiť
      </button>
    </div>
    {loading && <p role="status" className="mt-2 text-xs text-zinc-600">{waiting ? `Prebieha iné overenie. Skúsim znova o ${waiting} s…` : "Overujem údaje vozidla a PZP…"}</p>}
    {error && <p role="alert" className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">{error}</p>}
    {result && response && <div role="region" aria-label="Výsledok overenia vozidla" className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
      <h3 className="break-words text-sm font-semibold">{title}</h3>
      <p className="mt-1 break-all text-xs text-zinc-600">{conflict ? normalized : [facts.plate?.value, facts.vin?.value].filter(Boolean).join(" · ") || normalized}</p>
      <p className="mt-1 text-[11px] text-zinc-500">{response.cached ? "Z predchádzajúceho overenia" : "Získané"} {vehicleLookupDate(result.fetchedAt, true)}</p>
      {conflict ? <p role="alert" className="mt-2 text-xs font-medium text-amber-900">{conflict} PZP vozidla nepotvrdené.</p> : <>
        <p className="mt-2 text-xs text-zinc-800">PZP: <strong>{conflicts.insuranceStatus || conflicts.insurer ? "Rozdielne údaje zdrojov" : facts.insuranceStatus?.value ?? "nepotvrdené"}</strong>{!conflicts.insurer && facts.insurer && ` · ${facts.insurer.value}`} · k {vehicleLookupDate(result.query.checkedForDate)}</p>
        {!facts.insuranceStatus && <p className="mt-1 text-[11px] text-zinc-500">Chýbajúci výsledok neznamená, že auto nie je poistené.</p>}
        <dl className={`mt-3 grid gap-x-3 gap-y-2 ${compact ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6"}`}>
          {summaryFields.map(field => <div key={field} className="min-w-0"><dt className="text-[11px] text-zinc-500">{vehicleFieldLabels[field]}</dt><dd className={`mt-0.5 break-words text-xs font-medium ${conflicts[field] ? "text-amber-900" : "text-zinc-900"}`}>{conflicts[field] ? "Rozdielne údaje" : facts[field]?.value ?? "Nezistené"}{!conflicts[field] && facts[field]?.quality === "partial" && " · návrh"}</dd></div>)}
        </dl>
      </>}
      <button type="button" aria-haspopup="dialog" onClick={event => { opener.current = event.currentTarget; setExpanded(true); }} className="mt-3 inline-flex min-h-9 items-center gap-1 text-xs font-semibold text-zinc-800 underline underline-offset-4">Celý detail vozidla<ArrowUpRight size={14} /></button>
      {expanded && active && <VehicleLookupDetails returnFocus={opener} snapshot={response.snapshot} readOnly proposal={false} cached={response.cached} identity={identity} conflict={conflict} includePartial={true} choices={{}} patch={{}} disabled={false} onIncludePartial={() => {}} onChoice={() => {}} onClose={() => setExpanded(false)} onAccept={() => {}} />}
    </div>}
  </section>;
}
