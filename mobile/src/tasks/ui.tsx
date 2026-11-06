import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { FlatList, Keyboard, KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { randomUUID } from "expo-crypto";
import { ArrowRight, CheckCircle2, Circle, Clock3, Search } from "lucide-react-native";
import type { EmployeeTask, TaskWorkspaceTarget, TaskWorkspaceView } from "../../../src/lib/mobile-task-workspace";
import type { MobileConfig } from "../lib/config";
import { useAndroidBack } from "../lib/use-android-back";
import { useShellBack } from "../shell/back";
import { Button, Card, ErrorNotice, Loading } from "../ui";
import { ChoiceField, Field, FormSection, PickerRow, SelectRow, formLayout } from "../design/form";
import { DetailHeader, InfoRow, Tag, type TagTone } from "../design/detail";
import { Group, Row, SectionHeader } from "../design/list";
import { palette, radius, space, type } from "../design/tokens";
import { NAVIGATION_CONTENT_BOTTOM } from "../ui/theme";
import { createEmployeeTasksApi } from "./api";
import { EmployeeTasksStore, type EmployeeTaskCommandDraft } from "./store";
import { customDueDate, duePreset, taskDueLabel, taskOverdue, taskPriorityLabels, taskRecipientLabel, taskStateLabels } from "./presentation";

export type EmployeeTasksProps = {
  config: MobileConfig; getToken: () => Promise<string | null>; userId: string; organizationId?: string;
  active: boolean; store?: EmployeeTasksStore; onOpenCase?: (id: string) => void; onLeave?: () => void;
  openTaskRequest?: { taskId: string | null; nonce: number };
};
type Page = { kind: "list" } | { kind: "create" } | { kind: "detail"; id: string }
  | { kind: "target"; returnTo: "create" | "detail"; task?: EmployeeTask }
  | { kind: "due" };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Úlohy sa nepodarilo načítať. Skúste znova.";
const tones: Record<EmployeeTask["state"], TagTone> = { todo: "gray", in_progress: "blue", in_review: "orange", done: "green" };

export function EmployeeTasks(props: EmployeeTasksProps) {
  return <EmployeeTasksWorkspace key={[props.config.environment, props.userId, props.organizationId ?? ""].join(":")} {...props} />;
}

function EmployeeTasksWorkspace({ store: supplied, ...props }: EmployeeTasksProps) {
  const [store] = useState(() => supplied ?? new EmployeeTasksStore(
    createEmployeeTasksApi(props.config, props.getToken, props.userId, props.organizationId), props.userId, { id: randomUUID }));
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const cache = useQueryClient();
  const prefix = useMemo(() => ["employee-tasks", props.config.environment, props.userId, props.organizationId ?? ""], [props.config.environment, props.userId, props.organizationId]);
  const [page, setPage] = useState<Page>({ kind: "list" });
  const [handled, setHandled] = useState<string | null>(null);
  const requested = props.openTaskRequest;
  const requestKey = requested ? requested.nonce + ":" + (requested.taskId ?? "create") : null;
  if (requestKey !== null && requestKey !== handled) {
    setHandled(requestKey);
    setPage(requested?.taskId ? { kind: "detail", id: requested.taskId } : { kind: "list" });
  }
  useEffect(() => store.api.subscribeAccessLoss(() => { void cache.cancelQueries({ queryKey: prefix }); cache.removeQueries({ queryKey: prefix }); }), [store, cache, prefix]);
  useEffect(() => () => { if (!supplied) store.dispose(); }, [supplied, store]);
  const refresh = () => { void cache.invalidateQueries({ queryKey: prefix }); };
  const saved = (id: string) => { refresh(); setPage({ kind: "detail", id }); };
  const startCreate = () => { store.beginCreate(); setPage({ kind: "create" }); };
  const back = () => setPage(page.kind === "target" && page.returnTo === "detail" && page.task ? { kind: "detail", id: page.task.id } : page.kind === "target" || page.kind === "due" ? { kind: "create" } : { kind: "list" });
  useAndroidBack(props.active && page.kind === "list" && Boolean(props.onLeave), () => props.onLeave?.());
  if (state.revoked) return <ScrollView contentContainerStyle={s.content}><ErrorNotice message="Prístup k úlohám sa zmenil. Obnovte prihlásenie, aby sa overili aktuálne oprávnenia." /></ScrollView>;
  if (page.kind === "target") {
    const selected = page.returnTo === "create" ? state.create.input.target : page.task?.assignee ? { kind: "person" as const, userId: page.task.assignee.userId } : page.task?.group ? { kind: "group" as const, groupId: page.task.group.id } : null;
    return <TargetPicker store={store} queryKey={prefix} active={props.active} selected={selected} onBack={back}
      busy={Boolean(page.task && store.commandState(page.task.id).status === "saving")}
      error={page.task ? store.commandState(page.task.id).error : null}
      onSelect={async (target, label) => {
        if (page.returnTo === "create") { store.editCreate({ target, targetLabel: label }); setPage({ kind: "create" }); }
        else if (page.task) {
          const receipt = await store.command(page.task.id, { action: "assign", target, expectedRevision: page.task.revision });
          if (receipt) saved(receipt.task.id);
          else if (store.commandState(page.task.id).status === "uncertain") setPage({ kind: "detail", id: page.task.id });
        }
      }} />;
  }
  if (page.kind === "due") return <DuePicker active={props.active} current={state.create.input.dueAt ?? null} onBack={back} onSelect={dueAt => { store.editCreate({ dueAt }); setPage({ kind: "create" }); }} />;
  if (page.kind === "create") return <CreateTask store={store} active={props.active} onBack={back} onSaved={saved}
    onTarget={() => setPage({ kind: "target", returnTo: "create" })} onDue={() => setPage({ kind: "due" })} />;
  if (page.kind === "detail") return <TaskDetail key={page.id} id={page.id} store={store} queryKey={prefix} active={props.active} onBack={back} onChanged={refresh}
    onAssign={task => setPage({ kind: "target", returnTo: "detail", task })} onOpenCase={props.onOpenCase} />;
  return <TaskList store={store} queryKey={prefix} active={props.active} onCreate={startCreate} onOpen={id => setPage({ kind: "detail", id })} />;
}

function TaskChoice({ label, selected, onPress, disabled }: { label: string; selected: boolean; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected, disabled: Boolean(disabled) }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [s.choice, selected && s.choiceSelected, pressed && { opacity: 0.7 }, disabled && { opacity: 0.5 }]}>
    <Text style={[s.choiceText, selected && s.choiceSelectedText]}>{label}</Text>
  </Pressable>;
}

function TaskList({ store, queryKey, active, onCreate, onOpen }: { store: EmployeeTasksStore; queryKey: string[]; active: boolean; onCreate: () => void; onOpen: (id: string) => void }) {
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const [view, setView] = useState<TaskWorkspaceView>("mine");
  const [done, setDone] = useState(false), [search, setSearch] = useState(""), [q, setQuery] = useState("");
  useEffect(() => { const id = setTimeout(() => setQuery(search.trim()), 250); return () => clearTimeout(id); }, [search]);
  const pendingSearch = q !== search.trim();
  const query = useInfiniteQuery({ queryKey: [...queryKey, "list", view, done, q], enabled: active && !pendingSearch,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => store.api.list({ view, category: done ? "done" : "open", q, cursor: pageParam }, signal),
    getNextPageParam: page => page.nextCursor ?? undefined,
    refetchInterval: active ? 60_000 : false,
  });
  const tasks = [...new Map(query.data?.pages.flatMap(page => page.tasks).map(task => [task.id, task]) ?? []).values()];
  const draft = state.create;
  const resume = draft.status !== "saved" && (draft.input.title.trim() || draft.status === "uncertain");
  const hints: Record<TaskWorkspaceView, string> = { mine: "Čo máte na starosti vy.", branch: "Úlohy pre pobočky, ktoré vediete.", created: "Úlohy, ktoré ste zadali kolegom alebo pobočke.", review: "Úlohy, pri ktorých ste kontrolórom." };
  const blocked = pendingSearch || query.isPending || query.isError && !query.isFetchNextPageError;
  return <FlatList data={blocked ? [] : tasks} keyExtractor={task => task.id} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={s.content}
    refreshControl={<RefreshControl refreshing={query.isRefetching && !query.isFetchingNextPage} onRefresh={() => { if (!pendingSearch) void query.refetch(); }} />}
    renderItem={({ item }) => <View style={s.taskGroup}><TaskRow task={item} first onPress={() => onOpen(item.id)} /></View>}
    ListHeaderComponent={<View style={s.listHeader}>
    <View style={s.headingRow}><Text accessibilityRole="header" style={s.heading}>Úlohy</Text><Button primary label="+ Nová úloha" onPress={onCreate} /></View>
    <Text style={s.muted}>Jednoducho zadať. Jasne vidieť, kto rieši.</Text>
    {resume ? <Card><Text style={s.rowTitle}>{draft.status === "uncertain" ? "Vytvorenie čaká na overenie" : "Máte rozpracovanú úlohu"}</Text>
      {draft.input.title ? <Text style={s.body}>{draft.input.title}</Text> : null}<Button label={draft.status === "uncertain" ? "Overiť pôvodné vytvorenie" : "Pokračovať v úlohe"} secondary onPress={onCreate} /></Card> : null}
    <View style={s.choices}>{([["mine", "Moje"], ["branch", "Pobočka"], ["created", "Zadané mnou"]] as const).map(([value, label]) => <TaskChoice key={value} label={label} selected={view === value} onPress={() => setView(value)} />)}</View>
    <View style={s.search}><Search size={18} color={palette.secondaryLabel} accessible={false} /><TextInput accessibilityLabel="Hľadať úlohu" placeholder="Hľadať úlohu" placeholderTextColor={palette.tertiaryLabel}
      value={search} onChangeText={setSearch} maxLength={200} returnKeyType="search" autoCorrect={false} style={s.searchInput} /></View>
    <View style={s.filterRow}><View style={s.choices}><TaskChoice label="Na kontrolu" selected={view === "review"} onPress={() => setView(view === "review" ? "mine" : "review")} />
      <TaskChoice label="Hotové" selected={done} onPress={() => setDone(!done)} /></View><Text style={s.caption}>{hints[view]}</Text></View>
    </View>}
    ListEmptyComponent={pendingSearch || query.isPending ? <Loading label="Načítavam úlohy…" /> : query.isError && !query.isFetchNextPageError ? <ErrorNotice message={errorMessage(query.error)} onRetry={() => { void query.refetch(); }} /> :
      <Card><CheckCircle2 size={30} color={palette.secondaryLabel} accessible={false} /><Text style={s.rowTitle}>{q ? "Nenašla sa žiadna úloha" : done ? "Zatiaľ bez hotových úloh" : "Tu je všetko vybavené"}</Text>
        <Text style={s.muted}>{q ? "Skúste kratší názov alebo iný výber." : view === "branch" ? "Keď niekto zadá úlohu vašej pobočke, nájdete ju tu." : "Novú úlohu pre seba, kolegu alebo pobočku vytvoríte hore."}</Text></Card>}
    ListFooterComponent={!blocked ? <View style={s.listFooter}>
      {query.isFetchNextPageError ? <ErrorNotice message={errorMessage(query.error)} onRetry={() => { void query.fetchNextPage(); }} /> : null}
      {query.hasNextPage ? <Button label={query.isFetchingNextPage ? "Načítavam…" : "Ďalšie úlohy"} secondary disabled={query.isFetchingNextPage} onPress={() => { void query.fetchNextPage(); }} /> : null}
    </View> : null} />;
}

export function TaskRow({ task, first, onPress }: { task: EmployeeTask; first?: boolean; onPress: () => void }) {
  const overdue = taskOverdue(task), Icon = task.state === "done" ? CheckCircle2 : task.state === "in_review" ? Clock3 : Circle;
  const recipient = taskRecipientLabel(task);
  return <Pressable accessibilityRole="button" accessibilityLabel={[task.title, taskStateLabels[task.state], recipient, overdue ? "Po termíne" : null, taskDueLabel(task.dueAt)].filter(Boolean).join(". ")}
    onPress={onPress} style={({ pressed }) => [s.taskRow, pressed && { backgroundColor: palette.fill }]}>
    {!first ? <View style={s.separator} /> : null}
    <Icon size={22} strokeWidth={1.8} color={task.state === "done" ? palette.greenText : palette.secondaryLabel} accessible={false} />
    <View style={s.grow}><Text style={s.rowTitle}>{task.title}</Text><Text style={s.caption}>{recipient}</Text>
      <View style={s.taskMeta}><Tag text={taskStateLabels[task.state]} tone={tones[task.state]} />{task.dueAt ? <Text style={[s.caption, overdue && s.overdue]}>{overdue ? "Po termíne · " : ""}{taskDueLabel(task.dueAt)}</Text> : null}</View>
    </View><ArrowRight size={17} color={palette.tertiaryLabel} accessible={false} />
  </Pressable>;
}

function CreateTask({ store, active, onBack, onSaved, onTarget, onDue }: { store: EmployeeTasksStore; active: boolean; onBack: () => void; onSaved: (id: string) => void; onTarget: () => void; onDue: () => void }) {
  const { create: state } = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const [more, setMore] = useState(Boolean(state.input.description || state.input.priority !== "normal"));
  const saving = state.status === "saving", editable = state.status === "editing";
  useShellBack(active, "Úlohy", onBack, saving);
  useAndroidBack(active && !saving, onBack);
  const submit = async (retry = false) => { Keyboard.dismiss(); const receipt = await (retry ? store.retryCreate() : store.create()); if (receipt) onSaved(receipt.task.id); };
  return <KeyboardAvoidingView style={s.fill} behavior={Platform.OS === "ios" ? "padding" : undefined}><ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={formLayout.content}>
    <View style={formLayout.head}><Text accessibilityRole="header" style={s.heading}>Nová úloha</Text><Text style={s.muted}>Čo treba urobiť a komu to patrí.</Text></View>
    <FormSection><Field label="Čo treba urobiť?" placeholder="Napr. pripraviť auto na zajtra" value={state.input.title} onChangeText={title => store.editCreate({ title })} maxLength={500} multiline editable={editable} autoFocus />
      <PickerRow label="Komu" value={state.input.targetLabel} onPress={onTarget} disabled={!editable} />
      <PickerRow label="Termín" value={taskDueLabel(state.input.dueAt ?? null)} onPress={onDue} disabled={!editable} /></FormSection>
    <View style={s.inset}><TaskChoice label={more ? "Skryť ďalšie možnosti" : "Ďalšie možnosti"} selected={more} onPress={() => setMore(!more)} disabled={!editable} /></View>
    {more ? <FormSection title="Podrobnosti"><Field label="Popis (voliteľný)" placeholder="Čo má kolega vedieť?" multiline value={state.input.description ?? ""} onChangeText={description => store.editCreate({ description })} maxLength={10_000} editable={editable} />
      <ChoiceField label="Priorita">{(["normal", "high", "urgent", "low"] as const).map(priority => <TaskChoice key={priority} label={taskPriorityLabels[priority]} selected={state.input.priority === priority} onPress={() => store.editCreate({ priority })} disabled={!editable} />)}</ChoiceField></FormSection> : null}
    <View style={formLayout.actions}>{state.error ? <ErrorNotice message={state.error} /> : null}
      {state.status === "uncertain" ? <Button primary label="Overiť pôvodné vytvorenie" onPress={() => { void submit(true); }} /> : state.status === "saved" && state.receipt ? <Button primary label="Otvoriť vytvorenú úlohu" onPress={() => onSaved(state.receipt!.task.id)} /> :
        <Button primary label={saving ? "Vytváram…" : "Vytvoriť úlohu"} disabled={!editable || !state.input.title.trim()} onPress={() => { void submit(); }} />}
      {editable && state.input.title ? <Button secondary label="Zahodiť koncept" onPress={() => { store.discardCreate(); onBack(); }} /> : null}
      <Text style={s.caption}>Úloha zostane uložená aj bez pripojenia ku konkrétnemu prípadu.</Text>
    </View>
  </ScrollView></KeyboardAvoidingView>;
}

function TargetPicker({ store, queryKey, active, selected, onBack, onSelect, busy, error }: {
  store: EmployeeTasksStore; queryKey: string[]; active: boolean; selected: TaskWorkspaceTarget | null; onBack: () => void;
  onSelect: (target: TaskWorkspaceTarget, label: string) => Promise<void>; busy?: boolean; error?: string | null;
}) {
  const [kind, setKind] = useState<"person" | "group">(selected?.kind ?? "person");
  const [search, setSearch] = useState(""), [q, setQuery] = useState("");
  useEffect(() => { const id = setTimeout(() => setQuery(search.trim()), 250); return () => clearTimeout(id); }, [search]);
  const query = useQuery({ queryKey: [...queryKey, "directory", q], queryFn: ({ signal }) => store.api.directory(q, signal), enabled: active });
  useShellBack(active, "Úloha", onBack, busy);
  useAndroidBack(active && !busy, onBack);
  const pending = q !== search.trim();
  const groups = query.data?.groups.filter(group => !q || group.name.toLocaleLowerCase("sk-SK").includes(q.toLocaleLowerCase("sk-SK"))) ?? [];
  return <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={s.content}>
    <Text accessibilityRole="header" style={s.heading}>Komu patrí úloha?</Text><Text style={s.muted}>Vyberte kolegu alebo ju pošlite pobočke na pridelenie.</Text>
    <View style={s.choices}><TaskChoice label="Kolega" selected={kind === "person"} onPress={() => setKind("person")} disabled={busy} /><TaskChoice label="Pobočka" selected={kind === "group"} onPress={() => setKind("group")} disabled={busy} /></View>
    <View style={s.search}><Search size={18} color={palette.secondaryLabel} accessible={false} /><TextInput accessibilityLabel={kind === "person" ? "Hľadať kolegu" : "Hľadať pobočku"} placeholder={kind === "person" ? "Meno kolegu" : "Názov pobočky"} value={search} onChangeText={setSearch} maxLength={200} style={s.searchInput} editable={!busy} autoCorrect={false} /></View>
    {error ? <ErrorNotice message={error} /> : null}
    {pending || query.isPending ? <Loading /> : query.isError ? <ErrorNotice message={errorMessage(query.error)} onRetry={() => { void query.refetch(); }} /> : <>
      {kind === "person" ? <View style={s.taskGroup}>{query.data?.people.map(person => <SelectRow key={person.userId} label={person.displayName + (person.userId === store.userId ? " (ja)" : "")}
        selected={selected?.kind === "person" && selected.userId === person.userId} onPress={() => { void onSelect({ kind: "person", userId: person.userId }, person.userId === store.userId ? "Ja" : person.displayName); }} disabled={busy} />)}</View> :
        <View style={s.taskGroup}>{groups.map(group => <SelectRow key={group.id} label={group.name} detail={group.canManage ? "Vediete túto pobočku" : "Vedúci úlohu prevezme alebo pridelí"}
          selected={selected?.kind === "group" && selected.groupId === group.id} onPress={() => { void onSelect({ kind: "group", groupId: group.id }, group.name); }} disabled={busy} />)}</View>}
      {kind === "person" && !query.data?.people.length || kind === "group" && !groups.length ? <Card><Text style={s.muted}>Pre tento výber sa nič nenašlo. Skúste zmeniť hľadanie.</Text></Card> : null}
      {kind === "person" && query.data?.hasMorePeople ? <Text style={s.muted}>Zoznam pokračuje. Napíšte meno, aby ste našli konkrétneho kolegu.</Text> : null}
    </>}
  </ScrollView>;
}

function DuePicker({ active, current, onBack, onSelect }: { active: boolean; current: string | null; onBack: () => void; onSelect: (date: string | null) => void }) {
  const existing = current ? new Date(current) : new Date();
  const [date, setDate] = useState(`${existing.getDate()}. ${existing.getMonth() + 1}. ${existing.getFullYear()}`);
  const [time, setTime] = useState(current ? `${String(existing.getHours()).padStart(2, "0")}:${String(existing.getMinutes()).padStart(2, "0")}` : "17:00");
  const [error, setError] = useState<string | null>(null);
  useShellBack(active, "Nová úloha", onBack);
  useAndroidBack(active, onBack);
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={formLayout.content}>
    <View style={formLayout.head}><Text accessibilityRole="header" style={s.heading}>Dokedy?</Text><Text style={s.muted}>Termín je voliteľný.</Text></View>
    <FormSection>{([[null, "Bez termínu"], [duePreset(0), "Dnes do konca dňa"], [duePreset(1), "Zajtra do konca dňa"], [duePreset(7), "O týždeň"]] as const).map(([value, label]) => <SelectRow key={label} label={label} selected={current === value} onPress={() => onSelect(value)} />)}</FormSection>
    <FormSection title="Iný termín"><Field label="Dátum" placeholder="18. 11. 2026" value={date} onChangeText={setDate} maxLength={20} keyboardType="numbers-and-punctuation" />
      <Field label="Čas" placeholder="17:00" value={time} onChangeText={setTime} maxLength={5} keyboardType="numbers-and-punctuation" /></FormSection>
    <View style={formLayout.actions}>{error ? <ErrorNotice message={error} /> : null}<Button primary label="Použiť tento termín" onPress={() => { try { onSelect(customDueDate(date, time)); } catch (caught) { setError(errorMessage(caught)); } }} /></View>
  </ScrollView>;
}

function TaskDetail({ id, store, queryKey, active, onBack, onAssign, onChanged, onOpenCase }: {
  id: string; store: EmployeeTasksStore; queryKey: string[]; active: boolean; onBack: () => void;
  onAssign: (task: EmployeeTask) => void; onChanged: () => void; onOpenCase?: (id: string) => void;
}) {
  useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const write = store.commandState(id);
  const [reviewAction, setReviewAction] = useState<"submit_review" | "return" | null>(null);
  const query = useInfiniteQuery({ queryKey: [...queryKey, "detail", id], enabled: active, initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => store.api.detail(id, pageParam, signal), getNextPageParam: page => page.nextActivityCursor ?? undefined });
  const saving = write.status === "saving", uncertain = write.status === "uncertain";
  useShellBack(active, "Úlohy", onBack, saving);
  useAndroidBack(active && !saving, onBack);
  const task = query.data?.pages[0]?.task;
  const run = async (input: EmployeeTaskCommandDraft) => {
    Keyboard.dismiss(); const result = await store.command(id, input);
    if (result) { setReviewAction(null); onChanged(); void query.refetch(); }
    else if (store.commandState(id).status !== "uncertain") void query.refetch();
  };
  const retry = async () => { const receipt = await store.retryCommand(id); if (receipt) { setReviewAction(null); onChanged(); void query.refetch(); } };
  if (query.isPending) return <ScrollView contentContainerStyle={s.content}><Loading label="Načítavam úlohu…" /></ScrollView>;
  if (query.isError && !query.isFetchNextPageError || !task) return <ScrollView contentContainerStyle={s.content}><ErrorNotice message={errorMessage(query.error)} onRetry={() => { void query.refetch(); }} /></ScrollView>;
  const permissions = task.permissions, disabled = saving || uncertain || query.isRefetching;
  const activities = [...new Map(query.data?.pages.flatMap(page => page.activity).map(item => [item.id, item]) ?? []).values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  let primary: { label: string; action: "claim" | "start" | "complete" | "reopen" | "approve" } | null = null;
  if (permissions.claim) primary = { label: "Prevezmem", action: "claim" };
  else if (permissions.approve) primary = { label: "Schváliť úlohu", action: "approve" };
  else if (permissions.start) primary = { label: "Začať riešiť", action: "start" };
  else if (permissions.complete) primary = { label: "Označiť ako hotové", action: "complete" };
  else if (permissions.reopen) primary = { label: "Znovu otvoriť", action: "reopen" };
  const due = taskOverdue(task);
  const canWriteComment = permissions.comment || permissions.submitReview || permissions.return;
  return <KeyboardAvoidingView style={s.fill} behavior={Platform.OS === "ios" ? "padding" : undefined}><ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={formLayout.content}
    refreshControl={<RefreshControl refreshing={query.isRefetching && !query.isFetchingNextPage} onRefresh={() => { void query.refetch(); }} />}>
    <DetailHeader title={task.title} subtitle={taskRecipientLabel(task)} tags={<><Tag text={taskStateLabels[task.state]} tone={tones[task.state]} />{due ? <Tag text="Po termíne" tone="red" /> : null}</>}
      meta={task.createdBy ? "Zadal/a " + task.createdBy.displayName : null} />
    <View style={s.inset}>{write.error ? <ErrorNotice message={write.error} /> : null}
      {uncertain ? <Button primary label="Overiť pôvodnú požiadavku" onPress={() => { void retry(); }} /> : <>
        {primary ? <Button primary label={saving ? "Ukladám…" : primary.label} disabled={disabled} onPress={() => { if (primary) void run({ action: primary.action, expectedRevision: task.revision }); }} /> : null}
        {permissions.submitReview && task.reviewer ? <Button primary={!primary} secondary={Boolean(primary)} label="Odovzdať na kontrolu" disabled={disabled} onPress={() => setReviewAction("submit_review")} /> : null}
        {permissions.assign ? <Button secondary label={task.group && !task.assignee ? "Prideliť kolegovi" : "Zmeniť riešiteľa"} disabled={disabled} onPress={() => onAssign(task)} /> : null}
        {permissions.return ? <Button secondary label="Vrátiť na dopracovanie" disabled={disabled} onPress={() => setReviewAction("return")} /> : null}
      </>}
    </View>
    <SectionHeader title="Podrobnosti" /><Group><InfoRow first label="Riešiteľ" value={task.assignee?.displayName ?? null} empty={task.group ? "Čaká na pridelenie pobočkou" : "Bez riešiteľa"} />
      {task.group ? <InfoRow label="Pobočka" value={task.group.name} /> : null}<InfoRow label="Termín" value={taskDueLabel(task.dueAt)} detail={due ? "Termín už uplynul" : null} />
      {task.priority !== "normal" ? <InfoRow label="Priorita" value={taskPriorityLabels[task.priority]} /> : null}{task.reviewer ? <InfoRow label="Kontrolór" value={task.reviewer.displayName} /> : null}</Group>
    {task.description ? <><SectionHeader title="Čo treba urobiť" /><View style={s.inset}><Card><Text selectable style={s.body}>{task.description}</Text></Card></View></> : null}
    {task.reviewSubmission ? <><SectionHeader title="Odovzdané na kontrolu" /><View style={s.inset}><Card><Text selectable style={s.body}>{task.reviewSubmission}</Text></Card></View></> : null}
    {task.reviewReturnReason ? <><SectionHeader title="Čo treba doplniť" /><View style={s.inset}><Card><Text selectable style={s.body}>{task.reviewReturnReason}</Text></Card></View></> : null}
    {task.caseLinks.length && onOpenCase ? <><SectionHeader title="Súvisiace prípady" /><Group>{task.caseLinks.map((link, index) => <Row key={link.id} first={index === 0} title={link.number} onPress={() => onOpenCase(link.id)} trailing={<ArrowRight size={17} color={palette.secondaryLabel} accessible={false} />} />)}</Group></> : null}
    <SectionHeader title="Priebeh a správy" detail={activities.length ? `${activities.length}${query.hasNextPage ? "+" : ""}` : null} />
    <View style={s.inset}>{query.hasNextPage ? <Button secondary label={query.isFetchingNextPage ? "Načítavam…" : "Starší priebeh a správy"} disabled={query.isFetchingNextPage} onPress={() => { void query.fetchNextPage(); }} /> : null}
      {query.isFetchNextPageError ? <ErrorNotice message={errorMessage(query.error)} onRetry={() => { void query.fetchNextPage(); }} /> : null}
      {!activities.length ? <Card><Text style={s.muted}>Zatiaľ bez správ. Dôležité informácie zostanú pri úlohe.</Text></Card> : activities.map(item => <Card key={item.id}><View style={s.activityHead}><Text style={s.captionStrong}>{item.author?.displayName ?? "Priebeh úlohy"}</Text><Text style={s.caption}>{new Date(item.createdAt).toLocaleString("sk-SK", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })}</Text></View><Text selectable style={s.body}>{item.body}</Text></Card>)}
    </View>
    {canWriteComment ? <><FormSection title={reviewAction === "return" ? "Čo treba doplniť?" : reviewAction === "submit_review" ? "Čo je pripravené na kontrolu?" : "Napísať správu"}>
      <Field label={reviewAction ? "Krátky komentár" : "Správa"} placeholder={reviewAction ? "Doplňte výsledok alebo dôvod" : "Doplňte informáciu pre kolegov…"} value={write.draftText} onChangeText={value => store.editComment(id, value)} multiline maxLength={10_000} editable={!disabled} /></FormSection>
      <View style={formLayout.actions}>{reviewAction ? <>
        <Button primary label={reviewAction === "return" ? "Vrátiť s komentárom" : "Odovzdať kontrolórovi"} disabled={disabled || !write.draftText.trim()} onPress={() => {
          if (reviewAction === "return") void run({ action: "return", comment: write.draftText.trim(), expectedRevision: task.revision });
          else if (task.reviewer) void run({ action: "submit_review", comment: write.draftText.trim(), reviewerUserId: task.reviewer.userId, expectedRevision: task.revision });
        }} /><Button secondary label="Zrušiť odovzdanie" disabled={saving} onPress={() => setReviewAction(null)} />
      </> : permissions.comment ? <Button secondary label={saving ? "Odosielam…" : "Odoslať správu"} disabled={disabled || !write.draftText.trim()} onPress={() => { void run({ action: "comment", body: write.draftText.trim(), expectedRevision: task.revision }); }} /> : null}</View>
    </> : null}
  </ScrollView></KeyboardAvoidingView>;
}

const s = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingHorizontal: space.l, paddingTop: space.s, paddingBottom: NAVIGATION_CONTENT_BOTTOM, gap: space.m },
  heading: { ...type.title, color: palette.label },
  headingRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: space.m },
  listHeader: { gap: space.m },
  listFooter: { gap: space.m },
  rowTitle: { ...type.rowTitle, color: palette.label },
  body: { ...type.body, color: palette.label },
  muted: { ...type.subhead, color: palette.secondaryLabel },
  caption: { ...type.caption, color: palette.secondaryLabel, fontWeight: "400" },
  captionStrong: { ...type.caption, color: palette.label },
  inset: { marginHorizontal: space.l, gap: space.m, paddingTop: space.m },
  grow: { flex: 1, minWidth: 0, gap: space.xs },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: space.s },
  choice: { minHeight: 44, maxWidth: "100%", borderRadius: radius.xl, paddingHorizontal: space.m, paddingVertical: space.m, justifyContent: "center", backgroundColor: palette.fill },
  choiceSelected: { backgroundColor: palette.brandSoft },
  choiceText: { ...type.subhead, color: palette.secondaryLabel, fontWeight: "500", textAlign: "center", flexShrink: 1 },
  choiceSelectedText: { color: palette.brandInk, fontWeight: "600" },
  search: { minHeight: 48, backgroundColor: palette.fill, borderRadius: radius.m, paddingHorizontal: space.m, flexDirection: "row", alignItems: "center", gap: space.s },
  searchInput: { ...type.body, color: palette.label, flex: 1, minWidth: 0, minHeight: 48, paddingVertical: space.s },
  filterRow: { gap: space.s },
  taskGroup: { backgroundColor: palette.card, borderRadius: radius.l, borderCurve: "continuous", overflow: "hidden" },
  taskRow: { minHeight: 88, flexDirection: "row", alignItems: "flex-start", gap: space.m, paddingHorizontal: space.l, paddingVertical: space.l },
  taskMeta: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.s },
  separator: { position: "absolute", top: 0, left: 50, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: palette.separator },
  overdue: { color: palette.redText },
  activityHead: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: space.s },
});
