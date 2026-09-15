"use client";

import { useEffect, useId, useRef, type RefObject } from "react";
import { ExternalLink, Shield, X } from "lucide-react";
import { hakaReportMatch, preferredVehicleFacts, vehicleFactConflicts, vehicleFieldLabels, vehicleSourceLabels, type LookupStatus, type VehicleFact, type VehicleField, type VehicleFieldChoices, type VehicleFormValues, type VehicleIdentity, type VehicleLookupSnapshot, type VehicleSource } from "@/lib/vehicle-lookup";

const statusLabel: Record<LookupStatus, string> = {
  found: "Údaje nájdené", not_found: "Záznam nenájdený", ambiguous: "Nejednoznačná identita",
  challenge_required: "Vyžaduje ručné overenie", rate_limited: "Dočasný limit zdroja",
  unavailable: "Zdroj sa nepodarilo overiť", unsupported: "Automaticky nedostupné",
};

const technicalFields: VehicleField[] = ["fuel", "bodyType", "drivenAxles", "curbWeightKg", "grossWeightKg", "color", "transmission", "transmissionGears", "powerKw", "engineCapacityCc", "engineNumber", "axleCount", "engineType"];
const additionalGroups: { title: string; fields: VehicleField[] }[] = [
  { title: "Motor a jazdné vlastnosti", fields: ["engineManufacturer", "engineRpm", "maxSpeedKmh", "emissionClass"] },
  { title: "Podvozok, rozmery a hmotnosti", fields: ["grossTrainWeightKg", "maxAxleWeightKg", "trailerWeightKg", "trailerBrakedWeightKg", "trailerUnbrakedWeightKg", "wheelbaseMm", "lengthMm", "widthMm", "heightMm", "tireDimensions", "rimDimensions", "towingDevice"] },
  { title: "Evidencia a typ vozidla", fields: ["vehicleCategory", "vehicleType", "vehicleTypeDesignation", "typeVariantVersion", "variant", "version", "manufacturer", "firstRegisteredAt", "firstRegisteredInSkAt"] },
];
const identityFields: VehicleField[] = ["plate", "vin", "make", "model", "modelYear", "doors", "seats"];
const inspectionFields: VehicleField[] = ["technicalInspectionValidUntil", "emissionInspectionValidUntil", "technicalInspectionAt", "emissionInspectionAt"];

export function vehicleLookupDate(value: string, includeTime = false) {
  return new Date(includeTime ? value : `${value}T12:00:00Z`).toLocaleString("sk-SK", {
    timeZone: "Europe/Bratislava", day: "numeric", month: "numeric", year: "numeric",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit" } as const : {}),
  });
}

type Props = {
  returnFocus: RefObject<HTMLButtonElement | null>;
  snapshot: VehicleLookupSnapshot;
  proposal: boolean;
  readOnly?: boolean;
  cached: boolean;
  identity: VehicleIdentity;
  conflict?: string;
  includePartial: boolean;
  choices: VehicleFieldChoices;
  patch: VehicleFormValues;
  disabled: boolean;
  onIncludePartial: (value: boolean) => void;
  onChoice: (field: VehicleField, source: VehicleSource | "") => void;
  onClose: () => void;
  onAccept: () => void;
};

export function VehicleLookupDetails(props: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const descriptionId = useId();
  const { result } = props.snapshot;
  const facts = preferredVehicleFacts(result, true);
  const conflicts = vehicleFactConflicts(result, props.includePartial);
  const partial = Object.values(facts).some(fact => fact.quality === "partial");
  const insurance = result.sources.find(source => source.source === "skp");
  const title = [facts.make?.value, facts.model?.value].filter(Boolean).join(" ");

  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);

  function closeDialog(afterClose = props.onClose) {
    dialog.current?.close();
    afterClose();
    if (props.returnFocus.current?.isConnected) props.returnFocus.current.focus();
  }

  function factRow(field: VehicleField, showMissing = false) {
    const fact = facts[field];
    if (!fact && !showMissing) return null;
    const source = result.sources.find(candidate => candidate.status === "found" && candidate.facts[field] === fact);
    const alternatives = conflicts[field];
    return <div key={field} className={`min-w-0 rounded-lg border p-3 ${alternatives ? "border-amber-200 bg-amber-50" : "border-zinc-200 bg-white"}`}>
      <dt className="text-xs text-zinc-600">{vehicleFieldLabels[field]}{fact?.quality === "partial" ? " · návrh" : ""}{alternatives ? " · rozdielne údaje zdrojov" : ""}</dt>
      <dd className="mt-1 break-words text-sm font-semibold text-zinc-950">
        {alternatives ? <>
          <div className="space-y-1">{alternatives.map(option => <p key={option.source}>{option.fact.value}<span className="block text-[11px] font-normal text-zinc-600">{vehicleSourceLabels[option.source]}</span></p>)}</div>
          {props.proposal && <label className="mt-2 block text-xs font-normal">{vehicleFieldLabels[field]}: vyberte zdroj
            <select className="mt-1 block w-full rounded-md border border-amber-300 bg-white p-2 text-xs" value={props.choices[field] ?? ""} onChange={event => props.onChoice(field, event.target.value as VehicleSource | "")}>
              <option value="">Nedopĺňať toto pole</option>
              {alternatives.map(option => <option key={option.source} value={option.source}>{option.fact.value} · {vehicleSourceLabels[option.source]}</option>)}
            </select>
          </label>}
        </> : <>{fact?.value ?? <span className="font-normal text-zinc-400">Nezistené</span>}{fact && source && <span className="mt-0.5 block text-[11px] font-normal text-zinc-500">{vehicleSourceLabels[source.source]}</span>}</>}
      </dd>
    </div>;
  }

  return <dialog ref={dialog} aria-labelledby={headingId} aria-describedby={descriptionId}
    className="m-auto max-h-[92dvh] w-[calc(100%-1.5rem)] max-w-3xl overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50 p-0 text-zinc-950 shadow-2xl backdrop:bg-zinc-950/50 open:flex open:flex-col"
    onCancel={event => { event.preventDefault(); event.stopPropagation(); closeDialog(); }}
    onKeyDown={event => {
      // A vehicle popup can be opened inside a case/fleet dialog. Keep Escape local.
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeDialog(); }
      if (event.key === "Tab") {
        event.stopPropagation();
        const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex="-1"])')).filter(element => element.getClientRects().length > 0);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
    <header className="flex shrink-0 items-start justify-between gap-3 border-b border-zinc-200 bg-white p-4 sm:px-5">
      <div className="min-w-0">
        <p className="text-xs font-medium text-zinc-500">{props.readOnly ? "Výsledok overenia vozidla" : props.proposal ? "Dohľadané údaje · návrh" : "Uložené overenie vozidla"}</p>
        <h2 id={headingId} className="mt-1 text-lg font-semibold">Detail vozidla{title ? ` · ${title}` : ""}</h2>
        <p id={descriptionId} className="mt-1 break-words text-xs text-zinc-600">{facts.plate?.value ?? props.identity.plate ?? result.query.value}{facts.vin && ` · VIN ${facts.vin.value}`}</p>
        <p className={`mt-2 text-xs ${props.conflict ? "font-medium text-amber-900" : "text-zinc-700"}`}>{props.conflict ? "Identita nesúhlasí · PZP vozidla nepotvrdené" : <>PZP: <strong>{facts.insuranceStatus?.value ?? "nepotvrdené"}</strong>{facts.insurer && ` · ${facts.insurer.value}`} · k {vehicleLookupDate(result.query.checkedForDate)}</>}</p>
      </div>
      <button type="button" autoFocus aria-label={props.proposal ? "Zavrieť návrh dohľadania" : "Zavrieť detail vozidla"} onClick={() => closeDialog()} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-zinc-200 bg-white hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yellow-500"><X size={18} /></button>
    </header>
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-4 sm:p-5">
      {props.conflict && <p role="alert" className="rounded-lg border border-amber-300 bg-amber-100 p-3 text-sm text-amber-950">{props.conflict}</p>}
      <section aria-labelledby={`${headingId}-technical`}>
        <h3 id={`${headingId}-technical`} className="text-sm font-semibold">Technické údaje pre zásah</h3>
        <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">{technicalFields.map(field => factRow(field, true))}</dl>
      </section>
      <section aria-label="Poistenie vozidla" className="rounded-xl border border-zinc-200 bg-white p-4">
        <div className="flex items-start gap-3"><Shield size={20} className="mt-0.5 shrink-0 text-zinc-500" /><div>
          <h3 className="text-sm font-semibold">Povinné zmluvné poistenie</h3>
          <p className="mt-1 text-xs text-zinc-600">Overované ku dňu {vehicleLookupDate(result.query.checkedForDate)}</p>
        </div></div>
        {props.conflict ? <p className="mt-3 text-sm font-medium text-amber-900">PZP vozidla nepotvrdené. Identita zo zdrojov nesúhlasí; overte VIN v dokladoch. Pôvodné výsledky sú uvedené v podrobnostiach jednotlivých zdrojov.</p> : facts.insuranceStatus || facts.insurer ? <dl className="mt-3 grid gap-2 sm:grid-cols-2">{factRow("insuranceStatus")}{factRow("insurer")}</dl> : <p className="mt-3 text-sm font-medium text-amber-900">PZP sa nepodarilo potvrdiť.{insurance && ` ${statusLabel[insurance.status]}.`}</p>}
        {!facts.insuranceStatus && <p className="mt-1 text-xs text-zinc-600">Chýbajúci výsledok neznamená, že vozidlo nie je poistené.</p>}
        <p className="mt-2 text-xs text-zinc-500">Pri staršom zásahu nejde o overenie ku dňu incidentu.</p>
      </section>
      <section aria-labelledby={`${headingId}-identity`}>
        <h3 id={`${headingId}-identity`} className="text-sm font-semibold">Identifikácia a ďalšie údaje</h3>
        <dl className="mt-2 grid gap-2 sm:grid-cols-2">{identityFields.map(field => factRow(field))}</dl>
      </section>
      {additionalGroups.filter(group => group.fields.some(field => facts[field])).map(group => <section key={group.title} aria-label={group.title}>
        <h3 className="text-sm font-semibold">{group.title}</h3>
        <dl className="mt-2 grid gap-2 sm:grid-cols-2">{group.fields.map(field => factRow(field))}</dl>
      </section>)}
      {inspectionFields.some(field => facts[field]) && <section aria-labelledby={`${headingId}-inspections`}>
        <h3 id={`${headingId}-inspections`} className="text-sm font-semibold">Technická a emisná kontrola</h3>
        {result.sources.some(source => source.source === "stkonline" && source.status === "found") && <p className="mt-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">STKonline aktualizuje TK/EK raz za tri mesiace. Čas získania nepotvrdzuje aktuálnosť evidencie; novú kontrolu overte podľa protokolu.</p>}
        <dl className="mt-2 grid gap-2 sm:grid-cols-2">{inspectionFields.map(field => factRow(field))}</dl>
      </section>}
      <section aria-labelledby={`${headingId}-sources`}>
        <h3 id={`${headingId}-sources`} className="text-sm font-semibold">Zdroje a podrobnosti overenia</h3>
        <p className="mt-1 text-xs text-zinc-500">Získané {vehicleLookupDate(result.fetchedAt, true)}.{props.cached && " Nedávno získaný výsledok (najviac 15 minút)."}</p>
        <div className="mt-2 space-y-2">{result.sources.map(source => <div key={source.source} className="rounded-lg border border-zinc-200 bg-white p-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2"><a href={source.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold underline underline-offset-2">{vehicleSourceLabels[source.source]}<ExternalLink size={12} /></a><span className="text-zinc-600">{statusLabel[source.status]}</span></div>
          {source.warnings.map(warning => <p key={warning} className="mt-2 text-zinc-600">{warning}</p>)}
          {source.reports?.map(report => {
            const match = hakaReportMatch(report, result, props.identity);
            const label = { vin: "Zhoda VIN. Aktuálny stav overte v článku.", plate: "Zhoda iba EČV; VIN hlásenia a vozidla sa nepodarilo porovnať.", conflict: "Identita hlásenia nesúhlasí s vozidlom. Hlásenie nepotvrdzuje odcudzenie tohto vozidla.", unverified: "Identita tohto hlásenia nebola overená. Overte EČV a VIN v článku." }[match];
            return <div key={report.url} className="mt-2 rounded-lg bg-amber-50 p-3"><a href={report.url} target="_blank" rel="noreferrer" className="font-semibold text-amber-900 underline">{report.title}</a><p className="mt-1 text-amber-900" role={match === "conflict" ? "alert" : undefined}>{label}</p></div>;
          })}
          {Object.keys(source.facts).length > 0 && <details className="mt-2"><summary className="cursor-pointer font-medium text-zinc-700">Všetky údaje tohto zdroja</summary><dl className="mt-2 divide-y divide-zinc-100">{(Object.entries(source.facts) as [VehicleField, VehicleFact][]).map(([field, fact]) => <div key={field} className="flex justify-between gap-3 py-1.5"><dt className="text-zinc-500">{vehicleFieldLabels[field]}{fact.quality === "partial" ? " · návrh" : ""}</dt><dd className="break-words text-right font-medium">{fact.value}{fact.quality === "decoded" && <span className="block font-normal text-zinc-500">Dekódované z VIN</span>}</dd></div>)}</dl></details>}
        </div>)}</div>
        <p className="mt-3 text-xs text-zinc-600">Diaľničná známka nebola automaticky overená. <a href="https://eznamka.sk/selfcare/modification/select/select-vignettes/?operation=Check" target="_blank" rel="noreferrer" className="underline">Otvoriť overenie známky</a></p>
      </section>
    </div>
    <footer className="shrink-0 border-t border-zinc-200 bg-white p-4 sm:px-5">
      {props.proposal ? <>
        {partial && <label className="mb-2 flex items-start gap-2 text-xs text-zinc-700"><input type="checkbox" checked={props.includePartial} onChange={event => props.onIncludePartial(event.target.checked)} className="mt-0.5" />Zahrnúť aj návrhy z neúplného VIN dekódovania; overím ich podľa dokladov.</label>}
        <p className="text-xs text-zinc-600">Existujúce hodnoty zostanú zachované. {Object.keys(props.patch).length ? `Doplní sa: ${Object.keys(props.patch).map(field => vehicleFieldLabels[field as VehicleField]).join(", ")}.` : "Uloží sa iba prehľad získaných údajov."}</p>
        <button type="button" disabled={Boolean(props.conflict) || props.disabled} onClick={() => closeDialog(props.onAccept)} className="mt-3 w-full rounded-lg bg-yellow-300 px-4 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-yellow-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yellow-500 disabled:opacity-40 sm:w-auto">Doplniť prázdne polia a prijať overenie</button>
      </> : <button type="button" onClick={() => closeDialog()} className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold hover:bg-zinc-50">Zavrieť detail</button>}
    </footer>
  </dialog>;
}
