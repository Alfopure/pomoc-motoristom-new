"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ExternalLink, LoaderCircle, Search, X } from "lucide-react";
import { TextField } from "./case-form-fields";
import { normalizeLicensePlateInput, normalizeVinInput } from "./case-form-shared";
import { emptyVehicleFieldPatch, isSlovakPlate, isVin, lookupIdentityConflict, normalizeVehicleIdentifier, preferredVehicleFacts, readVehicleLookupSnapshot, vehicleFieldLabels, vehicleSourceLabels, type LookupStatus, type VehicleField, type VehicleFormValues, type VehicleLookupResponse, type VehicleLookupSnapshot } from "@/lib/vehicle-lookup";

type Props = {
  plate: string;
  vin: string;
  values: VehicleFormValues;
  snapshot?: VehicleLookupSnapshot | null;
  contextKey: string;
  required?: boolean;
  disabled?: boolean;
  plateError?: string;
  vinError?: string;
  onPlateChange: (value: string) => void;
  onVinChange: (value: string) => void;
  onPlateBlur?: () => void;
  onApply: (patch: VehicleFormValues, snapshot: VehicleLookupSnapshot | null) => void;
};
const statusLabel: Record<LookupStatus, string> = { found: "Údaje nájdené", not_found: "Záznam nenájdený", ambiguous: "Nejednoznačná identita", challenge_required: "Vyžaduje ručné overenie", rate_limited: "Dočasný limit zdroja", unavailable: "Zdroj sa nepodarilo overiť", unsupported: "Automaticky nedostupné" };

export function VehicleLookupControl(props: Props) {
  const [proposal, setProposal] = useState<VehicleLookupResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [includePartial, setIncludePartial] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const request = useRef<AbortController | null>(null);
  const identity = `${props.contextKey}:${normalizeVehicleIdentifier(props.plate)}:${normalizeVehicleIdentifier(props.vin)}`;
  const [stateIdentity, setStateIdentity] = useState(identity);
  const currentIdentity = useRef(identity);
  const currentProps = useRef(props);
  useLayoutEffect(() => { currentIdentity.current = identity; currentProps.current = props; }, [identity, props]);
  // Reset only state tied to the changed vehicle; keep the input DOM and focus.
  if (stateIdentity !== identity) {
    setStateIdentity(identity);
    setProposal(null); setLoading(false); setError(null); setIncludePartial(false);
  }
  useEffect(() => () => { request.current?.abort(); request.current = null; }, [identity]);

  async function lookup(kind: "plate" | "vin") {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const requestedIdentity = identity;
    setLoading(true); setError(null); setProposal(null); setExpanded(true); setIncludePartial(false);
    const timer = setTimeout(() => controller.abort(), 55_000);
    try {
      const response = await fetch("/api/vehicles/lookup", { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal, body: JSON.stringify({ kind, value: kind === "plate" ? props.plate : props.vin, country: "SK", knownIdentity: { plate: props.plate, vin: props.vin, country: "SK" } }) });
      const result = await response.json() as VehicleLookupResponse & { error?: string };
      if (currentIdentity.current !== requestedIdentity || controller.signal.aborted) return;
      if (!response.ok || !readVehicleLookupSnapshot(result.snapshot)) throw new Error(result.error || "Dohľadanie sa nepodarilo dokončiť.");
      setProposal(result);
    } catch (caught) {
      if (currentIdentity.current === requestedIdentity && request.current === controller) setError(controller.signal.aborted ? "Dohľadávanie trvalo príliš dlho. Skúste neskôr alebo overte údaje pri zdroji." : (caught as Error).message);
    } finally {
      clearTimeout(timer);
      if (currentIdentity.current === requestedIdentity && request.current === controller) setLoading(false);
    }
  }

  function changeIdentity(kind: "plate" | "vin", value: string) {
    request.current?.abort(); request.current = null;
    if (props.snapshot && normalizeVehicleIdentifier(value) !== normalizeVehicleIdentifier(kind === "plate" ? props.plate : props.vin)) props.onApply({}, null);
    (kind === "plate" ? props.onPlateChange : props.onVinChange)(kind === "plate" ? normalizeLicensePlateInput(value) : normalizeVinInput(value));
  }
  const snapshot = proposal?.snapshot ?? props.snapshot;
  const result = snapshot?.result;
  const conflict = result ? lookupIdentityConflict(result, { plate: props.plate, vin: props.vin }) : undefined;
  const facts = result ? preferredVehicleFacts(result, true) : {};
  const partial = Object.values(facts).some((fact) => fact.quality === "partial");
  const patch = result ? emptyVehicleFieldPatch(result, { ...props.values, plate: props.plate, vin: props.vin }, includePartial) : {};

  return (
    <div className="col-span-full min-w-0" data-testid="vehicle-lookup">
      <div className="grid gap-3 sm:grid-cols-2">
        {(["plate", "vin"] as const).map((kind) => (
          <div key={kind} className="flex min-w-0 items-start gap-1.5">
            <div className="min-w-0 flex-1"><TextField label={kind === "plate" ? "EČV" : "VIN"} value={kind === "plate" ? props.plate : props.vin} onChange={(value) => changeIdentity(kind, value)} onBlur={kind === "plate" ? props.onPlateBlur : undefined} required={kind === "plate" && props.required} error={kind === "plate" ? props.plateError : props.vinError} disabled={props.disabled} /></div>
            <button type="button" title={`Dohľadať podľa ${kind === "plate" ? "EČV" : "VIN"} · Slovensko`} aria-label={`Dohľadať podľa ${kind === "plate" ? "EČV" : "VIN"}`} disabled={props.disabled || loading || !(kind === "plate" ? isSlovakPlate(normalizeVehicleIdentifier(props.plate)) : isVin(normalizeVehicleIdentifier(props.vin)))} onClick={() => void lookup(kind)} className="mt-6 flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-yellow-300 bg-yellow-50 text-zinc-800 hover:bg-yellow-100 disabled:opacity-40">
              {loading ? <LoaderCircle size={17} className="animate-spin" /> : <Search size={17} />}
            </button>
          </div>
        ))}
      </div>
      {loading && <p role="status" className="mt-2 text-xs text-zinc-600">Overujem slovenské vozidlo a PZP k dnešnému dňu… Formulár môžete ďalej vypĺňať.</p>}
      {error && <p role="alert" className="mt-2 rounded-md bg-amber-50 p-2 text-xs text-amber-900">{error}</p>}
      {snapshot && <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
        <div className="flex items-center justify-between gap-2">
          <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} className="text-left text-sm font-semibold">{proposal ? "Dohľadané údaje · návrh" : "Uložené overenie vozidla"} · {new Date(snapshot.result.fetchedAt).toLocaleString("sk-SK", { timeZone: "Europe/Bratislava" })}</button>
          {proposal && <button type="button" aria-label="Zavrieť návrh dohľadania" onClick={() => { setProposal(null); setExpanded(false); }}><X size={16} /></button>}
        </div>
        {expanded && <>
          <p className="mt-1 text-xs text-zinc-600">PZP ku dňu {snapshot.result.query.checkedForDate}. {proposal?.cached ? "Nedávno získaný výsledok (najviac 15 minút)." : "Pri staršom zásahu nejde o overenie ku dňu incidentu."}</p>
          {conflict && <p role="alert" className="mt-2 rounded bg-amber-100 p-2 text-xs text-amber-950">{conflict}</p>}
          <dl className="mt-3 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
            {(Object.entries(facts) as [VehicleField, { value: string; quality: string }][]).map(([field, fact]) => {
              const source = snapshot.result.sources.find((candidate) => candidate.status === "found" && candidate.facts[field] === fact);
              return <div key={field} className="flex min-w-0 justify-between gap-3 border-b border-zinc-200 py-1"><dt className="text-zinc-600">{vehicleFieldLabels[field]}{fact.quality === "partial" ? " · návrh" : ""}{source && <span className="block text-[10px] text-zinc-500">{vehicleSourceLabels[source.source]}</span>}</dt><dd className="break-all text-right font-medium">{fact.value}</dd></div>;
            })}
          </dl>
          <div className="mt-3 space-y-2">
            {snapshot.result.sources.map((source) => <div key={source.source} className="text-xs"><a href={source.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold underline">{vehicleSourceLabels[source.source]} <ExternalLink size={11} /></a><span className="ml-2 text-zinc-600">{statusLabel[source.status]}</span>{source.warnings.map((warning) => <p key={warning} className="mt-0.5 text-zinc-600">{warning}</p>)}{source.reports?.map((report) => <a key={report.url} href={report.url} target="_blank" rel="noreferrer" className="mt-1 block font-semibold text-amber-900 underline">{report.title}</a>)}</div>)}
          </div>
          <p className="mt-3 text-xs text-zinc-600">Diaľničná známka a prvá registrácia neboli automaticky overené. <a href="https://eznamka.sk/selfcare/modification/select/select-vignettes/?operation=Check" target="_blank" rel="noreferrer" className="underline">Otvoriť overenie známky</a></p>
          {proposal && <>
            {partial && <label className="mt-3 flex items-start gap-2 text-xs text-zinc-700"><input type="checkbox" checked={includePartial} onChange={(event) => setIncludePartial(event.target.checked)} />Zahrnúť aj návrhy z neúplného VIN dekódovania; overím ich podľa dokladov.</label>}
            <p className="mt-2 text-xs text-zinc-600">Existujúce hodnoty zostanú zachované. {Object.keys(patch).length ? `Doplní sa: ${Object.keys(patch).map((field) => vehicleFieldLabels[field as VehicleField]).join(", ")}.` : "Uloží sa iba prehľad získaných údajov."}</p>
            <button type="button" disabled={Boolean(conflict) || props.disabled || loading} onClick={() => {
              const latest = currentProps.current;
              if (lookupIdentityConflict(snapshot.result, { plate: latest.plate, vin: latest.vin })) return;
              const acceptedPatch = emptyVehicleFieldPatch(snapshot.result, { ...latest.values, plate: latest.plate, vin: latest.vin }, includePartial);
              latest.onApply(acceptedPatch, snapshot); setProposal(null);
            }} className="mt-2 rounded-md bg-yellow-300 px-3 py-2 text-xs font-semibold text-zinc-950 hover:bg-yellow-400 disabled:opacity-40">Doplniť prázdne polia a prijať overenie</button>
          </>}
        </>}
      </div>}
    </div>
  );
}
