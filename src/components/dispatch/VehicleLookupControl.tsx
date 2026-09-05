"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ExternalLink, LoaderCircle, Search, X } from "lucide-react";
import { TextField } from "./case-form-fields";
import { normalizeLicensePlateInput, normalizeVinInput } from "./case-form-shared";
import { emptyVehicleFieldPatch, hakaReportMatch, isSlovakPlate, isVin, lookupIdentityConflict, normalizeVehicleIdentifier, preferredVehicleFacts, vehicleFactConflicts, vehicleFieldLabels, vehicleSourceLabels, type LookupStatus, type VehicleField, type VehicleFieldChoices, type VehicleFormValues, type VehicleLookupResponse, type VehicleLookupSnapshot, type VehicleSource } from "@/lib/vehicle-lookup";
import { requestVehicleLookup } from "@/lib/vehicle-lookup-client";

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
  const [choices, setChoices] = useState<VehicleFieldChoices>({});
  const [waiting, setWaiting] = useState(0);
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
    setProposal(null); setLoading(false); setError(null); setIncludePartial(false); setChoices({}); setWaiting(0);
  }
  useEffect(() => () => { request.current?.abort(); request.current = null; }, [identity]);

  async function lookup(kind: "plate" | "vin") {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const requestedIdentity = identity;
    setLoading(true); setError(null); setProposal(null); setExpanded(true); setIncludePartial(false); setChoices({}); setWaiting(0);
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const result = await requestVehicleLookup({ kind, value: kind === "plate" ? props.plate : props.vin, country: "SK", knownIdentity: { plate: props.plate, vin: props.vin, country: "SK" } }, controller.signal, (seconds) => {
        if (currentIdentity.current === requestedIdentity && request.current === controller) setWaiting(seconds);
      });
      if (currentIdentity.current !== requestedIdentity || controller.signal.aborted) return;
      setProposal(result);
    } catch (caught) {
      if (currentIdentity.current === requestedIdentity && request.current === controller) setError(controller.signal.aborted ? "Dohľadávanie trvalo príliš dlho. Skúste neskôr alebo overte údaje pri zdroji." : (caught as Error).message);
    } finally {
      clearTimeout(timer);
      if (currentIdentity.current === requestedIdentity && request.current === controller) { setLoading(false); setWaiting(0); }
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
  const fieldConflicts = result ? vehicleFactConflicts(result, includePartial) : {};
  const partial = Object.values(facts).some((fact) => fact.quality === "partial");
  const patch = result ? emptyVehicleFieldPatch(result, { ...props.values, plate: props.plate, vin: props.vin }, includePartial, choices) : {};

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
      {loading && <p role="status" className="mt-2 text-xs text-zinc-600">{waiting ? `Prebieha iné dohľadávanie. Automaticky skúsim znova o ${waiting} s…` : "Overujem slovenské vozidlo a PZP k dnešnému dňu…"} Formulár môžete ďalej vypĺňať.</p>}
      {error && <p role="alert" className="mt-2 rounded-md bg-amber-50 p-2 text-xs text-amber-900">{error}</p>}
      {snapshot && <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
        <div className="flex items-center justify-between gap-2">
          <button type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} className="text-left text-sm font-semibold">{proposal ? "Dohľadané údaje · návrh" : "Uložené overenie vozidla"} · získané {new Date(snapshot.result.fetchedAt).toLocaleString("sk-SK", { timeZone: "Europe/Bratislava" })}</button>
          {proposal && <button type="button" aria-label="Zavrieť návrh dohľadania" onClick={() => { setProposal(null); setExpanded(false); }}><X size={16} /></button>}
        </div>
        {expanded && <>
          <p className="mt-1 text-xs text-zinc-600">PZP ku dňu {snapshot.result.query.checkedForDate}. {proposal?.cached ? "Nedávno získaný výsledok (najviac 15 minút)." : "Pri staršom zásahu nejde o overenie ku dňu incidentu."}</p>
          {snapshot.result.sources.some(source => source.source === "stkonline" && source.status === "found") && <p className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-900">STKonline aktualizuje TK/EK raz za tri mesiace. Zobrazený čas získania nepotvrdzuje aktuálnosť evidencie; novú kontrolu overte podľa protokolu.</p>}
          {conflict && <p role="alert" className="mt-2 rounded bg-amber-100 p-2 text-xs text-amber-950">{conflict}</p>}
          <dl className="mt-3 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
            {(Object.entries(facts) as [VehicleField, { value: string; quality: string }][]).map(([field, fact]) => {
              const source = snapshot.result.sources.find((candidate) => candidate.status === "found" && candidate.facts[field] === fact);
              const alternatives = fieldConflicts[field];
              if (alternatives) return <div key={field} className="min-w-0 rounded bg-amber-50 p-2 sm:col-span-2">
                <dt className="font-semibold text-amber-900">{vehicleFieldLabels[field]} · rozdielne údaje zdrojov</dt>
                <dd className="mt-1 space-y-1">
                  {alternatives.map(option => <p key={option.source}>{option.fact.value} · {vehicleSourceLabels[option.source]}</p>)}
                  {proposal && <label className="block pt-1">{vehicleFieldLabels[field]}: vyberte zdroj
                    <select className="mt-1 block w-full rounded border border-amber-300 bg-white p-1.5" value={choices[field] ?? ""} onChange={event => setChoices(previous => ({ ...previous, [field]: event.target.value as VehicleSource }))}>
                      <option value="">Nedopĺňať toto pole</option>
                      {alternatives.map(option => <option key={option.source} value={option.source}>{option.fact.value} · {vehicleSourceLabels[option.source]}</option>)}
                    </select>
                  </label>}
                </dd>
              </div>;
              return <div key={field} className="flex min-w-0 justify-between gap-3 border-b border-zinc-200 py-1"><dt className="text-zinc-600">{vehicleFieldLabels[field]}{fact.quality === "partial" ? " · návrh" : ""}{source && <span className="block text-[10px] text-zinc-500">{vehicleSourceLabels[source.source]}</span>}</dt><dd className="break-all text-right font-medium">{fact.value}</dd></div>;
            })}
          </dl>
          <div className="mt-3 space-y-2">
            {snapshot.result.sources.map((source) => <div key={source.source} className="text-xs"><a href={source.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold underline">{vehicleSourceLabels[source.source]} <ExternalLink size={11} /></a><span className="ml-2 text-zinc-600">{statusLabel[source.status]}</span>{source.warnings.map((warning) => <p key={warning} className="mt-0.5 text-zinc-600">{warning}</p>)}{source.reports?.map((report) => {
              const match = hakaReportMatch(report, snapshot.result, { plate: props.plate, vin: props.vin });
              const label = { vin: "Zhoda VIN. Aktuálny stav overte v článku.", plate: "Zhoda iba EČV; VIN hlásenia a vozidla sa nepodarilo porovnať.", conflict: "Identita hlásenia nesúhlasí s vozidlom. Hlásenie nepotvrdzuje odcudzenie tohto vozidla.", unverified: "Identita tohto hlásenia nebola overená. Overte EČV a VIN v článku." }[match];
              return <div key={report.url} className="mt-1 rounded bg-amber-50 p-2"><a href={report.url} target="_blank" rel="noreferrer" className="font-semibold text-amber-900 underline">{report.title}</a><p className="mt-1 text-amber-900" role={match === "conflict" ? "alert" : undefined}>{label}</p></div>;
            })}</div>)}
          </div>
          <p className="mt-3 text-xs text-zinc-600">Diaľničná známka a prvá registrácia neboli automaticky overené. <a href="https://eznamka.sk/selfcare/modification/select/select-vignettes/?operation=Check" target="_blank" rel="noreferrer" className="underline">Otvoriť overenie známky</a></p>
          {proposal && <>
            {partial && <label className="mt-3 flex items-start gap-2 text-xs text-zinc-700"><input type="checkbox" checked={includePartial} onChange={(event) => setIncludePartial(event.target.checked)} />Zahrnúť aj návrhy z neúplného VIN dekódovania; overím ich podľa dokladov.</label>}
            <p className="mt-2 text-xs text-zinc-600">Existujúce hodnoty zostanú zachované. {Object.keys(patch).length ? `Doplní sa: ${Object.keys(patch).map((field) => vehicleFieldLabels[field as VehicleField]).join(", ")}.` : "Uloží sa iba prehľad získaných údajov."}</p>
            <button type="button" disabled={Boolean(conflict) || props.disabled || loading} onClick={() => {
              const latest = currentProps.current;
              if (lookupIdentityConflict(snapshot.result, { plate: latest.plate, vin: latest.vin })) return;
              const acceptedPatch = emptyVehicleFieldPatch(snapshot.result, { ...latest.values, plate: latest.plate, vin: latest.vin }, includePartial, choices);
              latest.onApply(acceptedPatch, snapshot); setProposal(null);
            }} className="mt-2 rounded-md bg-yellow-300 px-3 py-2 text-xs font-semibold text-zinc-950 hover:bg-yellow-400 disabled:opacity-40">Doplniť prázdne polia a prijať overenie</button>
          </>}
        </>}
      </div>}
    </div>
  );
}
