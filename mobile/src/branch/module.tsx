import { useState, useSyncExternalStore } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { randomUUID } from "expo-crypto";
import { Car, Navigation, Phone, Truck } from "lucide-react-native";
import type { MobileBranchCommand, MobileBranchGroup, MobileBranchRequest } from "../../../src/lib/mobile-api";
import { MobileApiError } from "../lib/api";
import { dialable, formatNumber } from "../lib/display";
import { useAndroidBack } from "../lib/use-android-back";
import { directionsUrl } from "../cases/maps";
import { ActionBar, DetailHeader, InfoRow, Tag } from "../design/detail";
import { FormSection, SelectRow, formLayout } from "../design/form";
import { Group, SectionHeader } from "../design/list";
import { palette, space, type } from "../design/tokens";
import { useShellBack } from "../shell/back";
import { Segmented } from "../shell/parts";
import { Button, ErrorNotice, Loading, styles } from "../ui";
import type { BranchSnapshot } from "../field-work/api";
import { targetKey, type WorkTarget } from "../field-work/commands";
import { isLate, termLabel } from "../field-work/model";
import { useDeliveryTime } from "../delivery/use-delivery-time";
import { StepRecovery, StorageNotice, fieldStyles } from "../field-work/parts";
import type { FieldWorkSession } from "../field-work/session";
import { branchActions, branchKindLabels, branchState, branchStateLabels, branchStateTones, executors, sortRequests, waiting } from "./model";

export type BranchOpenRequest = { id: string; nonce: number };
const errorText = (error: unknown, fallback: string) => error instanceof MobileApiError ? error.message : fallback;

/** Pobočka for a local lead: the queue to claim, Prevziať, Prideliť an executor of the
 * group and the running work. Reports and settings stay on the web. */
export function BranchModule({ session, active, visible, openRequest }: { session: FieldWorkSession | null; active: boolean; visible: boolean; openRequest: BranchOpenRequest | null }) {
  const [view, setView] = useState<"open" | "done">("open");
  const [selected, setSelected] = useState<string | null>(null);
  const [handled, setHandled] = useState<number | null>(null);
  if (openRequest && openRequest.nonce !== handled) { setHandled(openRequest.nonce); setSelected(openRequest.id); setView("open"); }
  const back = () => setSelected(null);
  useShellBack(visible && selected !== null, "Pobočka", back);
  useAndroidBack(active && visible && selected !== null, back);
  const done = useQuery({ queryKey: [...(session?.key ?? []), "branch", "done", session?.memberId], enabled: Boolean(session) && visible && view === "done",
    queryFn: ({ signal }) => session!.api.branch("done", signal), refetchInterval: active && visible ? 60_000 : false });
  if (!session) return <View style={styles.content}><Loading label="Overujem prístup k pobočke…" /></View>;
  const query = view === "open" ? session.branch : done;
  const snapshot = query.data;
  if (selected) {
    const request = session.branch.data?.requests.find(item => item.id === selected) ?? done.data?.requests.find(item => item.id === selected);
    return <RequestDetail key={selected} session={session} id={selected} request={request ?? null} groups={snapshot?.groups ?? session.branch.data?.groups ?? []}
      canOperateTowing={session.branch.data?.canOperateTowing ?? false} loading={session.branch.isPending} onReload={() => session.branch.refetch()} />;
  }
  return <BranchList session={session} active={active && visible} view={view} onView={setView} snapshot={snapshot} error={query.isError ? query.error : null} pending={query.isPending}
    fetching={query.isFetching} onRefresh={() => { void query.refetch(); }} onOpen={setSelected} />;
}

function BranchList({ session, active, view, onView, snapshot, error, pending, fetching, onRefresh, onOpen }: {
  session: FieldWorkSession; active: boolean; view: "open" | "done"; onView: (view: "open" | "done") => void; snapshot: BranchSnapshot | undefined; error: unknown; pending: boolean; fetching: boolean;
  onRefresh: () => void; onOpen: (id: string) => void;
}) {
  const now = useDeliveryTime(active);
  const commands = useSyncExternalStore(session.commands.subscribe, session.commands.snapshot, session.commands.snapshot);
  const unconfirmed = commands.pending.filter(item => item.target.kind === "branch");
  const requests = sortRequests(snapshot?.requests ?? []);
  const queue = requests.filter(waiting), running = requests.filter(item => !waiting(item));
  const queued = session.branch.data ? session.branch.data.requests.filter(waiting).length : null;
  return <ScrollView contentContainerStyle={formLayout.content}>
    <View style={s.header}>
      <Text accessibilityRole="header" style={s.title}>Pobočka</Text>
      <Segmented accessibilityLabel="Zobrazenie pobočky" value={view} onChange={onView} items={[{ id: "open", label: "Otvorené", badge: queued }, { id: "done", label: "Hotové" }]} />
    </View>
    <StorageNotice commands={session.commands} state={commands} />
    {unconfirmed.length > 0 && <>
      <SectionHeader title="Nepotvrdené kroky" detail={String(unconfirmed.length)} />
      <View style={formLayout.actions}>{unconfirmed.map(record => <Button key={targetKey(record.target)} secondary label={"Overiť krok: " + record.label} onPress={() => onOpen(record.target.id)} />)}</View>
    </>}
    {Boolean(error) && <View style={formLayout.notices}><ErrorNotice message={errorText(error, "Pobočku sa nepodarilo načítať.")} onRetry={onRefresh} /></View>}
    {pending ? <Loading label="Načítavam pobočku…" /> : snapshot && <>
      {view === "open" && snapshot.groups.length > 0 && <>
        <SectionHeader title={snapshot.groups.length === 1 ? "Moja pobočka" : "Moje pobočky"} />
        <Group>{snapshot.groups.map((group, index) => <InfoRow key={group.id} first={index === 0} label={group.name}
          value={group.counts.queued + " čaká · " + group.counts.claimed + " prevzaté · " + group.counts.active + " prebieha"}
          detail={[group.counts.overdue ? group.counts.overdue + " po termíne" : null, group.receivesNew ? "Prijímate novú prácu" : null].filter(Boolean).join(" · ") || null} />)}</Group>
      </>}
      {view === "open" ? <>
        <SectionHeader title="Na prevzatie a pridelenie" detail={queue.length ? String(queue.length) : null} />
        {queue.length ? <Group>{queue.map((item, index) => <RequestRow key={item.id} request={item} first={index === 0} now={now} onOpen={onOpen} />)}</Group>
          : <Text style={fieldStyles.empty}>Nič nečaká. Novú požiadavku pošle centrála; príde aj notifikácia.</Text>}
        <SectionHeader title="Prebiehajúca práca" detail={running.length ? String(running.length) : null} />
        {running.length ? <Group>{running.map((item, index) => <RequestRow key={item.id} request={item} first={index === 0} now={now} onOpen={onOpen} />)}</Group>
          : <Text style={fieldStyles.empty}>Žiadna pridelená práca neprebieha.</Text>}
      </> : <>
        <SectionHeader title="Hotové a zrušené" detail={requests.length ? String(requests.length) : null} />
        {requests.length ? <Group>{requests.map((item, index) => <RequestRow key={item.id} request={item} first={index === 0} now={now} onOpen={onOpen} />)}</Group>
          : <Text style={fieldStyles.empty}>Zatiaľ nič.</Text>}
      </>}
    </>}
    <Text style={fieldStyles.note}>Reporty a nastavenie pobočky sú na webe v module Pobočky.</Text>
    {!error && <View style={formLayout.actions}><Button label={fetching ? "Obnovujem…" : "Obnoviť"} secondary disabled={fetching} onPress={onRefresh} /></View>}
  </ScrollView>;
}

function RequestRow({ request, first, now, onOpen }: { request: MobileBranchRequest; first: boolean; now: number; onOpen: (id: string) => void }) {
  const state = branchState(request), title = branchKindLabels[request.kind] + (request.vehicle ? " · " + request.vehicle : "");
  const tow = request.kind === "tow", Icon = tow ? Truck : Car;
  const late = isLate(request.dueAt, now) && (state === "queued" || state === "claimed" || state === "assigned");
  const holder = request.status === "claimed" ? request.claimedByMe ? "Prevzali ste" : "Prevzal(a) " + (request.claimedByName ?? "kolega") : request.execution?.assignee ?? null;
  return <Pressable accessibilityRole="button" accessibilityLabel={"Otvoriť " + title + ", " + branchStateLabels[state]} onPress={() => onOpen(request.id)}
    style={({ pressed }) => [fieldStyles.row, pressed && { backgroundColor: "#ECECF0" }]}>
    {!first && <View style={fieldStyles.separator} />}
    <View style={[fieldStyles.icon, { backgroundColor: tow ? palette.orangeSoft : palette.blueSoft }]}>
      <Icon size={19} strokeWidth={2.2} color={tow ? palette.orangeText : palette.blueText} accessible={false} /></View>
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <Text numberOfLines={2} style={fieldStyles.rowTitle}>{title}</Text>
      <View style={fieldStyles.rowHead}><Tag text={branchStateLabels[state]} tone={branchStateTones[state]} />{late && <Tag text="Po termíne" tone="red" />}
        <Text numberOfLines={1} style={[fieldStyles.rowDetail, { flexShrink: 1 }]}>{termLabel(request.dueAt)}</Text></View>
      <Text numberOfLines={2} style={fieldStyles.rowDetail}>{[[request.pickup, request.destination].filter(Boolean).join(" → "), holder].filter(Boolean).join(" · ") || request.groupName}</Text>
    </View>
    <Text style={fieldStyles.chevron}>›</Text>
  </Pressable>;
}

function RequestDetail({ session, id, request, groups, canOperateTowing, loading, onReload }: {
  session: FieldWorkSession; id: string; request: MobileBranchRequest | null; groups: readonly MobileBranchGroup[]; canOperateTowing: boolean; loading: boolean; onReload: () => Promise<unknown>;
}) {
  const queryClient = useQueryClient();
  const commands = useSyncExternalStore(session.commands.subscribe, session.commands.snapshot, session.commands.snapshot);
  const target: WorkTarget = { kind: "branch", id };
  const pending = commands.pending.find(item => targetKey(item.target) === targetKey(target));
  const [assignee, setAssignee] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [latest, setLatest] = useState<MobileBranchRequest | null>(null);
  const shown = latest && (!request || latest.revision >= request.revision) ? latest : request;
  const blocked = !commands.enabled || !commands.ready || commands.busy || Boolean(pending);
  function applied(result: unknown) {
    const next = result as MobileBranchRequest;
    setLatest(next); setAssignee(null);
    queryClient.setQueryData<BranchSnapshot>([...session.key, "branch", "open", session.memberId], snapshot => snapshot
      ? { ...snapshot, requests: snapshot.requests.map(item => item.id === next.id && item.revision <= next.revision ? next : item) } : snapshot);
    void queryClient.invalidateQueries({ queryKey: [...session.key, "branch"] });
    void queryClient.invalidateQueries({ queryKey: [...session.key, "work"] });
  }
  async function run(action: MobileBranchCommand["action"], label: string, payload: Record<string, unknown> = {}) {
    if (!shown || blocked) return;
    setError(null);
    const result = await session.commands.start<MobileBranchRequest>(target, { commandId: randomUUID(), action, requestId: shown.id, expectedRevision: shown.revision, payload }, label);
    if (result) applied(result); else void onReload();
  }
  const recovery = <><StorageNotice commands={session.commands} state={commands} />
    {pending && <StepRecovery commands={session.commands} record={pending} busy={commands.busy || !commands.enabled} onResult={applied} onReload={onReload} />}</>;
  if (!shown) return <ScrollView contentContainerStyle={styles.content}>{recovery}
    {loading ? <Loading label="Načítavam požiadavku…" /> : <ErrorNotice message="Požiadavka už nie je medzi otvorenými prácami pobočky." onRetry={() => { void onReload(); }} />}</ScrollView>;
  const state = branchState(shown), actions = branchActions(shown, canOperateTowing), people = executors(groups, shown);
  const phone = shown.customer?.phone || null, execution = shown.execution;
  const openUrl = (url: () => string) => { try { void Linking.openURL(url()).catch(() => setError("Odkaz sa nepodarilo otvoriť.")); } catch { setError("Odkaz sa nepodarilo otvoriť."); } };
  return <ScrollView contentContainerStyle={formLayout.content} keyboardShouldPersistTaps="handled">
    <DetailHeader title={branchKindLabels[shown.kind] + (shown.vehicle ? " · " + shown.vehicle : "")} subtitle={[shown.pickup, shown.destination].filter(Boolean).join(" → ") || null}
      tags={<Tag text={branchStateLabels[state]} tone={branchStateTones[state]} />} meta={shown.groupName + " · prišlo " + termLabel(shown.routedAt)} />
    {recovery}
    {error && <View style={formLayout.notices}><ErrorNotice message={error} /></View>}
    <ActionBar actions={[
      { icon: Phone, label: "Zavolať", accessibilityLabel: "Zavolať klientovi", disabled: !dialable(phone), onPress: () => { if (phone) openUrl(() => "tel:" + phone.replace(/[^\d+]/g, "")); } },
      { icon: Navigation, label: "Navigovať", accessibilityLabel: "Navigovať na miesto vyzdvihnutia", disabled: !shown.pickup.trim(), onPress: () => openUrl(() => directionsUrl(shown.pickup)) },
    ]} />
    {!pending && <View style={formLayout.actions}>
      {actions.claim && <Button primary label="Prevziať" disabled={blocked} onPress={() => { void run("claim", "Prevziať"); }} />}
      {actions.createTow && <Button primary label="Založiť odťahovú zákazku" disabled={blocked} onPress={() => { void run("materialize", "Založiť odťahovú zákazku"); }} />}
      {actions.towOfficeOnly && <Text style={styles.muted}>Odťahovú zákazku zakladá účet odťahovej kancelárie. Požiadavku môžete uvoľniť pre kolegu.</Text>}
      {actions.reopen && <Button primary label="Znovu otvoriť požiadavku" disabled={blocked} onPress={() => { void run("reopen", "Znovu otvoriť"); }} />}
      {shown.status === "claimed" && !shown.claimedByMe && <Text style={styles.muted}>{"Požiadavku prevzal(a) " + (shown.claimedByName ?? "kolega") + "."}</Text>}
    </View>}
    {actions.assign && !pending && <>
      <FormSection title={actions.assign === "materialize" ? "Prideliť vykonávateľa" : "Zmeniť vykonávateľa"} footer={people.length ? "Vykonávateľ dostane prácu v Mojej práci." : null}>
        {people.length ? people.map(member => <SelectRow key={member.id} label={member.name} detail={member.role === "lead" ? "Miestny dispečer" : null}
          selected={assignee === member.id} disabled={blocked || execution?.assigneeId === member.id} onPress={() => setAssignee(member.id)} />)
          : <SelectRow label="V pobočke nie je nikto s oprávnením na jazdy" selected={false} disabled onPress={() => undefined} />}
      </FormSection>
      <View style={formLayout.actions}>
        <Button primary label="Prideliť" disabled={blocked || !assignee} onPress={() => {
          if (!assignee) return;
          if (actions.assign === "materialize") void run("materialize", "Prideliť", { assigneeId: assignee });
          else if (execution) void run("operate", "Zmeniť vykonávateľa", { command: { action: "assign", expectedRevision: execution.revision, payload: { assigneeId: assignee } } });
        }} />
      </View>
    </>}
    {actions.release && !pending && <View style={formLayout.actions}><Button secondary label="Uvoľniť požiadavku" disabled={blocked} onPress={() => { void run("release", "Uvoľniť"); }} /></View>}
    <SectionHeader title="Požiadavka" />
    <Group>
      <InfoRow first label="Termín" value={termLabel(shown.dueAt)} />
      <InfoRow label="Odkiaľ" value={shown.pickup || null} empty="Neuvedené" />
      <InfoRow label="Kam" value={shown.destination || null} empty="Neuvedené" />
      <InfoRow label="Prípad" value={shown.caseNumber} empty="Bez prípadu" />
      <InfoRow label="Klient" value={shown.customer?.name || null} detail={phone ? formatNumber(phone) : null} empty="Bez kontaktu" />
      <InfoRow label="Vozidlo" value={shown.vehicle} empty="Neurčené" />
      <InfoRow label="Pokyn centrály" value={shown.note || null} empty="Bez pokynu" />
      <InfoRow label="Pobočka" value={shown.groupName} />
      <InfoRow label="Prevzal(a)" value={shown.claimedByName} detail={shown.claimedAt ? termLabel(shown.claimedAt) : null} empty="Nikto" />
    </Group>
    {execution && <>
      <SectionHeader title={execution.owner === "towing_order" ? "Odťahová zákazka" : "Jazda"} />
      <Group>
        <InfoRow first label="Vykonávateľ" value={execution.assignee} empty={execution.owner === "towing_order" ? "Vodiča pridelí odťahová kancelária" : "Nepridelené"} />
        <InfoRow label="Stav" value={branchStateLabels[state]} />
        <InfoRow label="Začiatok" value={execution.startedAt ? termLabel(execution.startedAt) : null} empty="Ešte nezačala" />
        {execution.finishedAt ? <InfoRow label="Koniec" value={termLabel(execution.finishedAt)} /> : null}
      </Group>
    </>}
  </ScrollView>;
}

const s = StyleSheet.create({
  header: { paddingHorizontal: space.l, paddingTop: 2, paddingBottom: space.xs, gap: space.s },
  title: { ...type.title, color: palette.label },
});
