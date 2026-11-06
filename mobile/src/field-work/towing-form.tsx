import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { Clock } from "lucide-react-native";
import { randomUUID } from "expo-crypto";
import type { TowingFields, TowingParty, TowingPaymentIntent } from "../../../src/domain/towing/types";
import type { MobileFieldTowingOptions } from "../../../src/lib/mobile-api";
import { ChoiceField, Field, FieldAction, FormSection, FormText, PickerRow, SelectRow } from "../design/form";
import { Button } from "../ui";
import { Chip } from "./parts";

export const towingServiceLabels = { tow: "Odťah", repair: "Oprava na mieste", transport: "Preprava", storage: "Uloženie", relocation: "Preťah" } as const;
export const towingPaymentLabels: Record<TowingPaymentIntent, string> = { partner_invoice: "Faktúra partnerovi", deferred_invoice: "Faktúra so splatnosťou", card_terminal: "Karta cez terminál", cash_terminal: "Hotovosť cez terminál", cash_other: "Iná hotovosť (bez faktúry)" };
const zone = "Europe/Bratislava";
const clock = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export function towingDateInput(value?: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  const p = Object.fromEntries(clock.formatToParts(new Date(value)).map(item => [item.type, item.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
export function towingDate(value: string): string | undefined {
  if (!value.trim()) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error("Dátum zadajte ako RRRR-MM-DD HH:mm (Bratislava).");
  const [, y, m, d, h, min] = match.map(Number), wall = Date.UTC(y, m - 1, d, h, min);
  let instant = wall;
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(clock.formatToParts(new Date(instant)).map(item => [item.type, item.value]));
    instant += wall - Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  }
  const iso = new Date(instant).toISOString();
  if (towingDateInput(iso) !== value.trim()) throw new Error("Dátum alebo čas v Bratislave nie je platný.");
  return iso;
}

/** Inline searchable selection uses the form's existing rows, with no covering modal. */
export function TowingPicker({ label, value, items, onChange, disabled, empty = "Zatiaľ neurčené" }: {
  label: string; value?: string; items: readonly { id: string; name: string; detail?: string }[];
  onChange: (id: string | undefined) => void; disabled?: boolean; empty?: string;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState("");
  const normalized = query.trim().toLocaleLowerCase("sk");
  const matches = useMemo(() => items.filter(item => `${item.name} ${item.detail ?? ""}`.toLocaleLowerCase("sk").includes(normalized)), [items, normalized]);
  const current = items.find(item => item.id === value);
  return <>
    <PickerRow label={label} value={current?.name ?? (value ? "Uložená položka mimo aktuálnej ponuky" : empty)} disabled={disabled} onPress={() => { setQuery(""); setOpen(!open); }} />
    {open && !disabled ? <>
      <Field label={`Hľadať: ${label}`} value={query} onChangeText={setQuery} autoCapitalize="none" autoCorrect={false} placeholder="Názov, EČV alebo pobočka" />
      <SelectRow label={empty} selected={!value} onPress={() => { onChange(undefined); setOpen(false); }} />
      {matches.slice(0, 20).map(item => <SelectRow key={item.id} label={item.name} detail={item.detail} selected={item.id === value} onPress={() => { onChange(item.id); setOpen(false); }} />)}
      {!items.length ? <FormText tone="muted">Zoznam zatiaľ neobsahuje žiadnu položku. Údaje doplní kancelária.</FormText> : !matches.length ? <FormText tone="muted">Nenašla sa zodpovedajúca položka.</FormText> : matches.length > 20 ? <FormText tone="muted">Zobrazených prvých 20 z {matches.length}. Spresnite hľadanie.</FormText> : null}
    </> : null}
  </>;
}

export function TowingTimeField({ label, value, disabled, onChange, onValidityChange }: { label: string; value?: string; disabled?: boolean; onChange: (value: string | undefined) => void; onValidityChange?: (valid: boolean) => void }) {
  const [text, setText] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const visible = text ?? towingDateInput(value);
  return <Field label={label} value={visible} editable={!disabled} placeholder="RRRR-MM-DD HH:mm" hint={error ?? "Časové pásmo Bratislava"}
    onChangeText={next => { setText(next); try { onChange(towingDate(next)); setError(null); onValidityChange?.(true); } catch (cause) { setError((cause as Error).message); onValidityChange?.(false); } }} onBlur={() => {
      if (text === null) return;
      try { onChange(towingDate(visible)); setText(null); setError(null); onValidityChange?.(true); } catch (cause) { setError((cause as Error).message); onValidityChange?.(false); }
    }} action={<FieldAction icon={Clock} label="Teraz" disabled={disabled} onPress={() => { onChange(new Date().toISOString()); setText(null); setError(null); onValidityChange?.(true); }} />} />;
}

function PartyFields({ label, value, onChange, disabled }: { label: string; value?: TowingParty; onChange: (party: TowingParty) => void; disabled?: boolean }) {
  return <FormSection title={label}>{([["name", "Meno / firma"], ["phone", "Telefón"], ["email", "E-mail"], ["address", "Adresa"], ["companyId", "IČO"]] as const).map(([key, title]) =>
    <Field key={key} label={title} value={value?.[key] ?? ""} maxLength={2000} editable={!disabled} autoCapitalize={key === "email" ? "none" : "sentences"}
      keyboardType={key === "phone" ? "phone-pad" : key === "email" ? "email-address" : "default"} onChangeText={next => onChange({ name: value?.name ?? "", ...value, [key]: next })} />)}</FormSection>;
}

/** Shared operational form for own creation, office creation and own permitted edits. */
export function TowingFieldsForm({ value, onChange, options, disabled, complete = true, actualTimes = false, onValidityChange }: {
  value: TowingFields; onChange: (value: TowingFields) => void; options?: MobileFieldTowingOptions; disabled?: boolean; complete?: boolean; actualTimes?: boolean; onValidityChange?: (valid: boolean) => void;
}) {
  const [invalidDates, setInvalidDates] = useState<readonly string[]>([]);
  useEffect(() => { onValidityChange?.(invalidDates.filter(key => actualTimes || key === "plannedAt").length === 0); }, [invalidDates, actualTimes, onValidityChange]);
  const dateValidity = (key: string, valid: boolean) => setInvalidDates(current => valid ? current.includes(key) ? current.filter(item => item !== key) : current : current.includes(key) ? current : [...current, key]);
  const set = <K extends keyof TowingFields>(key: K, next: TowingFields[K]) => onChange({ ...value, [key]: next });
  return <>
    <FormSection title="Objednávateľ a služba">
      <ChoiceField label="Druh objednávateľa">{([['assistance', 'Asistenčná služba'], ['selfpayer', 'Samoplatca']] as const).map(([id, name]) => <Chip key={id} onCard label={name} selected={value.requesterType === id} disabled={disabled} onPress={() => set("requesterType", id)} />)}</ChoiceField>
      <TowingPicker label={value.requesterType === "assistance" ? "Asistenčná služba" : "Partner / objednávateľ"} value={value.assistancePartnerId} items={options?.partners ?? []} disabled={disabled} onChange={id => {
        const selected = options?.partners?.find(item => item.id === id);
        onChange({ ...value, assistancePartnerId: id, requesterId: id, assistancePartnerName: selected?.name, requester: { ...value.requester, name: selected?.name ?? value.requester?.name ?? "" } });
      }} />
      <Field label="Názov objednávateľa" value={value.requester?.name ?? ""} editable={!disabled} onChangeText={name => set("requester", { ...value.requester, name })} />
      <Field label="Číslo prípadu asistenčky" value={value.assistanceReference ?? ""} editable={!disabled} maxLength={300} onChangeText={next => set("assistanceReference", next)} />
      <ChoiceField label="Druh služby">{Object.entries(towingServiceLabels).map(([id, name]) => <Chip key={id} onCard label={name} selected={value.serviceType === id} disabled={disabled} onPress={() => set("serviceType", id as TowingFields["serviceType"])} />)}</ChoiceField>
    </FormSection>
    <FormSection title="Kontakt a trasa">
      <Field label="Kontakt / telefón klienta" value={value.contact ?? ""} keyboardType="phone-pad" editable={!disabled} onChangeText={next => set("contact", next)} />
      <Field label="Dôvod chýbajúceho kontaktu" value={value.noContactReason ?? ""} editable={!disabled} onChangeText={next => set("noContactReason", next)} />
      <Field label="Miesto nakládky" value={value.pickup} editable={!disabled} maxLength={4000} onChangeText={next => set("pickup", next)} />
      <Field label="Miesto vykládky / cieľ" value={value.destination ?? ""} editable={!disabled} maxLength={4000} onChangeText={next => set("destination", next)} />
    </FormSection>
    <FormSection title="Predmet odťahu">
      <ChoiceField label="Predmet">{([['vehicle', 'Vozidlo'], ['machine', 'Stroj'], ['material', 'Materiál']] as const).map(([id, name]) => <Chip key={id} onCard label={name} selected={value.subjectType === id} disabled={disabled} onPress={() => set("subjectType", id)} />)}</ChoiceField>
      <Field label="Značka / model / opis predmetu" value={value.subjectDescription} editable={!disabled} maxLength={4000} onChangeText={next => set("subjectDescription", next)} />
      {value.subjectType === "vehicle" ? <><Field label="EČV" value={value.plate ?? ""} autoCapitalize="characters" editable={!disabled} onChangeText={next => set("plate", next.toUpperCase())} />
        <Field label="VIN" value={value.vin ?? ""} autoCapitalize="characters" editable={!disabled} onChangeText={next => set("vin", next.toUpperCase())} /></> : null}
      <Field label="Stav tachometra (km)" value={value.odometer ?? ""} keyboardType="decimal-pad" editable={!disabled} onChangeText={next => set("odometer", next.replace(",", "."))} />
    </FormSection>
    <FormSection title="Technika, pobočka a termín">
      <TowingPicker label="Pobočka" value={value.branchId} items={options?.branches ?? []} disabled={disabled} onChange={next => set("branchId", next)} />
      <TowingPicker label="Odťahová technika" value={value.fleetAssetId} items={(options?.fleet ?? []).map(asset => ({ id: asset.id, name: asset.name, detail: [asset.plate, asset.branchId ? options?.branches?.find(item => item.id === asset.branchId)?.name : null, asset.status].filter(Boolean).join(" · ") }))} disabled={disabled} onChange={next => set("fleetAssetId", next)} />
      {value.serviceType === "storage" ? <TowingPicker label="Parkovisko uloženia" value={value.parkingId} items={options?.parking ?? []} disabled={disabled} onChange={id => {
        const site = options?.parking.find(item => item.id === id); onChange({ ...value, parkingId: id, destination: site?.address ?? value.destination });
      }} /> : null}
      <TowingTimeField label="Plánovaný termín" value={value.plannedAt} disabled={disabled} onValidityChange={valid => dateValidity("plannedAt", valid)} onChange={next => set("plannedAt", next)} />
      {actualTimes ? <><TowingTimeField label="Skutočný začiatok" value={value.startedAt} disabled={disabled} onValidityChange={valid => dateValidity("startedAt", valid)} onChange={next => set("startedAt", next)} />
        <TowingTimeField label="Skutočný koniec" value={value.finishedAt} disabled={disabled} onValidityChange={valid => dateValidity("finishedAt", valid)} onChange={next => set("finishedAt", next)} /></> : null}
    </FormSection>
    {complete ? <>
      <PartyFields label="Majiteľ vozidla" value={value.owner} onChange={next => set("owner", next)} disabled={disabled} />
      <FormSection title="Dohodnutá úhrada" footer="Výber formy úhrady nie je potvrdenie príjmu. Prijatú sumu zapíšete po vytvorení odťahu.">
        <ChoiceField label="Forma úhrady">{Object.entries(towingPaymentLabels).map(([id, name]) => <Chip key={id} onCard label={name} selected={value.paymentIntent === id} disabled={disabled} onPress={() => set("paymentIntent", id as TowingPaymentIntent)} />)}</ChoiceField>
      </FormSection>
      {(value.realizedItems ?? []).map((item, index) => <FormSection key={item.id} title={`Úkon ${index + 1} · ${towingServiceLabels[item.kind]}`}>
        <Field label="Opis úkonu" value={item.description} editable={!disabled} onChangeText={next => set("realizedItems", value.realizedItems?.map(current => current.id === item.id ? { ...current, description: next } : current))} />
        <Field label="Množstvo" value={item.quantity} keyboardType="decimal-pad" editable={!disabled} onChangeText={next => set("realizedItems", value.realizedItems?.map(current => current.id === item.id ? { ...current, quantity: next.replace(",", ".") } : current))} />
        <Field label="Jednotka" value={item.unit} editable={!disabled} onChangeText={next => set("realizedItems", value.realizedItems?.map(current => current.id === item.id ? { ...current, unit: next } : current))} />
        {item.kind === "storage" ? <TowingPicker label="Parkovisko uloženia" value={item.parkingId} items={options?.parking ?? []} disabled={disabled} onChange={next => {
          const parking = options?.parking.find(site => site.id === next);
          set("realizedItems", value.realizedItems?.map(current => current.id === item.id ? { ...current, parkingId: next, destination: parking?.address } : current));
        }} /> : <Field label="Cieľ úkonu" value={item.destination ?? ""} editable={!disabled} onChangeText={next => set("realizedItems", value.realizedItems?.map(current => current.id === item.id ? { ...current, destination: next } : current))} />}
        <View><Button secondary label="Odstrániť úkon" disabled={disabled} onPress={() => set("realizedItems", value.realizedItems?.filter(current => current.id !== item.id))} /></View>
      </FormSection>)}
      <FormSection title="Vykonané úkony"><ChoiceField label="Pridať úkon">{Object.entries(towingServiceLabels).map(([id, name]) => <Chip key={id} onCard label={`+ ${name}`} selected={false} disabled={disabled || (value.realizedItems?.length ?? 0) >= 50} onPress={() => set("realizedItems", [...value.realizedItems ?? [], { id: randomUUID(), kind: id as TowingFields["serviceType"], description: name, quantity: "1", unit: "úkon", destination: value.destination }])} />)}</ChoiceField></FormSection>
      <FormSection title="Poznámky a podklady">
        <Field label="Pokyny pre vodiča" value={value.dispatchInstructions ?? ""} editable={!disabled} multiline onChangeText={next => set("dispatchInstructions", next)} />
        <Field label="Poznámka vodiča" value={value.driverNotes ?? ""} editable={!disabled} multiline onChangeText={next => set("driverNotes", next)} />
        {actualTimes ? <><Field label="Komu bolo vozidlo odovzdané" value={value.handoverRecipientName ?? ""} editable={!disabled} onChangeText={next => set("handoverRecipientName", next)} />
          <TowingTimeField label="Čas odovzdania" value={value.handedOverAt} disabled={disabled} onValidityChange={valid => dateValidity("handedOverAt", valid)} onChange={next => set("handedOverAt", next)} />
          <Field label="Dôvod výnimky pri odovzdaní" value={value.handoverException ?? ""} editable={!disabled} multiline onChangeText={next => set("handoverException", next)} />
          <Field label="Prečo chýbajú fotografie" value={value.photoException ?? ""} editable={!disabled} multiline onChangeText={next => set("photoException", next)} />
          <FormText tone="muted">Pri spätnej evidencii bez fotografií vysvetlite skutočný dôvod. Kancelárske fotografie a doklady sa dopĺňajú vo webovej kancelárii po vytvorení zákazky.</FormText></> : <FormText tone="muted">Fotografie a skutočne prijaté platby doplníte do vytvoreného odťahu.</FormText>}
      </FormSection>
    </> : null}
  </>;
}
