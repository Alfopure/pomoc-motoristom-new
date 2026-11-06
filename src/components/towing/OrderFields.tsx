"use client";

import type { TowingFields, TowingParty, TowingWorkspace } from "@/domain/towing/types";
import { RealizationFields } from "./RealizationFields";
import { Field, Panel, Select, TextArea } from "./primitives";
import { isoDateInput, localDateInput, serviceLabels } from "./model";
import styles from "./towing.module.css";

export function OrderFields({ fields, onChange, workspace, driver = false, allowOriginSelection = false, fullOperational = false }: { fields: TowingFields; onChange: (fields: TowingFields) => void; workspace: TowingWorkspace; driver?: boolean; allowOriginSelection?: boolean; fullOperational?: boolean }) {
  const operational = !driver || fullOperational;
  const set = <K extends keyof TowingFields>(key: K, value: TowingFields[K]) => onChange({ ...fields, [key]: value });
  return <>
    {driver && !fullOperational && <Panel title="Vozidlo a majiteľ"><div className={styles.grid3}>
      <Field label="Značka / model" value={fields.subjectDescription} onChange={event => set("subjectDescription", event.target.value)} />
      <Field label="EČV (ak má)" value={fields.plate ?? ""} onChange={event => set("plate", event.target.value.toUpperCase())} />
      <Field label="VIN" value={fields.vin ?? ""} onChange={event => set("vin", event.target.value.toUpperCase())} />
      {([['name', 'Meno / firma'], ['phone', 'Telefón'], ['address', 'Adresa'], ['companyId', 'IČO']] as const).map(([key, label]) => <Field key={key} label={`Majiteľ: ${label}`} type={key === "phone" ? "tel" : "text"} value={fields.owner?.[key] ?? ""} onChange={event => set("owner", { ...fields.owner, name: fields.owner?.name ?? "", [key]: event.target.value })} />)}
    </div></Panel>}
    {operational && <Panel title="Výkon a predmet zákazky"><div className={styles.grid3}>
      {!driver && allowOriginSelection && <Select label="Spôsob vykonania" value={fields.executionOrigin ?? "local"} onChange={event => set("executionOrigin", event.target.value as TowingFields["executionOrigin"])}><option value="local">Lokálny výkon · pridelenie nášmu vodičovi</option><option value="awp_record_only">AWP · iba evidencia externého výkonu</option></Select>}
      {!driver && (allowOriginSelection || fields.executionOrigin === "awp_record_only") && <Field label="Externá referencia výkonu AWP" value={fields.externalReference ?? ""} onChange={event => set("externalReference", event.target.value)} />}
      <Select label="Druh výkonu" value={fields.serviceType} onChange={event => set("serviceType", event.target.value as TowingFields["serviceType"])}>{Object.entries(serviceLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select>
      <Select label="Predmet" value={fields.subjectType} onChange={event => set("subjectType", event.target.value as TowingFields["subjectType"])}><option value="vehicle">Vozidlo</option><option value="machine">Stroj</option><option value="material">Materiál</option></Select>
      <Field label={fields.subjectType === "vehicle" ? "Značka / model" : "Opis predmetu"} value={fields.subjectDescription} onChange={event => set("subjectDescription", event.target.value)} />
      {fields.subjectType !== "material" && <><Field label="EČV (ak má)" value={fields.plate ?? ""} onChange={event => set("plate", event.target.value.toUpperCase())} /><Field label={fields.subjectType === "vehicle" ? "VIN" : "VIN / identifikátor (ak má)"} value={fields.vin ?? ""} onChange={event => set("vin", event.target.value.toUpperCase())} /></>}
      <Select label="Typ objednávateľa" value={fields.requesterType ?? ""} onChange={event => set("requesterType", event.target.value as TowingFields["requesterType"] || null)}><option value="">Zatiaľ neurčený</option><option value="assistance">Asistencia</option><option value="selfpayer">Samoplatca / priamy objednávateľ</option></Select>
      <Field label="Referencia asistencie" value={fields.assistanceReference ?? ""} onChange={event => set("assistanceReference", event.target.value)} />
      <Select label="Asistenčná služba / partner" value={fields.assistancePartnerId ?? ""} onChange={event => { const partner = workspace.partners?.find(item => item.id === event.target.value); onChange({ ...fields, assistancePartnerId: partner?.id, assistancePartnerName: partner?.name, requesterId: partner?.id ?? null }); }}><option value="">Bez vybraného partnera</option>{workspace.partners?.map(partner => <option key={partner.id} value={partner.id}>{partner.name}</option>)}</Select>
    </div></Panel>}
    <Panel title="Miesta a termíny"><div className={styles.grid3}>
      {operational && <Field label="Miesto nakládky" value={fields.pickup} onChange={event => set("pickup", event.target.value)} />}
      <Field label="Miesto vykládky / cieľ" value={fields.destination ?? ""} onChange={event => set("destination", event.target.value)} />
      {operational && fields.serviceType === "storage" && <Select label="Parkovisko uloženia" value={fields.parkingId ?? ""} onChange={event => { const parking = workspace.parking?.find(item => item.id === event.target.value); onChange({ ...fields, parkingId: parking?.id, parkingName: parking?.name, parkingAddress: parking?.address, destination: parking?.address ?? fields.destination }); }}><option value="">Vyberte konkrétne parkovisko</option>{workspace.parking?.map(site => <option key={site.id} value={site.id} disabled={!site.active}>{site.name} · {site.address}{site.active ? "" : " · neaktívne"}</option>)}</Select>}
      {operational && <><Select label="Pobočka" value={fields.branchId ?? ""} onChange={event => set("branchId", event.target.value || undefined)}><option value="">Vyberte pobočku</option>{workspace.branches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</Select><Select label="Technika" value={fields.fleetAssetId ?? ""} onChange={event => set("fleetAssetId", event.target.value || undefined)}><option value="">Zatiaľ neurčená</option>{workspace.fleet.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</Select><Field type="datetime-local" label="Plánovaný termín" value={localDateInput(fields.plannedAt)} onChange={event => set("plannedAt", isoDateInput(event.target.value))} /></>}
      <Field type="datetime-local" label={`Skutočný začiatok${fields.startSource === "assignment" ? " · potvrďte skutočný čas" : ""}`} value={fields.startSource === "assignment" ? "" : localDateInput(fields.startedAt)} onChange={event => onChange({ ...fields, startedAt: isoDateInput(event.target.value), startSource: "manual" })} />
      <Field type="datetime-local" label="Skutočný koniec" value={localDateInput(fields.finishedAt)} onChange={event => set("finishedAt", isoDateInput(event.target.value))} />
      <Field label="Realizované množstvo" inputMode="decimal" placeholder="napr. 25 km" value={fields.performedQuantity ?? ""} onChange={event => set("performedQuantity", event.target.value)} />
    </div></Panel>
    {operational && <Panel title="Kontakty a odberateľ"><div className={styles.grid}><Field label="Operatívny kontakt / telefón" value={fields.contact ?? ""} onChange={event => set("contact", event.target.value)} /><Field label="Dôvod chýbajúceho kontaktu" value={fields.noContactReason ?? ""} onChange={event => set("noContactReason", event.target.value)} /></div>
      {([['requester', 'Objednávateľ'], ['owner', 'Majiteľ'], ['customer', 'Fakturačný odberateľ'], ['recipient', 'Príjemca']] as const).filter(([key]) => !driver || key !== "customer").map(([key, label]) => <details className={styles.details} key={key} open={key === "requester" || undefined}><summary>{label}{fields[key]?.name ? ` · ${fields[key]?.name}` : ""}</summary><PartyFields label={label} party={fields[key] ?? { name: "" }} onChange={party => set(key, party)} includeTax={!driver} /></details>)}
    </Panel>}
    <RealizationFields fields={fields} onChange={onChange} workspace={workspace} />
    <Panel title="Realizácia a poznámky"><TextArea label="Poznámka vodiča" value={fields.driverNotes ?? ""} onChange={event => set("driverNotes", event.target.value)} /></Panel>
  </>;
}

function PartyFields({ label, party, onChange, includeTax = true }: { label: string; party: TowingParty; onChange: (party: TowingParty) => void; includeTax?: boolean }) {
  return <div className={styles.grid}>
    {([['name', 'Meno / firma'], ['phone', 'Telefón'], ['email', 'E-mail'], ['address', 'Adresa'], ['companyId', 'IČO'], ['taxId', 'DIČ / IČ DPH']] as const).filter(([key]) => includeTax || key !== "taxId").map(([key, text]) => <Field key={key} label={`${label}: ${text}`} type={key === "email" ? "email" : key === "phone" ? "tel" : "text"} value={party[key] ?? ""} onChange={event => onChange({ ...party, [key]: event.target.value })} />)}
  </div>;
}
