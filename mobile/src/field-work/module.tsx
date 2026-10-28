import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Alert, Linking, Pressable, ScrollView, Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { randomUUID } from "expo-crypto";
import { Camera, Car, ClipboardCheck, Clock, MapPin, Navigation, Phone, Truck } from "lucide-react-native";
import type { MobileOperation, MobileOperationEvidenceInput, MobileTowingAttachment, MobileTowingCommand, MobileTowingDriverFields, MobileTowingOrder } from "../../../src/lib/mobile-api";
import { MobileApiError } from "../lib/api";
import { dialable, formatNumber } from "../lib/display";
import { useAndroidBack } from "../lib/use-android-back";
import { directionsUrl } from "../cases/maps";
import { canUseDeliveryCache } from "../delivery/model";
import type { LocationSharing, SharingState } from "../delivery/sharing";
import { useDeliveryTime } from "../delivery/use-delivery-time";
import { ActionBar, DetailHeader, InfoRow, Tag } from "../design/detail";
import { ChoiceField, Field, FieldAction, FormSection, FormText, formLayout } from "../design/form";
import { Group, SectionHeader } from "../design/list";
import { palette } from "../design/tokens";
import { useShellBack } from "../shell/back";
import { Button, ErrorNotice, Loading, styles } from "../ui";
import { prepareDocumentPicker, preparePhotoPicker } from "../work/pickers";
import type { PickedFile } from "../work/attachments";
import type { PendingUpload, TowingUploads, UploadsView } from "./uploads";
import { targetKey, type WorkTarget } from "./commands";
import {
  attachmentKindLabels, emptyEvidence, evidencePayload, evidenceProblem, isLate, isOpenOperation, nextOperationStep, nextTowingStep, operationKindLabels,
  operationStatusLabels, operationStatusTones, serviceLabels, sharesOperationPosition, sourceLabels, stageLabels, termLabel, towingMissing,
  towingStatusLabels, towingStatusTones, workItems, type EvidenceDraft, type WorkItem,
} from "./model";
import { Chip, StepRecovery, StorageNotice, fieldStyles as s } from "./parts";
import type { FieldWorkSession } from "./session";

export type WorkOpenRequest = { kind: "operation" | "towing"; id: string; nonce: number };
const errorText = (error: unknown, fallback: string) => error instanceof MobileApiError ? error.message : error instanceof Error ? error.message : fallback;
const newer = <T extends { id: string; revision: number }>(previous: T | undefined, next: T): T => previous?.id === next.id && previous.revision > next.revision ? previous : next;
function openUrl(url: () => string, onError: (message: string) => void) {
  try { void Linking.openURL(url()).catch(() => onError("Odkaz sa nepodarilo otvoriť.")); } catch (error) { onError(errorText(error, "Odkaz sa nepodarilo otvoriť.")); }
}
const call = (phone: string | null, onError: (message: string) => void) => { if (phone) openUrl(() => "tel:" + phone.replace(/[^\d+]/g, ""), onError); };
const navigate = (place: string | null, onError: (message: string) => void) => { if (place?.trim()) openUrl(() => directionsUrl(place), onError); };

/** Moja práca: own jazdy, odvozy, presuny and odťahy sorted by term, each with its
 * steps, doklady and photos. The shell's top bar leads back from a detail. */
export function WorkModule({ session, active, visible, openRequest }: { session: FieldWorkSession | null; active: boolean; visible: boolean; openRequest: WorkOpenRequest | null }) {
  const [selected, setSelected] = useState<WorkTarget | null>(null);
  const [handled, setHandled] = useState<number | null>(null);
  if (openRequest && openRequest.nonce !== handled) { setHandled(openRequest.nonce); setSelected({ kind: openRequest.kind, id: openRequest.id }); }
  const back = () => setSelected(null);
  useShellBack(visible && selected !== null, "Moja práca", back);
  useAndroidBack(active && visible && selected !== null, back);
  if (!session) return <View style={styles.content}><Loading label="Overujem prístup k práci…" /></View>;
  if (selected?.kind === "operation") return <OperationDetail key={selected.id} session={session} id={selected.id} active={active && visible} />;
  if (selected?.kind === "towing") return <TowingDetail key={selected.id} session={session} id={selected.id} active={active && visible} />;
  return <WorkList session={session} active={active && visible} onOpen={setSelected} />;
}

function WorkList({ session, active, onOpen }: { session: FieldWorkSession; active: boolean; onOpen: (target: WorkTarget) => void }) {
  const now = useDeliveryTime(active);
  const commands = useSyncExternalStore(session.commands.subscribe, session.commands.snapshot, session.commands.snapshot);
  const query = session.list, usable = canUseDeliveryCache(query.error);
  const items = usable ? workItems(query.data) : [];
  const pending = commands.pending.filter(item => item.target.kind !== "branch");
  const uploads = useUploads(session.uploads).uploads;
  return <ScrollView contentContainerStyle={formLayout.content}>
    <View style={formLayout.head}><Text accessibilityRole="header" style={styles.heading}>Moja práca</Text></View>
    <StorageNotice commands={session.commands} state={commands} />
    {pending.length > 0 && <>
      <SectionHeader title="Nepotvrdené kroky" detail={String(pending.length)} />
      <View style={formLayout.actions}>{pending.map(record => <Button key={targetKey(record.target)} secondary label={"Overiť krok: " + record.label} onPress={() => onOpen(record.target)} />)}</View>
    </>}
    {uploads.length > 0 && <>
      <SectionHeader title="Nedokončené nahrávanie" detail={String(uploads.length)} />
      <View style={formLayout.actions}>{uploads.map(upload => <Button key={upload.attachmentId} secondary label={"Dokončiť nahrávanie: " + attachmentKindLabels[upload.kind].toLowerCase()}
        onPress={() => onOpen({ kind: "towing", id: upload.orderId })} />)}</View>
    </>}
    {(query.isError || query.data?.unavailable.length) ? <View style={formLayout.notices}>
      {query.isError && <ErrorNotice message={errorText(query.error, "Prácu sa nepodarilo načítať.")} onRetry={() => { void query.refetch(); }} />}
      {query.data?.unavailable.includes("operations") && <ErrorNotice message="Jazdy sa teraz nepodarilo načítať." onRetry={() => { void query.refetch(); }} />}
      {query.data?.unavailable.includes("towing") && <ErrorNotice message="Odťahy sa teraz nepodarilo načítať." onRetry={() => { void query.refetch(); }} />}
    </View> : null}
    {query.isPending ? <Loading label="Načítavam prácu…" /> : usable && <>
      <SectionHeader title="Na vybavenie" detail={items.length ? String(items.length) : null} />
      {items.length ? <Group>{items.map((item, index) => <WorkRow key={item.key} item={item} first={index === 0} now={now} onOpen={onOpen} />)}</Group>
        : query.data && !query.data.unavailable.length ? <Text style={s.empty}>Teraz nemáte pridelenú žiadnu prácu. Keď vám ju pridelia, nájdete ju tu.</Text>
          : <Text style={s.empty}>Zoznam práce sa nepodarilo overiť. Skúste ho obnoviť.</Text>}
    </>}
    <View style={formLayout.actions}><Button label={query.isFetching ? "Obnovujem…" : "Obnoviť"} secondary disabled={query.isFetching} onPress={() => { void query.refetch(); }} /></View>
  </ScrollView>;
}

export function workTitle(item: WorkItem): string {
  if (item.kind === "operation") return operationKindLabels[item.operation.kind] + (item.operation.vehicle ? " · " + item.operation.vehicle : "");
  const f = item.order.fields;
  return serviceLabels[f.serviceType] + " · " + ([f.subjectDescription, f.plate].filter(Boolean).join(" ") || item.order.number);
}
export function WorkRow({ item, first, now, onOpen }: { item: WorkItem; first: boolean; now: number; onOpen: (target: { kind: "operation" | "towing"; id: string }) => void }) {
  const status = item.kind === "operation" ? { text: operationStatusLabels[item.operation.status], tone: operationStatusTones[item.operation.status] }
    : { text: towingStatusLabels[item.order.workStatus], tone: towingStatusTones[item.order.workStatus] };
  const route = item.kind === "operation" ? [item.operation.from, item.operation.to] : [item.order.fields.pickup, item.order.fields.destination ?? ""];
  const late = isLate(item.at, now) && (item.kind === "towing" ? item.order.workStatus === "assigned" : item.operation.status === "assigned" || item.operation.status === "accepted");
  const Icon = item.kind === "towing" ? Truck : Car;
  const title = workTitle(item);
  return <Pressable accessibilityRole="button" accessibilityLabel={"Otvoriť " + title + ", " + status.text + ", " + termLabel(item.at)}
    onPress={() => onOpen(item.kind === "operation" ? { kind: "operation", id: item.operation.id } : { kind: "towing", id: item.order.id })}
    style={({ pressed }) => [s.row, pressed && { backgroundColor: "#ECECF0" }]}>
    {!first && <View style={s.separator} />}
    <View style={[s.icon, { backgroundColor: item.kind === "towing" ? palette.orangeSoft : palette.blueSoft }]}>
      <Icon size={20} strokeWidth={2.2} color={item.kind === "towing" ? palette.orangeText : palette.blueText} accessible={false} /></View>
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <Text numberOfLines={2} style={s.rowTitle}>{title}</Text>
      <View style={s.rowHead}><Tag text={status.text} tone={status.tone} />{late && <Tag text="Po termíne" tone="red" />}
        <Text numberOfLines={1} style={[s.rowDetail, { flexShrink: 1 }]}>{termLabel(item.at)}</Text></View>
      {route.some(Boolean) ? <Text numberOfLines={2} style={s.rowDetail}>{route.filter(Boolean).join(" → ")}</Text> : null}
    </View>
    <Text style={s.chevron}>›</Text>
  </Pressable>;
}

function OperationDetail({ session, id, active }: { session: FieldWorkSession; id: string; active: boolean }) {
  const queryClient = useQueryClient();
  const detailKey = useMemo(() => [...session.key, "operation", id], [session.key, id]);
  const query = useQuery({ queryKey: detailKey, queryFn: ({ signal }) => session.api.operation(id, signal), refetchInterval: active ? 15_000 : false,
    structuralSharing: (previous, next) => newer(previous as MobileOperation | undefined, next as MobileOperation) });
  const commands = useSyncExternalStore(session.commands.subscribe, session.commands.snapshot, session.commands.snapshot);
  const location = useSyncExternalStore(session.tracker.subscribe, session.tracker.snapshot, session.tracker.snapshot);
  const target: WorkTarget = { kind: "operation", id };
  const pending = commands.pending.find(item => targetKey(item.target) === targetKey(target));
  const [error, setError] = useState<string | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const blocked = !commands.enabled || !commands.ready || commands.busy || Boolean(pending);
  const operation = query.data && canUseDeliveryCache(query.error) ? query.data : undefined;
  function applied(result: unknown, action?: string) {
    const next = result as MobileOperation;
    queryClient.setQueryData<MobileOperation>(detailKey, previous => newer(previous, next));
    void queryClient.invalidateQueries({ queryKey: [...session.key, "work"] });
    if (sharesOperationPosition(next) && (action === "accept" || action === "start")) void session.tracker.follow(next.id, true);
  }
  async function run(action: "accept" | "start" | "arrive" | "collect" | "complete" | "evidence", label: string, payload: Record<string, never> | MobileOperationEvidenceInput = {}): Promise<boolean> {
    if (!operation || blocked) return false;
    setError(null);
    const next = await session.commands.start<MobileOperation>(target, { commandId: randomUUID(), action, expectedRevision: operation.revision, payload }, label);
    if (next) { applied(next, action); return true; }
    void query.refetch();
    return false;
  }
  const recovery = <><StorageNotice commands={session.commands} state={commands} />
    {pending && <StepRecovery commands={session.commands} record={pending} busy={commands.busy || !commands.enabled} onResult={result => applied(result, (pending.command as { action?: string }).action)} onReload={() => query.refetch()} />}</>;
  if (query.isPending) return <ScrollView contentContainerStyle={styles.content}>{recovery}<Loading label="Načítavam jazdu…" /></ScrollView>;
  if (!operation) return <ScrollView contentContainerStyle={styles.content}>{recovery}
    <ErrorNotice message={errorText(query.error, "Jazdu sa nepodarilo načítať.")} onRetry={() => { void query.refetch(); }} /></ScrollView>;
  const step = nextOperationStep(operation), open = isOpenOperation(operation), phone = operation.customer?.phone || null;
  const confirmStep = () => {
    if (!step) return;
    if (!step.confirm) { void run(step.action, step.label); return; }
    Alert.alert(step.label, step.confirm, [{ text: "Späť", style: "cancel" }, { text: step.label, onPress: () => { void run(step.action, step.label); } }]);
  };
  return <ScrollView contentContainerStyle={formLayout.content} keyboardShouldPersistTaps="handled">
    <DetailHeader title={operationKindLabels[operation.kind] + (operation.vehicle ? " · " + operation.vehicle : "")} subtitle={[operation.from, operation.to].filter(Boolean).join(" → ") || null}
      tags={<Tag text={operationStatusLabels[operation.status]} tone={operationStatusTones[operation.status]} />}
      meta={[operation.caseNumber ? "Prípad " + operation.caseNumber : null, termLabel(operation.scheduledAt)].filter(Boolean).join(" · ")} />
    {recovery}
    {(error || query.isError) && <View style={formLayout.notices}>
      {error && <ErrorNotice message={error} />}
      {query.isError && <ErrorNotice message="Údaje sa nepodarilo obnoviť. Zobrazený je posledný načítaný stav." onRetry={() => { void query.refetch(); }} />}
    </View>}
    {open && <ActionBar actions={[
      { icon: Phone, label: "Zavolať", accessibilityLabel: "Zavolať klientovi", disabled: !dialable(phone), onPress: () => call(phone, setError) },
      { icon: MapPin, label: "Odkiaľ", accessibilityLabel: "Navigovať na miesto vyzdvihnutia", disabled: !operation.from.trim(), onPress: () => navigate(operation.from, setError) },
      { icon: Navigation, label: "Kam", accessibilityLabel: "Navigovať do cieľa", disabled: !operation.to.trim(), onPress: () => navigate(operation.to, setError) },
      { icon: ClipboardCheck, label: "Doklad", accessibilityLabel: "Doplniť doklad", disabled: blocked, onPress: () => setEvidenceOpen(true) },
    ]} />}
    {step && !pending && !evidenceOpen && <View style={formLayout.actions}><Button primary label={step.label} disabled={blocked} onPress={confirmStep} /></View>}
    {operation.status === "assigned" && !pending && <Text style={s.note}>Po prijatí aplikácia požiada o polohu a počas jazdy ju posiela dispečingu.</Text>}
    {open && sharesOperationPosition(operation) && <Text style={s.note}>{positionNote(location, session.tracker.mode)}</Text>}
    {open && sharesOperationPosition(operation) && (location.status === "off" || location.status === "error") && <View style={formLayout.actions}>
      <Button secondary label="Zdieľať polohu s dispečerom" onPress={() => { void session.tracker.follow(operation.id, true); }} /></View>}
    {open && sharesOperationPosition(operation) && (location.status === "denied" || location.status === "sharing" && location.background === "whenInUse") && <View style={formLayout.actions}>
      <Button secondary label="Otvoriť nastavenia telefónu" onPress={() => { void Linking.openSettings().catch(() => undefined); }} /></View>}
    {evidenceOpen && open && <EvidenceForm session={session} operation={operation} disabled={blocked}
      onSubmit={payload => run("evidence", "Doklad: " + stageLabels[payload.stage], payload)} onClose={() => setEvidenceOpen(false)} />}
    <SectionHeader title="Jazda" />
    <Group>
      <InfoRow first label="Kedy" value={termLabel(operation.scheduledAt)} detail={operation.plannedEndAt ? "Predpokladaný koniec " + termLabel(operation.plannedEndAt) : null} />
      <InfoRow label="Odkiaľ" value={operation.from || null} empty="Neuvedené" />
      <InfoRow label="Kam" value={operation.to || null} empty="Neuvedené" />
      <InfoRow label="Vozidlo" value={operation.vehicle} empty="Vozidlo ešte nie je určené" />
      <InfoRow label="Prípad" value={operation.caseNumber} empty="Samostatná jazda" />
      <InfoRow label="Pokyny" value={operation.instructions} empty="Bez pokynov" />
    </Group>
    {operation.customer && <>
      <SectionHeader title="Kontakt" />
      <Group>
        <InfoRow first label="Meno" value={operation.customer.name || null} />
        <InfoRow label="Telefón" value={phone ? formatNumber(phone) : null} />
      </Group>
    </>}
    <SectionHeader title="Doklady" detail={operation.evidenceState === "complete" ? "Doplnené" : "Čakajú"} />
    {operation.evidence.length ? <Group>{operation.evidence.map((item, index) => <InfoRow key={item.id} first={index === 0} label={stageLabels[item.stage] + " · " + termLabel(item.observedAt)}
      value={[item.person, item.odometer !== null ? item.odometer + " km" : null, item.fuel ? "palivo " + item.fuel : null, item.photo ? "fotografia" : null].filter(Boolean).join(" · ") || sourceLabels[item.source]}
      detail={[item.note || null, item.missingReason ? "Chýba: " + item.missingReason : null, item.stage === "damage" ? (item.damageStatus === "resolved" ? "Poškodenie vyriešené" : "Poškodenie otvorené") : null].filter(Boolean).join("\n") || null} />)}</Group>
      : <Text style={s.empty}>{open ? "Zatiaľ bez dokladov. Pri prevzatí a odovzdaní vozidla pridajte doklad tlačidlom Doklad." : "Bez dokladov. Doklady k ukončenej jazde doplní dispečer."}</Text>}
  </ScrollView>;
}

/** What the executor reads about their position, for the app they have. */
function positionNote(location: SharingState, mode: LocationSharing["mode"]): string {
  if (location.status === "denied") return "Poloha nie je povolená. Dispečer neuvidí, kde ste. Povoliť ju môžete v nastaveniach telefónu.";
  if (location.status === "error") return "Polohu sa nepodarilo zapnúť. Skúste to znova.";
  if (location.status !== "sharing") return "Poloha sa počas tejto jazdy zatiaľ neposiela.";
  if (mode === "foreground") return "Vaša poloha sa posiela dispečingu počas tejto jazdy, kým je aplikácia otvorená.";
  return location.background === "always" ? "Vaša poloha sa posiela dispečingu aj na pozadí a pri zamknutom telefóne, kým je jazda otvorená."
    : "Poloha sa posiela, aj keď je aplikácia na pozadí, ale po jej zatvorení sa zastaví. V nastaveniach telefónu povoľte polohu „Vždy“.";
}

function EvidenceForm({ session, operation, disabled, onSubmit, onClose }: {
  session: FieldWorkSession; operation: MobileOperation; disabled: boolean; onSubmit: (payload: MobileOperationEvidenceInput) => Promise<boolean>; onClose: () => void;
}) {
  const hasPickup = operation.evidence.some(item => item.stage === "pickup");
  const [draft, setDraft] = useState<EvidenceDraft>(() => emptyEvidence(operation.kind === "delivery" || hasPickup ? "handover" : "pickup"));
  const [photo, setPhoto] = useState<PickedFile | null>(null);
  const [reference, setReference] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (change: Partial<EvidenceDraft>) => { setDraft(value => ({ ...value, ...change })); setProblem(null); };
  async function choose(camera: boolean) {
    setProblem(null);
    try { const pick = await preparePhotoPicker(); const file = await pick(camera); if (file) { setPhoto(file); setReference(null); } }
    catch (error) { setProblem(errorText(error, "Fotografiu sa nepodarilo načítať.")); }
  }
  const pickPhoto = () => Alert.alert("Fotografia k dokladu", undefined, [{ text: "Odfotiť", onPress: () => { void choose(true); } }, { text: "Vybrať z galérie", onPress: () => { void choose(false); } }, { text: "Zrušiť", style: "cancel" }]);
  async function save() {
    const issue = evidenceProblem(draft, Boolean(photo), operation.vehicleConfirmed);
    if (issue) { setProblem(issue); return; }
    setBusy(true); setProblem(null);
    try {
      let uploaded = reference;
      if (photo && !uploaded) { uploaded = await session.api.operationFile(operation.id, photo.bytes, photo.mimeType); setReference(uploaded); }
      if (await onSubmit(evidencePayload(draft, new Date().toISOString(), uploaded))) onClose();
    } catch (error) { setProblem(errorText(error, "Fotografiu sa nepodarilo nahrať. Skúste znova.")); }
    finally { setBusy(false); }
  }
  const locked = disabled || busy;
  return <>
    <FormSection title="Nový doklad" footer="Čo chýba, vysvetlite v poslednom poli; doklad sa uloží s časom odoslania.">
      <ChoiceField label="Časť jazdy">
        {(["pickup", "handover", "damage"] as const).map(stage => <Chip key={stage} onCard label={stageLabels[stage]} selected={draft.stage === stage} disabled={locked || stage === "damage" && !operation.vehicleConfirmed}
          onPress={() => set({ stage })} />)}
      </ChoiceField>
      {!operation.vehicleConfirmed && <FormText tone="muted">Poškodenie sa dá nahlásiť iba pri potvrdenom vozidle. Inak ho opíšte v zisteniach a kontaktujte dispečera.</FormText>}
      <ChoiceField label="Pôvod údaja">
        {(["observed", "reported", "exception"] as const).map(source => <Chip key={source} onCard label={sourceLabels[source]} selected={draft.source === source} disabled={locked} onPress={() => set({ source })} />)}
      </ChoiceField>
      {draft.stage !== "damage" && <Field label="Kto vozidlo odovzdal / prevzal" value={draft.person} onChangeText={person => set({ person })} maxLength={200} editable={!locked} />}
      <Field label="Stav kilometrov" value={draft.odometer} onChangeText={odometer => set({ odometer })} keyboardType="numeric" maxLength={12} editable={!locked} />
      <Field label="Palivo" value={draft.fuel} onChangeText={fuel => set({ fuel })} placeholder="napr. 1/2 alebo 60 %" maxLength={100} editable={!locked} />
      <Field label="Fotografia" value={photo ? photo.fileName + (reference ? " · nahratá" : "") : ""} placeholder="Bez fotografie" editable={false}
        action={<FieldAction icon={Camera} label={photo ? "Vybrať inú" : "Pridať"} accessibilityLabel={photo ? "Vybrať inú fotografiu" : "Pridať fotografiu"} disabled={locked} onPress={pickPhoto} />} />
      <Field label={draft.stage === "damage" ? "Čo sa stalo" : "Zistenia"} value={draft.note} onChangeText={note => set({ note })} multiline maxLength={2000} editable={!locked} />
      {draft.stage === "damage" && <Field label="Kto poškodenie vyrieši" value={draft.damageResolver} onChangeText={damageResolver => set({ damageResolver })} maxLength={300} editable={!locked} />}
      <Field label="Dôvod chýbajúceho údaja alebo fotky" value={draft.missingReason} onChangeText={missingReason => set({ missingReason })} multiline maxLength={1000} editable={!locked} />
    </FormSection>
    {problem && <View style={formLayout.notices}><ErrorNotice message={problem} /></View>}
    <View style={formLayout.actions}>
      <Button primary label={busy ? "Ukladám…" : "Uložiť doklad"} disabled={locked} onPress={() => { void save(); }} />
      {photo && <Button secondary label="Odstrániť fotografiu" disabled={locked} onPress={() => { setPhoto(null); setReference(null); }} />}
      <Button secondary label="Zrušiť" disabled={busy} onPress={onClose} />
    </View>
  </>;
}

type DriverField = keyof MobileTowingDriverFields;
const TEXT_FIELDS: readonly { key: Exclude<DriverField, "startedAt" | "finishedAt">; label: string; multiline?: boolean }[] = [
  { key: "destination", label: "Cieľ" }, { key: "performedQuantity", label: "Vykonané (množstvo, km, hodiny)" },
  { key: "driverNotes", label: "Poznámky k práci", multiline: true }, { key: "photoException", label: "Prečo chýbajú fotky (ak chýbajú)", multiline: true },
];
const NO_UPLOADS: UploadsView = { ready: false, enabled: false, busy: false, error: null, uploads: [] };
const quiet = () => () => undefined, noUploads = () => NO_UPLOADS;
function useUploads(uploads: TowingUploads | null): UploadsView {
  return useSyncExternalStore(uploads?.subscribe ?? quiet, uploads?.snapshot ?? noUploads, uploads?.snapshot ?? noUploads);
}

/** An unfinished towing upload kept on this phone: finish it with the same ids and bytes, or give it up. */
function UploadPanel({ upload, busy, onResume, onDiscard }: { upload: PendingUpload; busy: boolean; onResume: () => void; onDiscard: () => void }) {
  return <View style={formLayout.notices}>
    <Text style={styles.label}>{attachmentKindLabels[upload.kind] + ": " + upload.fileName}</Text>
    {upload.status === "sending" ? <Loading label="Nahrávam…" /> : <>
      {upload.message ? <ErrorNotice message={upload.message} />
        : <Text style={styles.muted}>{upload.missing ? "Súbor sa v telefóne už nenachádza. Nahrávanie zahoďte a prílohu pridajte znova."
          : "Nahrávanie sa nedokončilo. Dokončite ho s tou istou prílohou alebo ho zahoďte."}</Text>}
      {!upload.missing && <Button label="Dokončiť nahrávanie" disabled={busy} onPress={onResume} />}
      <Button secondary label="Zahodiť nahrávanie" disabled={busy} onPress={onDiscard} />
    </>}
  </View>;
}

function TowingDetail({ session, id, active }: { session: FieldWorkSession; id: string; active: boolean }) {
  const queryClient = useQueryClient();
  const detailKey = useMemo(() => [...session.key, "towing", id], [session.key, id]);
  const query = useQuery({ queryKey: detailKey, queryFn: ({ signal }) => session.api.towing(id, signal), refetchInterval: active ? 20_000 : false,
    structuralSharing: (previous, next) => newer(previous as MobileTowingOrder | undefined, next as MobileTowingOrder) });
  const commands = useSyncExternalStore(session.commands.subscribe, session.commands.snapshot, session.commands.snapshot);
  const target: WorkTarget = { kind: "towing", id };
  const pending = commands.pending.find(item => targetKey(item.target) === targetKey(target));
  const [edits, setEdits] = useState<MobileTowingDriverFields>({});
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState<"submitted" | "gone" | null>(null);
  const uploads = useUploads(session.uploads);
  const local = uploads.uploads.find(item => item.orderId === id.toLowerCase()) ?? null;
  const blocked = !commands.enabled || !commands.ready || commands.busy || Boolean(pending) || uploads.busy;
  const order = query.data && canUseDeliveryCache(query.error) ? query.data : undefined;
  // An upload the server already shows ready needs no local copy any more.
  useEffect(() => { if (order) void session.uploads?.settle(order); }, [order, session.uploads, uploads.ready]);
  function applied(result: unknown, type?: MobileTowingCommand["type"]) {
    const next = (result as { order: MobileTowingOrder | null }).order;
    void queryClient.invalidateQueries({ queryKey: [...session.key, "work"] });
    if (next) { queryClient.setQueryData<MobileTowingOrder>(detailKey, previous => newer(previous, next)); setEdits({}); }
    // Gone from the driver's list: handed over after Odovzdať, otherwise reassigned or cancelled meanwhile.
    else setLeft(type === "submit" ? "submitted" : "gone");
  }
  async function run(type: MobileTowingCommand["type"], label: string, payload: MobileTowingCommand["payload"] = {}): Promise<boolean> {
    if (!order || blocked) return false;
    setError(null);
    const result = await session.commands.start<{ order: MobileTowingOrder | null }>(target,
      { commandId: randomUUID(), type, expectedRevision: order.revision, assignmentGeneration: order.assignmentGeneration, payload }, label);
    if (result) applied(result, type); else void query.refetch();
    return Boolean(result);
  }
  const abandon = (attachment: MobileTowingAttachment) => Alert.alert("Zahodiť nedokončenú prílohu?", attachment.name + "\n\nPríloha sa nenahrala celá; po zahodení ju môžete pridať znova.", [
    { text: "Späť", style: "cancel" },
    { text: "Zahodiť", style: "destructive", onPress: () => { void run("abandon_attachment", "Zahodiť nedokončenú prílohu", { id: attachment.id, reason: "Nahrávanie z aplikácie sa nedokončilo." }); } }]);
  async function attach(kind: MobileTowingAttachment["kind"], source: "camera" | "gallery" | "file") {
    if (!order || !session.uploads) return;
    setError(null);
    try {
      const file = source === "file" ? await (await prepareDocumentPicker())() : await (await preparePhotoPicker())(source === "camera");
      // Ids and bytes are kept on the phone before sending; the same ids replay on the server,
      // so finishing it later (also after a restart) never makes a second attachment.
      if (file && await session.uploads.start({ orderId: id, attachmentId: randomUUID(), commandId: randomUUID(), kind, expectedRevision: order.revision,
        assignmentGeneration: order.assignmentGeneration, fileName: file.fileName, mimeType: file.mimeType, sizeBytes: file.bytes.length }, file.bytes)) void query.refetch();
    } catch (failure) { setError(errorText(failure, "Súbor sa nepodarilo načítať.")); }
  }
  const resume = (upload: PendingUpload) => { void session.uploads?.resume(upload.attachmentId).then(done => { if (done) void query.refetch(); }); };
  const discard = (upload: PendingUpload) => {
    const started = order?.attachments.some(item => item.id === upload.attachmentId && item.status === "pending");
    Alert.alert("Zahodiť nahrávanie?", upload.fileName + "\n\n" + (started ? "Nedokončená príloha sa zahodí aj v zákazke. " : "") + "Potom ju môžete pridať znova.", [
      { text: "Späť", style: "cancel" },
      { text: "Zahodiť", style: "destructive", onPress: () => { void (async () => {
        if (started && !await run("abandon_attachment", "Zahodiť nedokončenú prílohu", { id: upload.attachmentId, reason: "Nahrávanie z aplikácie sa nedokončilo." })) return;
        await session.uploads?.discard(upload.attachmentId);
      })(); } }]);
  };
  const choose = (kind: MobileTowingAttachment["kind"]) => Alert.alert(attachmentKindLabels[kind], undefined, [
    { text: kind === "scan" ? "Odfotiť papier" : "Odfotiť", onPress: () => { void attach(kind, "camera"); } },
    kind === "scan" ? { text: "Vybrať súbor", onPress: () => { void attach(kind, "file"); } } : { text: "Vybrať z galérie", onPress: () => { void attach(kind, "gallery"); } },
    { text: "Zrušiť", style: "cancel" }]);
  const panel = local && <UploadPanel upload={local} busy={uploads.busy || !uploads.enabled || commands.busy || Boolean(pending)} onResume={() => resume(local)} onDiscard={() => discard(local)} />;
  const recovery = <><StorageNotice commands={session.commands} state={commands} />
    {uploads.error && <View style={formLayout.notices}><ErrorNotice message={uploads.error} onRetry={!uploads.ready ? () => { void session.uploads?.load(); } : undefined} /></View>}
    {pending && <StepRecovery commands={session.commands} record={pending} busy={commands.busy || !commands.enabled}
      onResult={result => applied(result, (pending.command as MobileTowingCommand).type)} onReload={() => query.refetch()} />}</>;
  if (left) return <ScrollView contentContainerStyle={styles.content}>
    <Text accessibilityRole="header" style={styles.subheading}>{left === "submitted" ? "Zákazka je odovzdaná kancelárii" : "Zákazka už nie je vo vašom zozname"}</Text>
    <Text style={styles.muted}>{left === "submitted" ? "Kancelária ju skontroluje. Ak ju vráti na doplnenie, znova sa objaví v Mojej práci."
      : "Kancelária ju mohla prideliť inému vodičovi alebo zrušiť. Váš posledný krok sa uložil."}</Text>{panel}</ScrollView>;
  if (query.isPending) return <ScrollView contentContainerStyle={styles.content}>{recovery}<Loading label="Načítavam zákazku…" /></ScrollView>;
  if (!order) return <ScrollView contentContainerStyle={styles.content}>{recovery}
    <ErrorNotice message={errorText(query.error, "Zákazku sa nepodarilo načítať.")} onRetry={() => { void query.refetch(); }} />{panel}</ScrollView>;
  const f = order.fields, step = nextTowingStep(order), missing = step.type === "submit" ? towingMissing(order) : [];
  const phone = f.contact && dialable(f.contact) ? f.contact : f.customer?.phone ?? null;
  const value = (key: DriverField) => key in edits ? edits[key] ?? "" : f[key] ?? "";
  const changed = (Object.keys(edits) as DriverField[]).filter(key => (edits[key] ?? null) !== (f[key] ?? null));
  const confirmStep = () => {
    if (!step.confirm) { void run(step.type, step.label); return; }
    Alert.alert(step.label, step.confirm, [{ text: "Späť", style: "cancel" }, { text: step.label, onPress: () => { void run(step.type, step.label); } }]);
  };
  return <ScrollView contentContainerStyle={formLayout.content} keyboardShouldPersistTaps="handled">
    <DetailHeader title={serviceLabels[f.serviceType] + " · " + order.number} subtitle={[f.subjectDescription, f.plate].filter(Boolean).join(" · ") || null}
      tags={<Tag text={towingStatusLabels[order.workStatus]} tone={towingStatusTones[order.workStatus]} />} meta={f.plannedAt ? "Termín " + termLabel(f.plannedAt) : "Bez termínu"} />
    {recovery}
    {(error || query.isError || order.workStatus === "needs_changes") && <View style={formLayout.notices}>
      {order.workStatus === "needs_changes" && <Text style={styles.muted}>Kancelária vrátila zákazku na doplnenie. Doplňte údaje alebo fotky a odovzdajte ju znova.</Text>}
      {error && <ErrorNotice message={error} />}
      {query.isError && <ErrorNotice message="Údaje sa nepodarilo obnoviť. Zobrazený je posledný načítaný stav." onRetry={() => { void query.refetch(); }} />}
    </View>}
    <ActionBar actions={[
      { icon: Phone, label: "Zavolať", accessibilityLabel: "Zavolať kontaktu zákazky", disabled: !dialable(phone), onPress: () => call(phone, setError) },
      { icon: MapPin, label: "Nakládka", accessibilityLabel: "Navigovať na miesto nakládky", disabled: !f.pickup.trim(), onPress: () => navigate(f.pickup, setError) },
      { icon: Navigation, label: "Cieľ", accessibilityLabel: "Navigovať do cieľa", disabled: !f.destination?.trim(), onPress: () => navigate(f.destination, setError) },
      { icon: Camera, label: "Fotka", accessibilityLabel: "Pridať fotku práce", disabled: blocked || Boolean(local) || !uploads.ready, onPress: () => choose("work") },
    ]} />
    {!pending && <View style={formLayout.actions}>
      {missing.length > 0 && <Text style={styles.muted}>{"Pred odovzdaním doplňte: " + missing.join(", ") + "."}</Text>}
      <Button primary label={step.label} disabled={blocked || missing.length > 0 || changed.length > 0} onPress={confirmStep} />
      {changed.length > 0 && <Text style={styles.muted}>Najprv uložte zmenené údaje.</Text>}
    </View>}
    <SectionHeader title="Zákazka" />
    <Group>
      <InfoRow first label="Nakládka" value={f.pickup || null} />
      {order.workStatus === "assigned" && <InfoRow label="Cieľ" value={f.destination || null} empty="Neuvedený" />}
      <InfoRow label="Termín" value={termLabel(f.plannedAt)} />
      <InfoRow label="Vozidlo / predmet" value={[f.subjectDescription, f.plate, f.vin].filter(Boolean).join(" · ") || null} />
      <InfoRow label="Kontakt" value={f.customer?.name ?? null} detail={phone ? formatNumber(phone) : f.noContactReason} empty="Bez kontaktu" />
      {f.assistancePartnerName || f.assistanceReference ? <InfoRow label="Asistenčná služba" value={f.assistancePartnerName} detail={f.assistanceReference} /> : null}
      {f.parkingName ? <InfoRow label="Parkovisko" value={f.parkingName} detail={f.parkingAddress} /> : null}
    </Group>
    {order.workStatus !== "assigned" && <>
      <FormSection title="Priebeh práce" footer="Ceny a fakturáciu vedie kancelária na webe.">
        <Field label="Začiatok práce" value={value("startedAt") ? termLabel(value("startedAt")) : ""} placeholder="Nezaznamenaný" editable={false}
          action={<FieldAction icon={Clock} label="Teraz" accessibilityLabel="Začiatok práce teraz" disabled={blocked} onPress={() => setEdits(e => ({ ...e, startedAt: new Date().toISOString() }))} />} />
        <Field label="Koniec práce" value={value("finishedAt") ? termLabel(value("finishedAt")) : ""} placeholder="Nezaznamenaný" editable={false}
          action={<FieldAction icon={Clock} label="Teraz" accessibilityLabel="Koniec práce teraz" disabled={blocked} onPress={() => setEdits(e => ({ ...e, finishedAt: new Date().toISOString() }))} />} />
        {TEXT_FIELDS.map(item => <Field key={item.key} label={item.label} value={value(item.key)} multiline={item.multiline} maxLength={2000} editable={!blocked}
          onChangeText={text => setEdits(e => ({ ...e, [item.key]: text.trim() ? text : null }))} />)}
      </FormSection>
      <View style={formLayout.actions}><Button label="Uložiť údaje" disabled={blocked || changed.length === 0}
        onPress={() => { void run("update_order", "Uložiť údaje zákazky", { fields: Object.fromEntries(changed.map(key => [key, edits[key] ?? null])) }); }} /></View>
    </>}
    <SectionHeader title="Fotky a sken" detail={String(order.attachments.length)} />
    {order.attachments.length ? <Group>{order.attachments.map((item, index) => <InfoRow key={item.id} first={index === 0} label={attachmentKindLabels[item.kind] + " · " + termLabel(item.createdAt)}
      value={item.name} detail={item.status !== "pending" ? null : item.id === local?.attachmentId ? "Nedokončené – dokončite ho nižšie" : "Nahrávanie nedokončené"}
      actions={item.status === "pending" && item.id !== local?.attachmentId ? <Button secondary label="Zahodiť" disabled={blocked} onPress={() => abandon(item)} /> : null} />)}</Group> : <Text style={s.empty}>Zatiaľ bez príloh.</Text>}
    {panel}
    <View style={formLayout.actions}>
      {(["work", "handover", "scan"] as const).map(kind => <Button key={kind} secondary label={"Pridať: " + attachmentKindLabels[kind].toLowerCase()} disabled={blocked || Boolean(local) || !uploads.ready} onPress={() => choose(kind)} />)}
    </View>
  </ScrollView>;
}
