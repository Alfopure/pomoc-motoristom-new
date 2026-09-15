"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight, LoaderCircle, Search } from "lucide-react";
import { TextField } from "./case-form-fields";
import { normalizeLicensePlateInput, normalizeVinInput } from "./case-form-shared";
import { emptyVehicleFieldPatch, isSlovakPlate, isVin, lookupIdentityConflict, normalizeVehicleIdentifier, preferredVehicleFacts, type VehicleFieldChoices, type VehicleFormValues, type VehicleLookupResponse, type VehicleLookupSnapshot } from "@/lib/vehicle-lookup";
import { requestVehicleLookup } from "@/lib/vehicle-lookup-client";
import { VehicleLookupDetails, vehicleLookupDate } from "./VehicleLookupDetails";

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
export function VehicleLookupControl(props: Props) {
  const [proposal, setProposal] = useState<VehicleLookupResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [includePartial, setIncludePartial] = useState(false);
  const [choices, setChoices] = useState<VehicleFieldChoices>({});
  const [waiting, setWaiting] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const control = useRef<HTMLDivElement | null>(null);
  const request = useRef<AbortController | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const identity = `${props.contextKey}:${normalizeVehicleIdentifier(props.plate)}:${normalizeVehicleIdentifier(props.vin)}`;
  const [stateIdentity, setStateIdentity] = useState(identity);
  const currentIdentity = useRef(identity);
  const currentProps = useRef(props);
  useLayoutEffect(() => { currentIdentity.current = identity; currentProps.current = props; }, [identity, props]);
  // Reset only state tied to the changed vehicle; keep the input DOM and focus.
  if (stateIdentity !== identity) {
    setStateIdentity(identity);
    setProposal(null); setLoading(false); setError(null); setIncludePartial(false); setChoices({}); setWaiting(0); setExpanded(false);
  }
  useEffect(() => () => { request.current?.abort(); request.current = null; }, [identity]);

  async function lookup(kind: "plate" | "vin") {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const requestedIdentity = identity;
    setLoading(true); setError(null); setProposal(null); setExpanded(false); setIncludePartial(false); setChoices({}); setWaiting(0);
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const result = await requestVehicleLookup({ kind, value: kind === "plate" ? props.plate : props.vin, country: "SK", knownIdentity: { plate: props.plate, vin: props.vin, country: "SK" } }, controller.signal, (seconds) => {
        if (currentIdentity.current === requestedIdentity && request.current === controller) setWaiting(seconds);
      });
      if (currentIdentity.current !== requestedIdentity || controller.signal.aborted) return;
      setProposal(result);
      // Workspaces retain hidden editors. Keep their completed lookups available
      // without opening a modal over the screen the dispatcher moved to.
      const origin = control.current;
      setExpanded(Boolean(origin?.getClientRects().length && !origin.closest('[inert], [aria-hidden="true"], [hidden]') && getComputedStyle(origin).visibility !== "hidden"));
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
  const patch = result ? emptyVehicleFieldPatch(result, { ...props.values, plate: props.plate, vin: props.vin }, includePartial, choices) : {};

  return (
    <div ref={control} className="col-span-full min-w-0" data-testid="vehicle-lookup">
      <div className="grid gap-3 sm:grid-cols-2">
        {(["plate", "vin"] as const).map((kind) => (
          <div key={kind} className="flex min-w-0 items-start gap-1.5">
            <div className="min-w-0 flex-1"><TextField label={kind === "plate" ? "EČV" : "VIN"} value={kind === "plate" ? props.plate : props.vin} onChange={(value) => changeIdentity(kind, value)} onBlur={kind === "plate" ? props.onPlateBlur : undefined} required={kind === "plate" && props.required} error={kind === "plate" ? props.plateError : props.vinError} disabled={props.disabled} /></div>
            <button type="button" title={`Dohľadať podľa ${kind === "plate" ? "EČV" : "VIN"} · Slovensko`} aria-label={`Dohľadať podľa ${kind === "plate" ? "EČV" : "VIN"}`} disabled={props.disabled || loading || !(kind === "plate" ? isSlovakPlate(normalizeVehicleIdentifier(props.plate)) : isVin(normalizeVehicleIdentifier(props.vin)))} onClick={event => { opener.current = event.currentTarget; void lookup(kind); }} className="mt-6 flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-yellow-300 bg-yellow-50 text-zinc-800 hover:bg-yellow-100 disabled:opacity-40">
              {loading ? <LoaderCircle size={17} className="animate-spin" /> : <Search size={17} />}
            </button>
          </div>
        ))}
      </div>
      {loading && <p role="status" className="mt-2 text-xs text-zinc-600">{waiting ? `Prebieha iné dohľadávanie. Automaticky skúsim znova o ${waiting} s…` : "Overujem slovenské vozidlo a PZP k dnešnému dňu…"} Formulár môžete ďalej vypĺňať.</p>}
      {error && <p role="alert" className="mt-2 rounded-md bg-amber-50 p-2 text-xs text-amber-900">{error}</p>}
      {snapshot && <div className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50">
        <button type="button" onClick={event => { opener.current = event.currentTarget; setExpanded(true); }} aria-haspopup="dialog" className="flex w-full items-center justify-between gap-3 rounded-lg p-3 text-left hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-yellow-500">
          <span className="min-w-0"><span className="block text-sm font-semibold">{proposal ? "Dohľadané údaje · návrh" : "Uložené overenie vozidla"}</span>
            <span className="mt-0.5 block text-xs text-zinc-600">{[facts.make?.value, facts.model?.value].filter(Boolean).join(" ") || "Zobraziť detail vozidla"} · {vehicleLookupDate(snapshot.result.fetchedAt, true)}</span>
            <span className={`mt-1 block text-xs ${conflict ? "font-medium text-amber-900" : "text-zinc-700"}`}>{conflict ? "Identita nesúhlasí · PZP vozidla nepotvrdené" : <>PZP: {facts.insuranceStatus?.value ?? "nepotvrdené"}{facts.insurer && ` · ${facts.insurer.value}`} · k {vehicleLookupDate(snapshot.result.query.checkedForDate)}</>}</span>
          </span><ChevronRight size={18} className="shrink-0 text-zinc-500" />
        </button>
        {expanded && <VehicleLookupDetails returnFocus={opener} snapshot={snapshot} proposal={Boolean(proposal)} cached={Boolean(proposal?.cached)} identity={{ plate: props.plate, vin: props.vin }} conflict={conflict} includePartial={includePartial} choices={choices} patch={patch} disabled={Boolean(props.disabled || loading)} onIncludePartial={setIncludePartial} onChoice={(field, source) => setChoices(previous => ({ ...previous, [field]: source || undefined }))} onClose={() => setExpanded(false)} onAccept={() => {
          const latest = currentProps.current;
          if (lookupIdentityConflict(snapshot.result, { plate: latest.plate, vin: latest.vin })) return;
          const acceptedPatch = emptyVehicleFieldPatch(snapshot.result, { ...latest.values, plate: latest.plate, vin: latest.vin }, includePartial, choices);
          latest.onApply(acceptedPatch, snapshot); setProposal(null); setExpanded(false);
        }} />}
      </div>}
    </div>
  );
}
