import { CASH_CATEGORIES, allocateCash, cashCategoryLabels } from "../../../src/domain/towing/cash-categories";
import { useEffect, useRef, useState } from "react";
import { Alert, View } from "react-native";
import { randomUUID } from "expo-crypto";
import type { MobileCashCategory, MobileCashBreakdown, MobileFieldCash, MobileTowingDriverFields, MobileTowingFields, MobileTowingOrder, MobileTowingPaymentIntent, MobileTowingRealizedItem } from "../../../src/lib/mobile-api";
import { InfoRow } from "../design/detail";
import { ChoiceField, Field, FormSection, FormText, formLayout } from "../design/form";
import { Button, ErrorNotice } from "../ui";
import { Chip } from "./parts";
import { canProposeCash, cashAmountCents, cashEuro } from "./cash-model";

type ReceiptInput = { amountCents: number; method: "cash" | "card"; cashCategory?: MobileCashCategory };
export type CashPanelProps = {
  order?: MobileTowingOrder; cash: MobileFieldCash | null; busy: boolean; onDirtyChange?: (dirty: boolean) => void;
  onReceive: (input: ReceiptInput) => Promise<boolean>; onPropose: (amountCents: number, cashBreakdown?: MobileCashBreakdown) => Promise<boolean>;
};
const methodLabels = { cash: "Hotovosť", card: "Karta", bank: "Bankový prevod", other: "Iná úhrada" };
const handoverLabels = { pending: "Čaká na prevzatie kanceláriou", accepted: "Prijaté kanceláriou", rejected: "Odmietnuté", cancelled: "Zrušené" };

/** The caller owns command/receipt IDs and replay. No intent, draft or button tap updates balances. */
export function CashPanel({ order, cash, busy, onReceive, onPropose, onDirtyChange }: CashPanelProps) {
  const [amount, setAmount] = useState("");
  useEffect(() => { onDirtyChange?.(amount.trim().length > 0); }, [amount, onDirtyChange]);
  const [method, setMethod] = useState<"cash" | "card">("cash");
  const [category, setCategory] = useState<MobileCashCategory>(order?.fields.paymentIntent === "cash_other" ? "other" : "regular");
  const [handoverCategory, setHandoverCategory] = useState<MobileCashCategory | "all">("all");
  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const inFlight = useRef(false);
  const cents = cashAmountCents(amount);
  const blocked = busy || submitting || confirming;
  const available = cash?.account ? cash.account.balanceCents - cash.account.reservedCents : null;
  const categories = cash?.account?.categories;
  const breakdown = cents !== null && categories ? handoverCategory === "all" ? allocateCash(cents, categories)
    : cents <= categories[handoverCategory].balanceCents - categories[handoverCategory].reservedCents ? { regular: 0, other: 0, unclassified: 0, [handoverCategory]: cents } : null : undefined;
  const splitText = breakdown ? CASH_CATEGORIES.filter(key => breakdown[key] > 0).map(key => `${cashCategoryLabels[key]}: ${cashEuro(breakdown[key])}`).join(" · ") : "";
  const permitted = order ? cents !== null : canProposeCash(cents, cash?.account ?? null) && (!categories || Boolean(breakdown));
  function confirm() {
    if (blocked || lock.current || cents === null || !permitted) return;
    lock.current = true; setConfirming(true); setError(null);
    const value = cents;
    const inputMethod = method;
    const inputCategory = category;
    const inputBreakdown = breakdown;
    const release = () => { if (!inFlight.current) { lock.current = false; setConfirming(false); } };
    const send = async () => {
      inFlight.current = true; setSubmitting(true); setConfirming(false);
      try {
        const confirmed = order ? await onReceive({ amountCents: value, method: inputMethod, ...(inputMethod === "cash" ? { cashCategory: inputCategory } : {}) }) : await onPropose(value, inputBreakdown ?? undefined);
        if (confirmed) setAmount("");
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Výsledok nie je potvrdený. Overte pôvodný zápis."); }
      finally { inFlight.current = false; lock.current = false; setSubmitting(false); setConfirming(false); }
    };
    Alert.alert(order ? "Potvrdiť skutočne prijatú platbu?" : "Navrhnúť odovzdanie hotovosti?",
      order ? `${cashEuro(value)} · ${inputMethod === "cash" ? cashCategoryLabels[inputCategory] : methodLabels[inputMethod]}. Potvrdzujete, že platba bola skutočne prijatá${inputMethod === "card" ? " terminálom" : " v hotovosti"}.` : `${cashEuro(value)}${splitText ? " · " + splitText : ""}. Zostatok sa zmení až po potvrdení prevzatia kanceláriou.`,
      [{ text: "Späť", style: "cancel", onPress: release }, { text: order ? "Platba je prijatá" : "Navrhnúť odovzdanie", onPress: () => { void send(); } }],
      { cancelable: true, onDismiss: release });
  }
  return <>
    {order ? <>
      <FormSection title="Úhrady zákazky" footer="Dohodnutá forma úhrady nie je potvrdená platba. Karta nemení hotovosť vodiča.">
        <InfoRow first label="Autorizované na výber" value={cashEuro(order.authorizedCollectionCents)} />
        {order.payments?.length ? order.payments.map(payment => <InfoRow key={payment.id} label={payment.method === "cash" && payment.cashCategory ? cashCategoryLabels[payment.cashCategory] : methodLabels[payment.method]} value={cashEuro(payment.amountCents)} detail={new Date(payment.createdAt).toLocaleString("sk-SK")} />) : <FormText tone="muted">Zatiaľ bez potvrdených vlastných úhrad.</FormText>}
      </FormSection>
      <FormSection title="Prijatá platba">
        <Field label="Skutočne prijatá suma (€)" value={amount} keyboardType="decimal-pad" editable={!blocked} onChangeText={setAmount} />
        <ChoiceField label="Spôsob prijatej platby">{(["cash", "card"] as const).map(value => <Chip key={value} label={methodLabels[value]} selected={method === value} disabled={blocked} onPress={() => setMethod(value)} />)}</ChoiceField>
        {method === "cash" && <ChoiceField label="Kategória prijatej hotovosti">{(["regular", "other"] as const).map(value => <Chip key={value} label={cashCategoryLabels[value]} selected={category === value} disabled={blocked} onPress={() => setCategory(value)} />)}</ChoiceField>}
      </FormSection>
    </> : <>
      <FormSection title="Moja hotovosť" footer="Iná hotovosť (bez faktúry) zostáva u vás do potvrdeného prevzatia majiteľom alebo poverenou kanceláriou.">
        <InfoRow first label="Potvrdený zostatok" value={cashEuro(cash?.account?.balanceCents)} />
        {categories && CASH_CATEGORIES.filter(key => key !== "unclassified" || categories[key].balanceCents !== 0).map(key => <InfoRow key={key} label={cashCategoryLabels[key]} value={cashEuro(categories[key].balanceCents)} detail={`Rezervované ${cashEuro(categories[key].reservedCents)}`} />)}
        <InfoRow label="Rezervované na odovzdanie" value={cashEuro(cash?.account?.reservedCents)} />
        <InfoRow label="Dostupné na odovzdanie" value={cashEuro(available)} />
        {!cash?.account && <FormText tone="muted">Účet hotovosti zatiaľ nie je dostupný. Návrh sa neodošle.</FormText>}
      </FormSection>
      <FormSection title="Odovzdať hotovosť">
        {categories && <ChoiceField label="Ktorú hotovosť odovzdávate"><Chip label="Spolu" selected={handoverCategory === "all"} disabled={blocked} onPress={() => setHandoverCategory("all")} />{CASH_CATEGORIES.filter(key => key !== "unclassified" || categories[key].balanceCents !== 0).map(key => <Chip key={key} label={cashCategoryLabels[key]} selected={handoverCategory === key} disabled={blocked} onPress={() => setHandoverCategory(key)} />)}</ChoiceField>}
        <Field label="Suma na odovzdanie (€)" value={amount} keyboardType="decimal-pad" editable={!blocked && Boolean(cash?.account)} onChangeText={setAmount} />
        {splitText ? <FormText>{splitText}</FormText> : categories && cents !== null && !breakdown ? <FormText tone="danger">Vo vybranej kategórii nie je dosť dostupnej hotovosti.</FormText> : null}
      </FormSection>
      {cash?.handovers.length ? <FormSection title="Moje odovzdania">{cash.handovers.map(handover => <InfoRow key={handover.id} label={handoverLabels[handover.status]} value={cashEuro(handover.amountCents)} detail={[new Date(handover.createdAt).toLocaleString("sk-SK"), handover.cashBreakdown ? CASH_CATEGORIES.filter(key => handover.cashBreakdown![key] > 0).map(key => `${cashCategoryLabels[key]} ${cashEuro(handover.cashBreakdown![key])}`).join(" · ") : null].filter(Boolean).join(" · ")} />)}</FormSection> : null}
    </>}
    {amount && cents === null ? <FormSection><FormText tone="danger">Zadajte kladnú sumu s najviac dvoma desatinnými miestami.</FormText></FormSection> : null}
    {!order && cents !== null && available !== null && cents > available ? <FormSection><FormText tone="danger">Suma presahuje dostupnú hotovosť.</FormText></FormSection> : null}
    {error ? <View style={formLayout.notices}><ErrorNotice message={error} /></View> : null}
    <View style={formLayout.actions}><Button primary label={submitting ? "Overujem zápis…" : order ? "Potvrdiť prijatú platbu" : "Navrhnúť odovzdanie hotovosti"} disabled={blocked || !permitted} onPress={confirm} /></View>
  </>;
}


const intentLabels: Record<MobileTowingPaymentIntent, string> = {
  partner_invoice: "Faktúra partnerovi", deferred_invoice: "Faktúra so splatnosťou", card_terminal: "Karta cez terminál",
  cash_terminal: "Hotovosť cez terminál", cash_other: "Iná hotovosť (bez faktúry)",
};
const serviceLabels: Record<MobileTowingRealizedItem["kind"], string> = { tow: "Odťah", repair: "Oprava na mieste", transport: "Preprava", storage: "Uloženie", relocation: "Preťah" };

/** Key by order identity in the detail; an uncertain write keeps this draft untouched. */
export function TowWorkFields({ fields, onSave, busy, parking = [], onDirtyChange }: {
  fields: MobileTowingFields; onSave: (fields: MobileTowingDriverFields) => Promise<boolean>; busy: boolean;
  parking?: readonly { id: string; name: string; address: string }[]; onDirtyChange?: (dirty: boolean) => void;
}) {
  const [edits, setEdits] = useState<MobileTowingDriverFields>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const dirty = Object.keys(edits).length > 0;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  const [knownFields, setKnownFields] = useState(fields);
  if (fields !== knownFields) {
    setKnownFields(fields);
    setEdits(current => Object.fromEntries(Object.entries(current).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(fields[key as keyof MobileTowingFields]))));
  }
  const value = { ...fields, ...edits };
  const disabled = busy || saving;
  const items = value.realizedItems ?? [];
  const set = <K extends keyof MobileTowingDriverFields>(key: K, next: MobileTowingDriverFields[K]) => setEdits(current => ({ ...current, [key]: next }));
  const updateItem = (id: string, patch: Partial<MobileTowingRealizedItem>) => set("realizedItems", items.map(item => item.id === id ? { ...item, ...patch } : item));
  const save = async () => {
    if (disabled || savingRef.current || !Object.keys(edits).length) return;
    savingRef.current = true; setSaving(true); setError(null);
    try { if (await onSave(edits)) setEdits({}); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Údaje nie sú potvrdené. Rozpracované zmeny ostali zachované."); }
    finally { savingRef.current = false; setSaving(false); }
  };
  return <>
    <FormSection title="Vozidlo a tachometer">
      <Field label="Značka / model" value={value.subjectDescription ?? ""} editable={!disabled} onChangeText={text => set("subjectDescription", text)} />
      <Field label="EČV" value={value.plate ?? ""} editable={!disabled} autoCapitalize="characters" onChangeText={text => set("plate", text.toUpperCase())} />
      <Field label="VIN" value={value.vin ?? ""} editable={!disabled} autoCapitalize="characters" onChangeText={text => set("vin", text.toUpperCase())} />
      <Field label="Stav tachometra (km)" value={value.odometer ?? ""} editable={!disabled} keyboardType="decimal-pad" onChangeText={text => set("odometer", text.replace(",", "."))} />
    </FormSection>
    <FormSection title="Majiteľ vozidla">{([["name", "Meno / firma"], ["phone", "Telefón"], ["address", "Adresa"], ["companyId", "IČO"]] as const).map(([key, label]) => <Field key={key} label={label} value={value.owner?.[key] ?? ""} editable={!disabled} keyboardType={key === "phone" ? "phone-pad" : "default"} onChangeText={text => set("owner", { name: value.owner?.name ?? "", ...value.owner, [key]: text })} />)}</FormSection>
    <FormSection title="Dohodnutá úhrada" footer="Výber je pokyn. Skutočné prijatie peňazí sa potvrdzuje osobitne.">
      <ChoiceField label="Forma úhrady"><Chip onCard label="Neurčená" selected={!value.paymentIntent} disabled={disabled} onPress={() => set("paymentIntent", null)} />{Object.entries(intentLabels).map(([key, label]) => <Chip onCard key={key} label={label} selected={value.paymentIntent === key} disabled={disabled} onPress={() => set("paymentIntent", key as MobileTowingPaymentIntent)} />)}</ChoiceField>
    </FormSection>
    {items.map((item, index) => <FormSection key={item.id} title={`Úkon ${index + 1} · ${serviceLabels[item.kind]}`} footer="Realizačný podklad bez cien a dane.">
      <ChoiceField label="Druh úkonu">{Object.entries(serviceLabels).map(([key, label]) => <Chip onCard key={key} label={label} selected={item.kind === key} disabled={disabled} onPress={() => updateItem(item.id, { kind: key as MobileTowingRealizedItem["kind"] })} />)}</ChoiceField>
      <Field label="Opis úkonu" value={item.description} editable={!disabled} onChangeText={text => updateItem(item.id, { description: text })} />
      <Field label="Množstvo" value={item.quantity} editable={!disabled} keyboardType="decimal-pad" onChangeText={text => updateItem(item.id, { quantity: text.replace(",", ".") })} />
      <Field label="Jednotka" value={item.unit} editable={!disabled} onChangeText={text => updateItem(item.id, { unit: text })} />
      {["tow", "transport", "relocation"].includes(item.kind) ? <Field label="Cieľ úkonu" value={item.destination ?? ""} editable={!disabled} onChangeText={text => updateItem(item.id, { destination: text })} /> : null}
      {item.kind === "storage" ? <>
        <FormText>{item.parkingName ? `${item.parkingName} · ${item.parkingAddress ?? item.destination ?? ""}` : "Vyberte konkrétne parkovisko; ak nie je v ponuke, doplní ho kancelária."}</FormText>
        {parking.length ? <ChoiceField label="Parkovisko">{parking.map(site => <Chip onCard key={site.id} label={`${site.name} · ${site.address}`} selected={item.parkingId === site.id} disabled={disabled} onPress={() => updateItem(item.id, { parkingId: site.id, destination: site.address })} />)}</ChoiceField> : null}
      </> : null}
      <View style={formLayout.notices}><Button secondary label={`Odstrániť úkon ${index + 1}`} disabled={disabled} onPress={() => set("realizedItems", items.filter(current => current.id !== item.id))} /></View>
    </FormSection>)}
    <FormSection title="Pridať realizovaný úkon"><ChoiceField label="Vykonaná služba">{Object.entries(serviceLabels).map(([key, label]) => <Chip onCard key={key} label={`+ ${label}`} selected={false} disabled={disabled || items.length >= 50} onPress={() => set("realizedItems", [...items, { id: randomUUID(), kind: key as MobileTowingRealizedItem["kind"], description: label, quantity: "1", unit: "úkon", ...(["tow", "transport", "relocation"].includes(key) && fields.destination ? { destination: fields.destination } : {}) }])} />)}</ChoiceField></FormSection>
    <FormSection title="Odovzdanie vozidla">
      <Field label="Komu bolo vozidlo odovzdané" value={value.handoverRecipientName ?? ""} editable={!disabled} onChangeText={text => set("handoverRecipientName", text)} />
      <FormText>{value.handedOverAt ? new Date(value.handedOverAt).toLocaleString("sk-SK") : "Čas odovzdania nebol potvrdený."}</FormText>
      <View style={formLayout.notices}><Button secondary label="Potvrdiť čas odovzdania teraz" disabled={disabled} onPress={() => set("handedOverAt", new Date().toISOString())} /></View>
      <Field label="Dôvod výnimky pri odovzdaní" value={value.handoverException ?? ""} editable={!disabled} multiline onChangeText={text => set("handoverException", text)} />
    </FormSection>
    {error ? <View style={formLayout.notices}><ErrorNotice message={error} /></View> : null}
    <View style={formLayout.actions}><Button label={saving ? "Ukladám údaje…" : "Uložiť realizačné údaje"} disabled={disabled || !Object.keys(edits).length} onPress={() => { void save(); }} /></View>
  </>;
}
