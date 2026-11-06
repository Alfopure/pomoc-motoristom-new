import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Alert, Linking, ScrollView, Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { randomUUID } from "expo-crypto";
import type { TowingCashCategory, TowingCommand, TowingFields, TowingOrder } from "../../../src/domain/towing/types";
import { cashCategoryLabels } from "../../../src/domain/towing/cash-categories";
import { InfoRow, DetailHeader, Tag } from "../design/detail";
import { Field, FormSection, FormText, ChoiceField, formLayout } from "../design/form";
import { Group, Row, SectionHeader } from "../design/list";
import { useAndroidBack } from "../lib/use-android-back";
import { useShellBack } from "../shell/back";
import { Button, ErrorNotice, Loading, styles } from "../ui";
import { cashAmountCents, cashEuro } from "./cash-model";
import type { FieldWorkSession } from "./session";
import { Chip, StepRecovery, StorageNotice } from "./parts";
import { towingCreateFieldNames } from "../../../src/domain/towing/creation";
import { TowingCreate, towingInputFields } from "./towing-create";
import { TowingFieldsForm, TowingPicker, towingPaymentLabels } from "./towing-form";
import { termLabel } from "./model";

const stages = [ ["", "Všetky"], ["draft", "Nepridelené"], ["active", "Prebiehajúce"], ["review", "Na kontrolu"], ["ready", "Na fakturáciu"], ["invoiced", "Vyfakturované"], ["paid", "Zaplatené"], ["cancelled", "Stornované"] ] as const;
const workLabels: Record<TowingOrder["workStatus"], string> = { draft: "Nepridelené", assigned: "Pridelené", in_progress: "Prebieha", submitted: "Na kontrolu", needs_changes: "Na doplnenie", cancelled: "Stornované" };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Údaje sa nepodarilo overiť.";

/** Office is its own authorized module, also for a member without central dispatch access. */
export function TowingOfficeModule({ session, active, visible }: { session: FieldWorkSession | null; active: boolean; visible: boolean }) {
  const [screen, setScreen] = useState<"list" | "create" | "cash" | string>("list");
  const back = () => setScreen("list");
  useShellBack(visible && screen === "cash", "Kniha odťahov", back);
  useAndroidBack(active && visible && screen === "cash", back);
  if (!session) return <Loading label="Overujem odťahovú kanceláriu…" />;
  if (!session.capabilities.includes("operate")) return <ErrorNotice message="Nemáte prístup do odťahovej kancelárie." />;
  if (screen === "create") return <TowingCreate session={session} office active={active} visible={visible} onBack={back} onCreated={id => setScreen(id)} />;
  if (screen === "cash") return <OfficeCash session={session} active={active && visible} />;
  if (screen !== "list") return <OfficeOrder key={screen} session={session} id={screen} active={active && visible} visible={visible} onBack={back} />;
  return <OfficeList session={session} active={active && visible} onCreate={() => setScreen("create")} onCash={() => setScreen("cash")} onOpen={setScreen} />;
}
function OfficeList({ session, active, onCreate, onCash, onOpen }: { session: FieldWorkSession; active: boolean; onCreate: () => void; onCash: () => void; onOpen: (id: string) => void }) {
  const [search, setSearch] = useState(""), [query, setQuery] = useState(""), [stage, setStage] = useState(""), [offset, setOffset] = useState(0);
  useEffect(() => { const timer = setTimeout(() => { setQuery(search.trim()); setOffset(0); }, 300); return () => clearTimeout(timer); }, [search]);
  const filters = { query, ...(stage ? { stage } : {}), limit: "30", offset: String(offset) };
  const list = useQuery({ queryKey: [...session.key, "towing-office", "list", filters], queryFn: ({ signal }) => session.api.towingOffice(filters, signal), enabled: active, refetchInterval: active ? 30000 : false });
  const state = useSyncExternalStore(session.commands.subscribe, session.commands.snapshot, session.commands.snapshot);
  const pendingCreate = state.pending.find(item => item.target.kind === "towing-create" && (item.command as { mode?: string }).mode === "office");
  return <ScrollView contentContainerStyle={formLayout.content} keyboardShouldPersistTaps="handled">
    <View style={formLayout.head}><Text accessibilityRole="header" style={styles.heading}>Kniha odťahov</Text><Text style={styles.muted}>Odťahová kancelária · zadania aj história</Text></View>
    <StorageNotice commands={session.commands} state={state} />
    {state.pending.filter(item => item.target.kind === "towing-office").map(item => <View key={item.target.id} style={formLayout.notices}><Button secondary label={"Overiť krok: " + item.label} onPress={() => {
      const type = (item.command as TowingCommand).type;
      if (["collect_cash", "accept_handover", "reject_handover", "cancel_handover"].includes(type)) onCash(); else onOpen(item.target.id);
    }} /></View>)}
    <View style={formLayout.actions}><Button primary label={pendingCreate ? "Overiť vytváraný odťah" : "Nový odťah"} onPress={onCreate} />
      {session.capabilities.includes("cash") ? <Button secondary label="Hotovosť vodičov" onPress={onCash} /> : null}</View>
    <FormSection title="Vyhľadávanie a filter">
      <Field label="Hľadať odťahy" value={search} onChangeText={setSearch} placeholder="Číslo, klient, EČV, miesto…" autoCorrect={false} />
      <TowingPicker label="Fáza zákazky" value={stage || undefined} items={stages.filter(([id]) => id).map(([id, name]) => ({ id, name }))} empty="Všetky fázy" onChange={next => { setStage(next ?? ""); setOffset(0); }} />
    </FormSection>
    {list.isError ? <View style={formLayout.notices}><ErrorNotice message={errorMessage(list.error)} onRetry={() => { void list.refetch(); }} /></View> : list.isPending ? <Loading label="Načítavam knihu odťahov…" /> : <>
      <SectionHeader title="Odťahy" detail={list.data?.totalCount === undefined ? null : String(list.data.totalCount)} />
      {list.data?.orders.length ? <Group>{list.data.orders.map((order, index) => <Row key={order.id} first={index === 0} title={`${order.number} · ${order.fields.subjectDescription || "Bez opisu"}`} subtitle={[workLabels[order.workStatus], order.fields.plate, order.fields.pickup, order.fields.plannedAt ? termLabel(order.fields.plannedAt) : null].filter(Boolean).join(" · ")} onPress={() => onOpen(order.id)} />)}</Group>
        : <FormSection><FormText tone="muted">Žiadne odťahy nezodpovedajú zvolenému hľadaniu.</FormText></FormSection>}
      <View style={formLayout.actions}>{offset > 0 ? <Button secondary label="Predchádzajúce" onPress={() => setOffset(Math.max(0, offset - 30))} /> : null}
        {(list.data?.totalCount ?? 0) > offset + 30 || list.data?.totalCount === undefined && list.data?.orders.length === 30 ? <Button secondary label="Ďalšie odťahy" onPress={() => setOffset(offset + 30)} /> : null}
        <Button secondary label={list.isFetching ? "Obnovujem…" : "Obnoviť"} disabled={list.isFetching} onPress={() => { void list.refetch(); }} /></View>
    </>}
  </ScrollView>;
}
function OfficeOrder({ session, id, active, visible, onBack }: { session: FieldWorkSession; id: string; active: boolean; visible: boolean; onBack: () => void }) {
  const client = useQueryClient();
  const key = [...session.key, "towing-office", "order", id];
  const orderQuery = useQuery({ queryKey: key, queryFn: ({ signal }) => session.api.towingOfficeOrder(id, signal), enabled: active, refetchInterval: active ? 30000 : false });
  const options = useQuery({ queryKey: [...session.key, "towing-options", session.memberId], queryFn: ({ signal }) => session.api.towingOptions(signal), enabled: active, staleTime: 300000 });
  const state = useSyncExternalStore(session.commands.subscribe, session.commands.snapshot, session.commands.snapshot);
  const target = { kind: "towing-office" as const, id }, pending = session.commands.pendingFor(target);
  const [draft, setDraft] = useState<{ fields: TowingFields; baseline: TowingFields; revision: number } | null>(null), [driverId, setDriverId] = useState<string | undefined>();
  const [valid, setValid] = useState(true), [error, setError] = useState<string | null>(null);
  const [receiptDirty, setReceiptDirty] = useState(false);
  const busy = state.busy || !state.ready || !state.enabled || Boolean(pending);
  const leave = () => {
    if (busy) return;
    if (!draft && !receiptDirty && (!driverId || driverId === orderQuery.data?.driverId)) { onBack(); return; }
    Alert.alert("Zahodiť rozpracované úpravy?", "Úpravy odťahu ešte neboli uložené.", [{ text: "Pokračovať v úprave", style: "cancel" }, { text: "Zahodiť", style: "destructive", onPress: onBack }]);
  };
  useShellBack(visible, "Kniha odťahov", leave, busy);
  useAndroidBack(active, leave);
  const apply = (value: unknown) => { const next = (value as { order?: TowingOrder | null }).order; if (next) client.setQueryData(key, next); void orderQuery.refetch(); setDraft(null); };
  async function run(type: TowingCommand["type"], payload: Record<string, unknown>, revision: number) {
    setError(null);
    const result = await session.commands.start(target, { commandId: randomUUID(), targetId: id, type, expectedRevision: revision, payload }, type === "assign" ? "Prideliť odťah" : "Uložiť odťah");
    if (result) apply(result); else void orderQuery.refetch();
    return Boolean(result);
  }
  const order = orderQuery.data;
  return <ScrollView contentContainerStyle={formLayout.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>
    <StorageNotice commands={session.commands} state={state} />
    {pending ? <StepRecovery commands={session.commands} record={pending} busy={state.busy || !state.enabled} onResult={apply} onReload={() => orderQuery.refetch()} /> : null}
    {error || orderQuery.isError ? <View style={formLayout.notices}><ErrorNotice message={error ?? errorMessage(orderQuery.error)} onRetry={() => { void orderQuery.refetch(); }} /></View> : null}
    {!order ? <Loading label="Načítavam odťah…" /> : <>
      <DetailHeader title={order.number} subtitle={order.fields.subjectDescription} tags={<Tag text={workLabels[order.workStatus]} tone={order.workStatus === "in_progress" ? "orange" : "gray"} />} />
      <Group><InfoRow first label="Vodič" value={options.data?.members?.find(member => member.id === order.driverId)?.name ?? null} empty="Nepridelený" />
        <InfoRow label="Nakládka" value={order.fields.pickup} /><InfoRow label="Vykládka" value={order.fields.destination ?? null} />
        <InfoRow label="Termín" value={order.fields.plannedAt ? termLabel(order.fields.plannedAt) : null} />
        <InfoRow label="Dohodnutá úhrada" value={order.fields.paymentIntent ? towingPaymentLabels[order.fields.paymentIntent] : null} />
        <InfoRow label="Prijaté platby" value={cashEuro(order.receivedCents)} /></Group>
      <FormSection title="Pridelenie vodiča"><TowingPicker label="Vodič" value={driverId ?? order.driverId ?? undefined} items={options.data?.members ?? []} disabled={busy || order.workStatus === "cancelled"} onChange={setDriverId} />
        <View><Button secondary label="Potvrdiť pridelenie" disabled={busy || !driverId || driverId === order.driverId || order.workStatus === "cancelled"} onPress={() => { void run("assign", { driverId }, order.revision); }} /></View></FormSection>
      {!draft ? <View style={formLayout.actions}><Button primary label="Upraviť odťah" disabled={busy || order.workStatus === "cancelled"} onPress={() => setDraft({ fields: order.fields, baseline: order.fields, revision: order.revision })} /></View> : <>
        {order.revision !== draft.revision ? <View style={formLayout.notices}><ErrorNotice message="Zákazka sa počas úpravy zmenila. Rozpracované údaje ostali zachované; pred uložením ich porovnajte s aktuálnou zákazkou." /></View> : null}
        <TowingFieldsForm value={draft.fields} onChange={fields => setDraft(current => current ? { ...current, fields } : null)} options={options.data} disabled={busy} actualTimes onValidityChange={setValid} />
        <View style={formLayout.actions}><Button primary label="Uložiť odťah" disabled={busy || !valid || order.revision !== draft.revision} onPress={() => {
          const clean = towingInputFields(draft.fields);
          const fields = Object.fromEntries(towingCreateFieldNames.filter(key => JSON.stringify(draft.fields[key] ?? null) !== JSON.stringify(draft.baseline[key] ?? null)).map(key => [key, clean[key] ?? null]));
          void run("update_order", { fields }, draft.revision);
        }} />
          <Button secondary label="Zahodiť úpravy" disabled={busy} onPress={() => Alert.alert("Zahodiť úpravy?", "Neuložené zmeny tohto odťahu sa zahodia.", [{ text: "Zostať", style: "cancel" }, { text: "Zahodiť", style: "destructive", onPress: () => setDraft(null) }])} /></View>
      </>}
      {session.capabilities.includes("bill") ? <OfficeReceipt key={id} session={session} order={order} active={active} busy={busy} onDirtyChange={setReceiptDirty} onReceive={(payload) => run("receive_payment", payload, order.revision)} /> : null}
      <FormSection title="Fotografie a doklady"><FormText>{order.attachments.length ? `${order.attachments.length} príloh v zákazke` : "Zatiaľ bez príloh."}</FormText>
        <FormText tone="muted">Kancelárske prílohy a PDF otvoríte vo webovej kancelárii. Prehliadač môže vyžadovať prihlásenie.</FormText>
        <View><Button secondary label="Fotografie a doklady vo webovej kancelárii" onPress={() => { void Linking.openURL(session.api.towingOfficeUrl(id)).catch(() => setError("Webovú kanceláriu sa nepodarilo otvoriť.")); }} /></View>
      </FormSection>
    </>}
  </ScrollView>;
}

function OfficeReceipt({ session, order, active, busy, onReceive, onDirtyChange }: {
  session: FieldWorkSession; order: TowingOrder; active: boolean; busy: boolean; onReceive: (payload: Record<string, unknown>) => Promise<boolean>; onDirtyChange: (dirty: boolean) => void;
}) {
  const context = useQuery({ queryKey: [...session.key, "towing-office", "receipt-cash", order.id], queryFn: ({ signal }) => session.api.towingOffice({ orderId: order.id, limit: "1" }, signal), enabled: active });
  const [amount, setAmount] = useState(""), [method, setMethod] = useState<"cash" | "card">("cash"), [category, setCategory] = useState<TowingCashCategory>(order.fields.paymentIntent === "cash_other" ? "other" : "regular");
  const [confirming, setConfirming] = useState(false), confirmation = useRef(false);
  useEffect(() => { onDirtyChange(amount.trim().length > 0); }, [amount, onDirtyChange]);
  const cents = cashAmountCents(amount), account = context.data?.cashAccounts.find(item => item.driverId === order.driverId);
  const blocked = busy || confirming || context.isPending || context.isError || context.isFetching;
  const driver = context.data?.members.find(member => member.id === order.driverId)?.displayName ?? null;
  return <>
    {order.payments?.length ? <FormSection title="Potvrdené platby">{order.payments.map(payment => <InfoRow key={payment.id} label={payment.method === "cash" ? payment.cashCategory === "other" ? "Iná hotovosť (bez faktúry)" : "Hotovosť" : payment.method === "card" ? "Karta" : "Iná úhrada"} value={cashEuro(payment.amountCents)} detail={termLabel(payment.createdAt)} />)}</FormSection> : null}
    <FormSection title="Zaevidovať prijatú platbu" footer="Autor zápisu je dispečer. Hotovosť patrí vodičovi, ktorý ju skutočne prevzal.">
      <InfoRow first label="Vodič zákazky" value={driver} empty="Nepridelený" />
      <Field label="Skutočne prijatá suma (€)" value={amount} keyboardType="decimal-pad" editable={!blocked} onChangeText={setAmount} />
      <ChoiceField label="Spôsob úhrady"><Chip onCard label="Hotovosť" selected={method === "cash"} disabled={blocked} onPress={() => setMethod("cash")} /><Chip onCard label="Karta" selected={method === "card"} disabled={blocked} onPress={() => setMethod("card")} /></ChoiceField>
      {method === "cash" ? <ChoiceField label="Kategória hotovosti">{(["regular", "other"] as const).map(value => <Chip key={value} onCard label={cashCategoryLabels[value]} selected={category === value} disabled={blocked} onPress={() => setCategory(value)} />)}</ChoiceField> : null}
      {context.isError ? <ErrorNotice message="Pokladňu príjemcu sa nepodarilo overiť." onRetry={() => { void context.refetch(); }} /> : null}
      {method === "cash" && !order.driverId ? <FormText tone="muted">Najprv priraďte vodiča, ktorý hotovosť prijal.</FormText> : null}
      <View><Button primary label="Potvrdiť skutočne prijatú platbu" disabled={blocked || !cents || method === "cash" && !order.driverId} onPress={() => {
        if (confirmation.current || !cents || blocked || method === "cash" && !order.driverId) return;
        confirmation.current = true; setConfirming(true);
        const release = () => { confirmation.current = false; setConfirming(false); };
        const payload = { receiptId: randomUUID(), amountCents: cents, method, ...(order.driverId ? { driverId: order.driverId } : {}), ...(method === "cash" ? { accountRevision: account?.revision ?? 1, cashCategory: category } : {}) };
        Alert.alert("Potvrdiť prijatú platbu?", `${cashEuro(cents)} · ${method === "cash" ? cashCategoryLabels[category] : "Karta"}${method === "cash" ? " · " + (driver ?? "Vodič") : ""}.`, [{ text: "Späť", style: "cancel", onPress: release }, { text: "Platba bola prijatá", onPress: () => { void onReceive(payload).then(ok => { if (ok) { setAmount(""); void context.refetch(); } }).finally(release); } }], { cancelable: true, onDismiss: release });
      }} /></View>
    </FormSection>
  </>;
}

function OfficeCash({ session, active }: { session: FieldWorkSession; active: boolean }) {
  const query = useQuery({ queryKey: [...session.key, "towing-office", "cash"], queryFn: ({ signal }) => session.api.towingOffice({ limit: "1" }, signal), enabled: active && session.capabilities.includes("cash"), refetchInterval: active ? 30000 : false });
  const state = useSyncExternalStore(session.commands.subscribe, session.commands.snapshot, session.commands.snapshot);
  const [driver, setDriver] = useState<string | undefined>(), [amount, setAmount] = useState(""), [category, setCategory] = useState<TowingCashCategory>("other"), [error, setError] = useState<string | null>(null);
  const confirmationLock = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const busy = state.busy || !state.ready || !state.enabled || query.isPending || query.isError || query.isFetching;
  const cashPending = state.pending.filter(item => item.target.kind === "towing-office" && ["collect_cash", "accept_handover", "reject_handover", "cancel_handover"].includes((item.command as TowingCommand).type));
  const workspace = query.data, own = workspace?.cashAccounts.find(account => account.driverId === driver), office = workspace?.cashAccounts.find(account => account.driverId === null);
  const cents = cashAmountCents(amount), categories = own?.categories;
  const breakdown = cents && categories && cents <= categories[category].balanceCents - categories[category].reservedCents ? { regular: 0, other: 0, unclassified: 0, [category]: cents } : undefined;
  async function run(targetId: string, type: TowingCommand["type"], payload: Record<string, unknown>, revision: number) {
    setError(null);
    const result = await session.commands.start({ kind: "towing-office", id: targetId }, { commandId: randomUUID(), targetId, type, expectedRevision: revision, payload }, "Prevzatie hotovosti");
    if (result) { setAmount(""); void query.refetch(); }
  }
  if (!session.capabilities.includes("cash")) return <ErrorNotice message="Nemáte oprávnenie preberať hotovosť." />;
  return <ScrollView contentContainerStyle={formLayout.content} keyboardShouldPersistTaps="handled">
    <View style={formLayout.head}><Text accessibilityRole="header" style={styles.heading}>Hotovosť vodičov</Text><Text style={styles.muted}>Iná hotovosť (bez faktúry) zostáva u vodiča do prevzatia majiteľom.</Text></View>
    <StorageNotice commands={session.commands} state={state} />
    {cashPending.map(pending => <StepRecovery key={pending.target.id} commands={session.commands} record={pending} busy={busy} onResult={() => { void query.refetch(); }} onReload={() => query.refetch()} />)}
    {error || query.isError ? <View style={formLayout.notices}><ErrorNotice message={error ?? errorMessage(query.error)} onRetry={() => { void query.refetch(); }} /></View> : null}
    {!workspace ? <Loading label="Načítavam hotovosť vodičov…" /> : <>
      {workspace.cashAccounts.filter(account => account.driverId !== null).map(account => <FormSection key={account.id} title={workspace.members.find(member => member.id === account.driverId)?.displayName ?? "Vodič"}>
        <InfoRow first label="Celková hotovosť" value={cashEuro(account.balanceCents)} />
        {account.categories ? <InfoRow label="Z toho Iná hotovosť" value={cashEuro(account.categories.other.balanceCents)} /> : null}
        <InfoRow label="Rezervované na odovzdanie" value={cashEuro(account.reservedCents)} />
      </FormSection>)}
      <FormSection title="Prevziať hotovosť od vodiča">
        <TowingPicker label="Vodič" value={driver} items={workspace.members.filter(member => member.capabilities.includes("drive")).map(member => ({ id: member.id, name: member.displayName }))} onChange={setDriver} disabled={busy || cashPending.length > 0} />
        <ChoiceField label="Preberaná hotovosť">{(["other", "regular", "unclassified"] as const).map(value => <Chip key={value} onCard label={cashCategoryLabels[value]} selected={category === value} disabled={busy || cashPending.length > 0} onPress={() => setCategory(value)} />)}</ChoiceField>
        <Field label="Prevzatá suma (€)" value={amount} keyboardType="decimal-pad" editable={!busy && cashPending.length === 0} onChangeText={setAmount} />
        {own ? <FormText tone="muted">Dostupné celkom: {cashEuro(own.balanceCents - own.reservedCents)}. Prevzatie potvrdí skutočný presun peňazí do kancelárie.</FormText> : null}
        <View><Button primary label="Potvrdiť prevzatie hotovosti" disabled={busy || confirming || cashPending.length > 0 || !driver || !cents || !own || cents > own.balanceCents - own.reservedCents || !breakdown} onPress={() => {
          if (confirmationLock.current || !driver || !cents || !own || !breakdown) return;
          confirmationLock.current = true; setConfirming(true);
          const release = () => { confirmationLock.current = false; setConfirming(false); };
          Alert.alert("Potvrdiť fyzické prevzatie?", `${cashEuro(cents)} od vodiča. Zostatok sa presunie do kancelárie.`, [{ text: "Späť", style: "cancel", onPress: release }, { text: "Peniaze sú prevzaté", onPress: () => { void run(randomUUID(), "collect_cash", { driverId: driver, amountCents: cents, accountRevision: own.revision, officeRevision: office?.revision ?? 1, cashBreakdown: breakdown }, 0).finally(release); } }], { cancelable: true, onDismiss: release });
        }} /></View>
      </FormSection>
      {workspace.handovers.filter(handover => handover.status === "pending").map(handover => {
        const account = workspace.cashAccounts.find(item => item.driverId === handover.driverId);
        return <FormSection key={handover.id} title="Čaká na prevzatie"><InfoRow first label={workspace.members.find(member => member.id === handover.driverId)?.displayName ?? "Vodič"} value={cashEuro(handover.amountCents)} />
          <View><Button primary label="Potvrdiť prevzatie" disabled={busy || cashPending.length > 0 || !account} onPress={() => {
            if (!account) return;
            Alert.alert("Potvrdiť prevzatie hotovosti?", cashEuro(handover.amountCents), [{ text: "Späť", style: "cancel" }, { text: "Peniaze sú prevzaté", onPress: () => { void run(handover.id, "accept_handover", { accountRevision: account.revision, officeRevision: office?.revision ?? 1 }, handover.revision); } }]);
          }} /><Button secondary label="Odmietnuť — peniaze neboli prevzaté" disabled={busy || cashPending.length > 0} onPress={() => { void run(handover.id, "reject_handover", { reason: "Hotovosť nebola fyzicky odovzdaná kancelárii." }, handover.revision); }} /></View>
        </FormSection>;
      })}
      <View style={formLayout.actions}><Button secondary label="Obnoviť hotovosť" disabled={query.isFetching} onPress={() => { void query.refetch(); }} /></View>
    </>}
  </ScrollView>;
}
