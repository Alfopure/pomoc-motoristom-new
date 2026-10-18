import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Keyboard, KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { randomUUID } from "expo-crypto";
import { useAndroidBack } from "../lib/use-android-back";
import { useShellBack } from "../shell/back";
import type { MobileTask, MobileTaskWorkflowAction } from "../../../src/lib/mobile-api";
import { Button, Card, ErrorNotice, Loading, styles } from "../ui";
import { Choice, priorities } from "../cases/form";
import { formatTime } from "../lib/display";
import { ColleaguePicker, taskKinds, workflowLabels, workError } from "./ui-shared";
import type { WorkStore } from "./store";
import { orderedMessages, selectedReviewer, type TaskCreateDraft } from "./commands";

export function Tasks({ store, caseId, queryKey, profileId, active, onBack }: { store: WorkStore; caseId: string; queryKey: string[]; profileId: string; active: boolean; onBack: () => void }) {
  const [page, setPage] = useState<{ kind: "list" } | { kind: "create"; draft: TaskCreateDraft } | { kind: "detail"; id: string; created?: boolean }>({ kind: "list" });
  if (page.kind === "create") return <TaskForm store={store} caseId={caseId} queryKey={queryKey} active={active} draft={page.draft} onBack={() => setPage({ kind: "list" })} onSaved={id => setPage({ kind: "detail", id, created: true })} />;
  if (page.kind === "detail") return <TaskDetail key={page.id} created={page.created} store={store} taskId={page.id} queryKey={queryKey} active={active} profileId={profileId} onBack={() => setPage({ kind: "list" })} />;
  return <TaskList store={store} caseId={caseId} queryKey={queryKey} active={active} onBack={onBack} onNew={() => setPage({ kind: "create", draft: store.create(caseId, true) })} onOpen={id => setPage({ kind: "detail", id })} />;
}
function TaskList({ store, caseId, queryKey, active, onBack, onNew, onOpen }: { store: WorkStore; caseId: string; queryKey: string[]; active: boolean; onBack: () => void; onNew: () => void; onOpen: (id: string) => void }) {
  const client = useQueryClient(), draft = store.create(caseId), state = useSyncExternalStore(draft.subscribe, draft.snapshot, draft.snapshot);
  const key = [...queryKey, "tasks", caseId];
  useAndroidBack(active, onBack);
  useShellBack(active, "Prípad", onBack);
  const query = useInfiniteQuery({ queryKey: key, enabled: active, initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => store.api.tasks(caseId, pageParam, signal), getNextPageParam: page => page.nextCursor ?? undefined });
  useEffect(() => {
    if (state.status === "uncertain") void client.cancelQueries({ queryKey: [...queryKey, "tasks", caseId] }).then(() => client.invalidateQueries({ queryKey: [...queryKey, "tasks", caseId] }));
  }, [state.status, client, queryKey, caseId]);
  useEffect(() => { if (active && query.isSuccess && !query.isFetching && !query.isError) draft.review(query.data.pages[0]?.requestedAt ?? 0); }, [active, query.isSuccess, query.isFetching, query.isError, query.data, draft]);
  const hasDraft = !!(state.input.title || state.input.assignedTo || state.input.dueAt || state.input.priority !== "normal" || state.input.kind !== "other");
  const canShow = !query.isError || query.isFetchNextPageError;
  const items = [...new Map(query.data?.pages.flatMap(page => page.tasks).map(item => [item.id, item]) ?? []).values()];
  return <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={query.isRefetching && !query.isFetchingNextPage} onRefresh={() => { void query.refetch(); }} />}>
    <Text style={styles.heading}>Úlohy prípadu</Text>
    <Button label={state.status === "uncertain" ? "Overiť vytvorenie úlohy" : state.input.title && state.status !== "saved" ? "Rozpracovaná úloha" : "Nová úloha"}
      disabled={state.status === "editing" && !hasDraft && (!query.data?.pages[0]?.capabilities.create || query.isError)} onPress={onNew} />
    {state.status === "uncertain" && <Card><Text style={styles.text}>Skontrolujte, či už bola úloha vytvorená. Rovnaký názov sám o sebe nepotvrdzuje výsledok odoslania.</Text></Card>}
    {query.isPending ? <Loading /> : !canShow ? <ErrorNotice message={workError(query.error)} onRetry={() => { void query.refetch(); }} /> : <>
      {!query.data?.pages[0]?.capabilities.create && <Text style={styles.muted}>Vytváranie úloh momentálne nie je dostupné.</Text>}
      {!items.length && <Card><Text style={styles.text}>Zatiaľ bez úloh.</Text></Card>}
      {items.map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={"Otvoriť úlohu " + item.title} onPress={() => onOpen(item.id)}><Card>
        <Text style={styles.subheading}>{item.title}</Text><Text style={styles.text}>{workflowLabels[item.workflowState]} · {priorities.find(v => v.value === item.priority)?.label}</Text>
        <Text style={styles.muted}>{item.assignedTo?.name ?? "Nepriradená"}{item.dueAt ? " · " + formatTime(item.dueAt) : ""}</Text>
      </Card></Pressable>)}
      {query.isFetchNextPageError && <ErrorNotice message={workError(query.error)} onRetry={() => { void query.fetchNextPage(); }} />}
      {query.hasNextPage && <Button label="Ďalšie úlohy" secondary disabled={query.isFetchingNextPage} onPress={() => { void query.fetchNextPage(); }} />}
    </>}
  </ScrollView>;
}
function TaskForm({ store, caseId, queryKey, active, draft, onBack, onSaved }: { store: WorkStore; caseId: string; queryKey: string[]; active: boolean; draft: TaskCreateDraft; onBack: () => void; onSaved: (id: string) => void }) {
  const state = useSyncExternalStore(draft.subscribe, draft.snapshot, draft.snapshot), editing = state.status === "editing", scroll = useRef<ScrollView>(null);
  const back = () => { if (draft.snapshot().status !== "saving") onBack(); };
  useAndroidBack(active, back, state.status === "saving");
  useShellBack(active, "Úlohy", back, state.status === "saving");
  const query = useQuery({ queryKey: [...queryKey, "task-create-capability", caseId], queryFn: ({ signal }) => store.api.tasks(caseId, null, signal), enabled: active });
  useEffect(() => { if (state.error) scroll.current?.scrollTo({ y: 0, animated: true }); }, [state.error]);
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}><ScrollView ref={scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
    <Text style={styles.heading}>Nová úloha</Text>
    {state.error && <ErrorNotice message={state.error} />}
    {state.status === "uncertain" && <><Button label="Skontrolovať zoznam úloh" secondary onPress={back} />{state.reviewed && <Button label="Úlohu som nenašiel – povoliť opakovanie" secondary onPress={() => draft.allowRetry()} />}</>}
    <View><Text style={styles.label}>Názov úlohy</Text><TextInput accessibilityLabel="Názov úlohy" value={state.input.title} onChangeText={title => draft.edit({ title })} editable={editing} multiline maxLength={500} style={styles.input} /></View>
    <ColleaguePicker api={store.api} queryKey={queryKey} active={active} label="Priradiť kolegovi" value={state.input.assignedTo ?? null} disabled={!editing} onChange={assignedTo => draft.edit({ assignedTo })} />
    <View><Text style={styles.label}>Termín (RRRR-MM-DD HH:mm)</Text><TextInput accessibilityLabel="Termín úlohy" placeholder="2026-10-12 14:30" value={state.input.dueAt ?? ""} onChangeText={dueAt => draft.edit({ dueAt: dueAt || null })} editable={editing} maxLength={16} autoCorrect={false} style={styles.input} /><Text style={styles.muted}>Miestny čas telefónu; pole môže zostať prázdne.</Text></View>
    <Text style={styles.label}>Druh úlohy</Text><View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{taskKinds.map(v => <Choice key={v.value} label={v.label} selected={state.input.kind === v.value} disabled={!editing} onPress={() => draft.edit({ kind: v.value })} />)}</View>
    <Text style={styles.label}>Priorita</Text><View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{priorities.map(v => <Choice key={v.value} label={v.label} selected={state.input.priority === v.value} disabled={!editing} onPress={() => draft.edit({ priority: v.value })} />)}</View>
    {query.isError && <ErrorNotice message={workError(query.error)} onRetry={() => { void query.refetch(); }} />}
    {query.data && !query.data.capabilities.create && <Text style={styles.muted}>Vytváranie úloh momentálne nie je dostupné. Rozpracované údaje zostali zachované.</Text>}
    <Button label={state.status === "saving" ? "Vytváram úlohu…" : "Vytvoriť úlohu"} disabled={!editing || !query.data?.capabilities.create || query.isError} onPress={() => { Keyboard.dismiss(); void draft.submit().then(receipt => { if (receipt) onSaved(receipt.taskId); }); }} />
  </ScrollView></KeyboardAvoidingView>;
}
const actionLabels: Record<MobileTaskWorkflowAction, string> = { start: "Začať riešiť", submit_review: "Poslať na kontrolu", approve: "Schváliť", return: "Vrátiť na dopracovanie", complete: "Vybaviť", reopen: "Otvoriť znova", to_todo: "Vrátiť na vybavenie" };
export function availableActions(task: MobileTask, viewer: string): MobileTaskWorkflowAction[] {
  if (task.workflowState === "done") return ["reopen"];
  if (task.workflowState === "in_review") return task.reviewer?.id === viewer ? ["approve", "return"] : [];
  return [...(task.workflowState === "todo" ? ["start" as const] : ["to_todo" as const]), "submit_review", ...(!task.reviewer ? ["complete" as const] : [])];
}
export function TaskDetail({ store, taskId, queryKey, active, profileId, onBack, created, onOpenCase }: { store: WorkStore; taskId: string; queryKey: string[]; active: boolean; profileId: string; onBack: () => void; created?: boolean; onOpenCase?: (id: string) => void }) {
  const retained = store.task(taskId), workflow = useSyncExternalStore(retained.workflow.subscribe, retained.workflow.snapshot, retained.workflow.snapshot), message = useSyncExternalStore(retained.message.subscribe, retained.message.snapshot, retained.message.snapshot);
  const { comment, body, reviewerId: reviewer } = useSyncExternalStore(retained.subscribeComposer, retained.composerSnapshot, retained.composerSnapshot);
  const [error, setError] = useState<string | null>(null);
  const scroll = useRef<ScrollView>(null);
  const query = useQuery({ queryKey: [...queryKey, "task", taskId], queryFn: ({ signal }) => store.api.task(taskId, signal), enabled: active });
  const messages = useInfiniteQuery({ queryKey: [...queryKey, "messages", taskId], queryFn: ({ pageParam, signal }) => store.api.messages(taskId, pageParam, signal), enabled: active && query.isSuccess && !query.isError,
    initialPageParam: null as string | null, getNextPageParam: page => page.nextCursor ?? undefined });
  useEffect(() => { if (active && (workflow.error || message.error || error || workflow.status === "saved" || message.status === "saved")) scroll.current?.scrollTo({ y: 0, animated: true }); }, [active, workflow.error, message.error, error, workflow.status, message.status]);
  const task = query.isError ? null : query.data?.task, capability = query.isError ? null : query.data?.capabilities;
  const current = !!task && (!workflow.receipt || task.revision >= workflow.receipt.committedRevision);
  const saving = workflow.status === "saving" || message.status === "saving";
  const workflowSnapshot = retained.workflow.snapshot, messageSnapshot = retained.message.snapshot;
  const back = () => { if (workflowSnapshot().status !== "saving" && messageSnapshot().status !== "saving") onBack(); };
  useAndroidBack(active, back, saving);
  useShellBack(active, "Úlohy", back, saving);
  async function transition(action: MobileTaskWorkflowAction) {
    if (!task || !capability?.workflow || workflow.status !== "editing") return;
    if ((action === "submit_review" || action === "return") && !comment.trim()) { setError("Doplňte výsledok práce alebo dôvod vrátenia."); return; }
    const reviewerProfileId = selectedReviewer(reviewer, task.reviewer?.id ?? null);
    if (action === "submit_review" && !reviewerProfileId) { setError("Vyberte kontrolóra."); return; }
    setError(null);
    try { await retained.workflow.submit({ action, expectedRevision: task.revision, commandId: randomUUID(), ...(action === "submit_review" && reviewerProfileId ? { reviewerProfileId } : {}), ...(comment.trim() ? { comment: comment.trim() } : {}) }); }
    catch { setError("Požiadavku sa nepodarilo pripraviť."); }
  }
  async function sendMessage() {
    if (!capability?.messages || !body.trim() || message.status !== "editing") return;
    try { await retained.message.submit({ clientMessageId: randomUUID(), body: body.trim() }); } catch { setError("Správu sa nepodarilo pripraviť."); }
  }
  const visibleMessages = orderedMessages(messages.data?.pages ?? []);
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}><ScrollView ref={scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}
    refreshControl={<RefreshControl refreshing={query.isRefetching || messages.isRefetching} onRefresh={() => { void query.refetch(); void messages.refetch(); }} />}>
    <Text style={styles.heading}>Detail úlohy</Text>
    {created && <Card><Text accessibilityRole="alert" style={styles.subheading}>Úloha je vytvorená.</Text></Card>}
    {error && <ErrorNotice message={error} />}{workflow.error && <><ErrorNotice message={workflow.error} /><Button label="Obnoviť detail úlohy" secondary disabled={query.isFetching} onPress={() => { void query.refetch(); }} /></>}{message.error && <ErrorNotice message={message.error} />}
    {workflow.status === "uncertain" && <Button label="Overiť pôvodnú zmenu stavu" onPress={() => { void retained.workflow.reconcile(); }} />}
    {message.status === "uncertain" && <Button label="Overiť pôvodnú správu" onPress={() => { void retained.message.reconcile(); }} />}
    {workflow.status === "saved" && <Card><Text accessibilityRole="alert" style={styles.text}>Zmena stavu je uložená.</Text>{!current && <Text style={styles.muted}>Aktuálny detail ešte nie je potvrdený. Obnovte ho bez opakovania zápisu.</Text>}</Card>}
    {message.status === "saved" && <Card><Text accessibilityRole="alert" style={styles.text}>Správa je odoslaná.</Text><Text style={styles.text}>{message.receipt?.message.body}</Text><Button label="Napísať ďalšiu správu" secondary onPress={() => { if (retained.message.reset()) { retained.body = ""; } }} /></Card>}
    {query.isPending ? <Loading /> : query.isError ? <ErrorNotice message={workError(query.error)} onRetry={() => { void query.refetch(); }} /> : task && <>
      <Card><Text style={styles.subheading}>{task.title}</Text><Text style={styles.text}>{workflowLabels[task.workflowState]} · {priorities.find(v => v.value === task.priority)?.label}</Text>
        <Text style={styles.muted}>{taskKinds.find(v => v.value === task.kind)?.label} · {task.assignedTo?.name ?? "Nepriradená"}</Text>
        {task.dueAt && <Text style={styles.text}>Termín: {formatTime(task.dueAt)}</Text>}{task.reviewer && <Text style={styles.text}>Kontrolór: {task.reviewer.name}</Text>}
        {task.reviewSubmission && <Text style={styles.text}>Výsledok práce: {task.reviewSubmission}</Text>}{task.reviewReturnReason && <Text style={styles.text}>Na dopracovanie: {task.reviewReturnReason}</Text>}
        {task.originLocked && <Text style={styles.muted}>Úloha vznikla z naviazanej udalosti.</Text>}
        <Text style={styles.muted}>{query.data?.linkedCases.map(v => v.caseNumber).join(" · ")}</Text>
        {onOpenCase && query.data?.linkedCases.map(item => <Button key={item.id} label={"Otvoriť prípad " + item.caseNumber} secondary disabled={saving} onPress={() => {
          if (workflowSnapshot().status !== "saving" && messageSnapshot().status !== "saving") onOpenCase(item.id);
        }} />)}</Card>
      {!capability?.workflow && <Text style={styles.muted}>Zmeny stavu momentálne nie sú dostupné. Neoverená požiadavka zostáva zachovaná.</Text>}
      {workflow.status === "saved" && current && <Button label="Ďalšia zmena stavu" secondary onPress={() => retained.workflow.reset()} />}
      {workflow.status === "editing" && capability?.workflow && <>
        <Text style={styles.subheading}>Zmeniť stav</Text><TextInput accessibilityLabel="Výsledok alebo dôvod zmeny" placeholder="Výsledok práce alebo dôvod vrátenia" value={comment} onChangeText={v => { retained.comment = v; }} maxLength={10000} multiline style={[styles.input, { minHeight: 100 }]} />
        <ColleaguePicker api={store.api} queryKey={queryKey} active={active} label="Kontrolór" value={selectedReviewer(reviewer, task.reviewer?.id ?? null)} onChange={v => { retained.reviewerId = v; }} />
        {availableActions(task, profileId).map(action => <Button key={action} label={actionLabels[action]} secondary disabled={saving || !current} onPress={() => { Keyboard.dismiss(); void transition(action); }} />)}
      </>}
      <Text style={styles.subheading}>Správy k úlohe</Text>
      {messages.isPending ? <Loading /> : messages.isError && !messages.isFetchNextPageError ? <ErrorNotice message={workError(messages.error)} onRetry={() => { void messages.refetch(); }} /> : <>
        {visibleMessages.length === 0 && <Text style={styles.muted}>Zatiaľ bez správ.</Text>}
        {visibleMessages.map(item => <Card key={item.id}><Text style={styles.label}>{item.authorName}</Text><Text selectable style={styles.text}>{item.body}</Text><Text style={styles.muted}>{formatTime(item.createdAt)}</Text></Card>)}
        {messages.isFetchNextPageError && <ErrorNotice message={workError(messages.error)} onRetry={() => { void messages.fetchNextPage(); }} />}
        {messages.hasNextPage && <Button label="Staršie správy" secondary disabled={messages.isFetchingNextPage} onPress={() => { void messages.fetchNextPage(); }} />}
      </>}
      {message.status === "editing" && <><TextInput accessibilityLabel="Správa k úlohe" placeholder="Napíšte správu" value={body} onChangeText={v => { retained.body = v; }} maxLength={10000} editable={!!capability?.messages} multiline style={[styles.input, { minHeight: 100 }]} />
        {!capability?.messages && <Text style={styles.muted}>Odosielanie správ momentálne nie je dostupné.</Text>}
        <Button label="Odoslať správu" disabled={!capability?.messages || !body.trim() || saving} onPress={() => { Keyboard.dismiss(); void sendMessage(); }} /></>}
    </>}
  </ScrollView></KeyboardAvoidingView>;
}
