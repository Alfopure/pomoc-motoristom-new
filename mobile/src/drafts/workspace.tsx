import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { randomUUID } from "expo-crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MobileDraftScope, MobileMe } from "../../../src/lib/mobile-api";
import { createMobileApi, MobileApiError } from "../lib/api";
import type { MobileConfig } from "../lib/config";
import type { LogoutState } from "../lib/logout";
import { formatTime } from "../lib/display";
import { createCasesApi, type CasesApi } from "../cases/api";
import { Cases, type CaseOpenRequest } from "../cases/ui";
import { MyTasks } from "../work/my-tasks-ui";
import { WorkStore } from "../work/store";
import { createToolsApi } from "../tools/api";
import { ToolsWorkspace } from "../tools/ui";
import { Button, ErrorNotice, Loading, styles } from "../ui";
import { DraftNotSentError, draftId } from "./port";
import { createDraftStorage } from "./storage";
import { DraftVault, type DraftKind, type DraftScope, type StoredDraft } from "./vault";
import { DraftAuthority, DraftScopeSuperseded } from "./authority";
import type { MobileCallContextTarget } from "../../../src/lib/mobile-call-context";
import { createCallContextApi } from "../call-context/api";
import { CallContextPanel } from "../call-context/ui";
import { createCallWrapUpApi } from "../call-context/wrap-up-api";
import type { WrapUpDependencies } from "../call-context/wrap-up-ui";
import { customerCallNumber } from "../call-context/number";
import { useAndroidBack } from "../lib/use-android-back";
import { useShellBack } from "../shell/back";
import { createCallbacksApi } from "../callbacks/api";
import { CallbackQueueStore } from "../callbacks/store";
import { CallbacksPanel, type CallbackDialer } from "../callbacks/ui";
import type { DispatchView } from "../shell/navigation";
import type { ShellLayer, ShellOpeners, ShellScope } from "../shell/layers";
import { roleNames } from "../shell/modules";
import { initialsOf } from "../shell/top-bar";
import { InfoRow } from "../design/detail";
import { formLayout } from "../design/form";
import { Group, Row, SectionHeader } from "../design/list";
import { palette, space, type } from "../design/tokens";

type Props = { config: MobileConfig; client: SupabaseClient; identity: MobileMe; userId: string; liveUser: () => string | null;
  active: boolean; view: DispatchView; onView: (view: "cases" | "tasks" | "console" | "account") => void; onSelectNumber: (number: string) => void;
  /** Android Back on a module's first screen; the shell decides where it leads. */
  onLeaveModule: () => void;
  callTarget: MobileCallContextTarget | null; onCloseCallContext: () => void; callBackLabel: string;
  onShowCalls: () => void; dialer: CallbackDialer;
  /** Prehľad, Hľadať and Upozornenia; scope and openers are null until the organization is verified. */
  renderLayer: (layer: ShellLayer, scope: ShellScope | null, notice: string | null, open: ShellOpeners | null) => ReactNode;
  bar: { customized: boolean; onEdit: () => void; onReset: () => void };
  logoutState: LogoutState; logoutError: string | null; logoutBusy: boolean; hasCall: boolean; onLogout: () => void; onLogoutWithoutSaving: () => void };
const operationViews: readonly DispatchView[] = ["cases", "tasks", "account"];
const errorText = (error: unknown) => error instanceof Error ? error.message : "Prístup ku konceptom sa nepodarilo overiť.";

/** A fresh organization read precedes all private hydration. A same-user token
 * refresh preserves drafts; an organization or user change closes every port. */
export function DraftWorkspace(props: Props) {
  const { config, client, userId, liveUser, identity, active } = props;
  const queryClient = useQueryClient();
  const [nonce] = useState(randomUUID);
  const queryKey = useMemo(() => ["mobile", config.environment, userId, "draft-scope", identity.profileId, nonce], [config.environment, userId, identity.profileId, nonce]);
  const getToken = useMemo(() => async () => {
    if (liveUser() !== userId) throw new MobileApiError("Prihlásenie sa zmenilo. Otvorte svoj účet znova.", 401);
    const { data, error } = await client.auth.getSession();
    if (error) throw new MobileApiError("Prihlásenie sa nepodarilo obnoviť.", 0);
    if (liveUser() !== userId || data.session?.user.id !== userId) throw new MobileApiError("Prihláste sa do aplikácie.", 401);
    return data.session.access_token;
  }, [client, liveUser, userId]);
  const api = useMemo(() => createMobileApi(config, getToken), [config, getToken]);
  const authority = useMemo(() => new DraftAuthority(signal => api.draftScope(identity.profileId, signal), liveUser, userId), [api, identity.profileId, liveUser, userId]);
  useEffect(() => () => authority.dispose(), [authority]);
  const authorityState = useSyncExternalStore(authority.subscribe, authority.snapshot, authority.snapshot);
  const query = useQuery({ queryKey, queryFn: ({ signal }) => authority.read(signal),
    enabled: active, refetchOnMount: "always", staleTime: 0, gcTime: 0, refetchInterval: active ? 30_000 : false });
  const verified = authorityState.scope;
  const revalidate = useMemo(() => async (expected: Pick<MobileDraftScope, "organizationId" | "profileId">) => {
    try {
      // Cancellation also keeps TanStack's stale result out of its cache;
      // authority's epoch is the fence if a transport ignores cancellation.
      await queryClient.cancelQueries({ queryKey, exact: true });
      const fresh = await authority.read();
      if (fresh.organizationId !== expected.organizationId || fresh.profileId !== expected.profileId) {
        queryClient.setQueryData(queryKey, fresh);
        throw new DraftNotSentError("Vaša organizácia sa zmenila. Požiadavka sa neodoslala; otvorte koncepty v aktuálnom účte.");
      }
    } catch (error) {
      if (error instanceof DraftScopeSuperseded) throw new DraftNotSentError("Prístup sa medzitým overoval znova. Požiadavka sa neodoslala; skúste znova.");
      throw error;
    }
  }, [authority, queryClient, queryKey]);
  const organizationId = verified?.organizationId ?? null;
  const current = useMemo(() => () => organizationId !== null && authority.current(organizationId), [authority, organizationId]);
  const validate = useMemo(() => () => revalidate({ organizationId: organizationId ?? "", profileId: identity.profileId }), [revalidate, organizationId, identity.profileId]);
  const toolsVisible = props.view === "tools";
  const callbacksOpen = props.view === "callbacks" && props.callTarget === null;
  // Before the scope is verified the panel is not mounted; Back still returns to calls.
  useAndroidBack(active && callbacksOpen && !verified, props.onShowCalls);
  useAndroidBack(active && !verified && !props.callTarget && (toolsVisible || props.view === "cases" || props.view === "tasks"), props.onLeaveModule);
  useAndroidBack(active && !verified && Boolean(props.callTarget), props.onCloseCallContext);
  useShellBack(active && !verified && Boolean(props.callTarget), props.callBackLabel, props.onCloseCallContext);
  const layer = layerOf(props.view, props.callTarget);
  if (!verified && layer) return <>{props.renderLayer(layer, null, query.isPending ? null : errorText(authorityState.error ?? query.error), null)}</>;
  const operationsVisible = toolsVisible || props.callTarget !== null || callbacksOpen || operationViews.includes(props.view);
  if (!verified) return operationsVisible ? <ScrollView style={{ flex: 1 }} contentContainerStyle={formLayout.content}>
    {props.view === "account" && <Account {...props} />}
    <View style={formLayout.notices}>{query.isPending ? <Loading label="Overujem prístup k prípadom a konceptom…" />
      : <ErrorNotice message={errorText(authorityState.error ?? query.error)} onRetry={() => { void query.refetch(); }} />}</View>
  </ScrollView> : null;
  return <>
    <ScopedTools key={"tools:" + verified.profileId + ":" + verified.organizationId} config={config} verified={verified} getToken={getToken} current={current}
      active={active} visible={toolsVisible} mapBlocked={props.hasCall} onClose={props.onLeaveModule} />
    <AuthorizedDraftWorkspace key={"drafts:" + verified.profileId + ":" + verified.organizationId} {...props} verified={verified} getToken={getToken}
      current={current} revalidate={validate} />
  </>;
}

function ScopedTools({ config, verified, getToken, current, active, visible, mapBlocked, onClose }: {
  config: MobileConfig; verified: MobileDraftScope; getToken: () => Promise<string | null>; current: () => boolean;
  active: boolean; visible: boolean; mapBlocked: boolean; onClose: () => void;
}) {
  const token = useMemo(() => async () => {
    if (!current()) throw new MobileApiError("Účet nástrojov sa zmenil.", 401);
    const value = await getToken();
    if (!current()) throw new MobileApiError("Účet nástrojov sa zmenil.", 401);
    return value;
  }, [getToken, current]);
  const api = useMemo(() => createToolsApi(config, verified.profileId, verified.organizationId, token, undefined, current), [config, verified.profileId, verified.organizationId, token, current]);
  const maps = useMemo(() => createCasesApi(config, verified.profileId, token, undefined, verified.organizationId), [config, verified.profileId, verified.organizationId, token]);
  return <ToolsWorkspace api={api} maps={maps} scopeKey={[config.environment, verified.profileId, verified.organizationId].join(":")}
    active={active} visible={visible} mapBlocked={mapBlocked} onClose={onClose} />;
}

function AuthorizedDraftWorkspace(props: Props & { verified: MobileDraftScope; getToken: () => Promise<string | null>; current: () => boolean; revalidate: () => Promise<void> }) {
  const { config, userId, verified, getToken } = props;
  const scope = useMemo<DraftScope>(() => ({ environment: config.environment, projectUrl: config.supabaseUrl, userId,
    profileId: verified.profileId, organizationId: verified.organizationId }), [config.environment, config.supabaseUrl, userId, verified.profileId, verified.organizationId]);
  const { current, revalidate } = props;
  const [vault, setVault] = useState<DraftVault | null>(null), [error, setError] = useState<string | null>(null), [attempt, setAttempt] = useState(0), [epoch, setEpoch] = useState(0);
  useEffect(() => {
    let alive = true, opened: DraftVault | null = null;
    void (async () => {
      try {
        const storage = createDraftStorage(scope);
        const value = await DraftVault.open(storage.storage, scope, { durable: storage.durable, uuid: randomUUID, current: () => alive && current(), revalidate });
        opened = value;
        if (alive && current()) setVault(value); else value.close();
      } catch { if (alive) setError("Miestne koncepty sa nepodarilo pripraviť. Skúste znova."); }
    })();
    return () => { alive = false; opened?.close(); };
  }, [scope, attempt, current, revalidate]);
  const api = useMemo(() => createCasesApi(config, verified.profileId, getToken, undefined, verified.organizationId), [config, verified.profileId, verified.organizationId, getToken]);
  const callApi = useMemo(() => createCallContextApi(config, verified.profileId, verified.organizationId, getToken, current), [config, verified.profileId, verified.organizationId, getToken, current]);
  const actorRoot = useMemo(() => ["mobile", config.environment, userId, verified.profileId, verified.organizationId], [config.environment, userId, verified.profileId, verified.organizationId]);
  const callbackStore = useMemo(() => {
    const base = createMobileApi(config, getToken);
    const lookup = async (number: string, signal?: AbortSignal) => {
      if (!current()) throw new MobileApiError("Prihlásenie alebo organizácia sa zmenili. Otvorte spätné volania znova.", 401);
      const target = await base.callTarget(verified.profileId, number, signal);
      if (!current()) throw new MobileApiError("Prihlásenie alebo organizácia sa zmenili. Otvorte spätné volania znova.", 401);
      return target;
    };
    return new CallbackQueueStore(createCallbacksApi(config, verified.profileId, verified.organizationId, getToken, current), lookup);
  }, [config, verified.profileId, verified.organizationId, getToken, current]);
  useEffect(() => () => callbackStore.dispose(), [callbackStore]);
  // A plain reader for Upozornenia; the queue store above stays the only writer.
  const alertsCallbacks = useMemo(() => createCallbacksApi(config, verified.profileId, verified.organizationId, getToken, current), [config, verified.profileId, verified.organizationId, getToken, current]);
  const [caseRequest, setCaseRequest] = useState<CaseOpenRequest>(), [taskRequest, setTaskRequest] = useState<{ taskId: string | null; nonce: number }>();
  const request = useRef(0);
  function resume(record: StoredDraft) {
    if (record.kind === "task-state") {
      if (record.resourceId) { setTaskRequest({ taskId: record.resourceId, nonce: ++request.current }); props.onView("tasks"); }
    } else { setCaseRequest({ kind: record.kind, id: record.resourceId, nonce: ++request.current }); props.onView("cases"); }
  }
  const wrapUp = useMemo<WrapUpDependencies>(() => ({
    api: createCallWrapUpApi(config, verified.profileId, verified.organizationId, getToken, current), uuid: randomUUID,
    searchCases: async (q, signal) => (await api.list({ ownership: "all", category: "open", q, ownerId: null, status: null, priority: null, cursor: null }, signal)).cases
      .slice(0, 10).map(item => ({ id: item.id, caseNumber: item.caseNumber, statusLabel: item.statusLabel, contactName: item.contact.name, licensePlate: item.vehicle.licensePlate })),
  }), [config, verified.profileId, verified.organizationId, getToken, current, api]);
  const callContext = props.callTarget && <CallContextPanel key={props.callTarget.kind + ":" + props.callTarget.id} api={callApi} target={props.callTarget} active={props.active} current={current} wrapUp={wrapUp} backLabel={props.callBackLabel}
    onBack={props.onCloseCallContext} onSelectNumber={props.onSelectNumber} onOpenCase={id => {
      if (!current()) return;
      setCaseRequest({ kind: "detail", id, nonce: ++request.current }); props.onCloseCallContext(); props.onView("cases");
    }} onNewCase={number => {
      if (!current()) return;
      const phone = customerCallNumber("inbound", number);
      if (!phone) return;
      setCaseRequest({ kind: "case-call-create", id: null, number: phone, nonce: ++request.current }); props.onCloseCallContext(); props.onView("cases");
    }} />;
  const callbacks = props.view === "callbacks" && !props.callTarget && <CallbacksPanel store={callbackStore} active={props.active} current={current} dialer={props.dialer}
    onShowCalls={props.onShowCalls} onOpenCase={id => {
      if (!current()) return;
      setCaseRequest({ kind: "detail", id, nonce: ++request.current }); props.onView("cases");
    }} />;
  const layer = layerOf(props.view, props.callTarget);
  const layerView = layer && <LayerSlot render={props.renderLayer} layer={layer} scope={{ cases: api, callbacks: alertsCallbacks, homeKey: [...actorRoot, "home"] }}
    openCase={id => {
      if (!current() || !draftId(id)) return;
      setCaseRequest({ kind: "detail", id, nonce: ++request.current }); props.onView("cases");
    }}
    openTask={id => {
      if (!current() || !draftId(id)) return;
      setTaskRequest({ taskId: id, nonce: ++request.current }); props.onView("tasks");
    }}
    openCases={shortcut => {
      if (!current()) return;
      setCaseRequest({ kind: "case-list", id: null, shortcut, nonce: ++request.current }); props.onView("cases");
    }}
    openTasks={() => {
      if (!current()) return;
      setTaskRequest({ taskId: null, nonce: ++request.current }); props.onView("tasks");
    }} />;
  // Until local drafts open, Prípady and Moje úlohy are not mounted to own Back.
  useAndroidBack(props.active && !vault && (props.view === "cases" || props.view === "tasks"), props.onLeaveModule);
  if (!vault) return <>{callContext}{callbacks}{layerView}{operationViews.includes(props.view) ? <ScrollView style={{ flex: 1 }} contentContainerStyle={formLayout.content}>
    {props.view === "account" && <Account {...props} />}
    <View style={formLayout.notices}>{error ? <ErrorNotice message={error} onRetry={() => { setError(null); setAttempt(value => value + 1); }} /> : <Loading label="Načítavam miestne koncepty…" />}</View>
  </ScrollView> : null}</>;
  return <>{callContext}{callbacks}{layerView}<VaultOperations key={epoch} {...props} api={api} vault={vault} queryKey={actorRoot} caseRequest={caseRequest} taskRequest={taskRequest}
    onOpenCase={id => { setCaseRequest({ kind: "detail", id, nonce: ++request.current }); props.onView("cases"); }} onResume={resume} onDiscarded={() => { setCaseRequest(undefined); setTaskRequest(undefined); setEpoch(value => value + 1); }} /></>;
}

function layerOf(view: DispatchView, callTarget: MobileCallContextTarget | null): ShellLayer | null {
  if (view === "home") return callTarget ? null : "home";
  return view === "search" || view === "alerts" ? view : null;
}
function LayerSlot({ render, layer, scope, ...open }: { render: Props["renderLayer"]; layer: ShellLayer; scope: ShellScope } & ShellOpeners) {
  return <>{render(layer, scope, null, open)}</>;
}

function VaultOperations(props: Props & { api: CasesApi; vault: DraftVault; queryKey: string[]; caseRequest?: CaseOpenRequest; taskRequest?: { taskId: string | null; nonce: number };
  onOpenCase: (id: string) => void; onResume: (record: StoredDraft) => void; onDiscarded: () => void }) {
  const { api, vault, queryKey, view, active, identity, onDiscarded } = props;
  const client = useQueryClient(), state = useSyncExternalStore(vault.subscribe, vault.snapshot, vault.snapshot);
  const [needsReset, setNeedsReset] = useState(false);
  const resetReady = needsReset && !state.error && !state.saving && !state.busy;
  useEffect(() => { if (resetReady) onDiscarded(); }, [resetReady, onDiscarded]);
  const store = useMemo(() => new WorkStore(api.work, () => { void client.invalidateQueries({ queryKey }); }, (kind, id) => vault.bind(kind, id)), [api.work, client, queryKey, vault]);
  useEffect(() => () => store.dispose(), [store]);
  const caseKey = useMemo(() => [...queryKey, "cases", identity.profileId], [queryKey, identity.profileId]);
  const visible = operationViews.includes(view);
  useAndroidBack(active && !state.ready && (view === "cases" || view === "tasks"), props.onLeaveModule);
  return <>
    {visible && (!state.durable || state.saving || state.error) && <View style={{ paddingHorizontal: 16, paddingTop: 4 }}>
      {!state.durable && <Text style={styles.muted}>Koncepty v tomto náhľade ostávajú iba do zatvorenia aplikácie.</Text>}
      {state.saving && <Text style={styles.muted}>{state.durable ? "Ukladám koncepty v telefóne…" : "Zapamätávam koncepty…"}</Text>}
      {state.error && <ErrorNotice message={state.error} onRetry={() => { void vault.retry().catch(() => undefined); }} />}
    </View>}
    {view === "account" && <ScrollView contentContainerStyle={formLayout.content}><Account {...props} /><LocalDrafts vault={vault} onResume={props.onResume} onDiscarded={props.onDiscarded} needsReset={needsReset} deferReset={() => setNeedsReset(true)} /></ScrollView>}
    {!state.ready && visible && view !== "account" && <View style={styles.content}><Text style={styles.text}>Pred otvorením formulárov obnovte miestne koncepty v účte.</Text><Button label="Otvoriť účet" onPress={() => props.onView("account")} secondary /></View>}
    {state.ready && <>
      <View style={view === "cases" ? { flex: 1 } : { display: "none" }}><Cases api={api} environment={props.config.environment} userId={props.userId} profileId={identity.profileId}
        active={active && view === "cases"} visible={view === "cases"} workStore={store} vault={vault} queryKey={caseKey} openRequest={props.caseRequest} onLeaveCases={props.onLeaveModule} onSelectNumber={props.onSelectNumber} /></View>
      <View style={view === "tasks" ? { flex: 1 } : { display: "none" }}><MyTasks store={store} queryKey={queryKey} profileId={identity.profileId}
        active={active && view === "tasks"} onLeave={props.onLeaveModule} onOpenCase={props.onOpenCase} openTaskRequest={props.taskRequest} /></View>
    </>}
  </>;
}

function Account(props: Props) {
  const profile = props.identity.profile, busy = props.logoutBusy || props.logoutState.busy;
  return <View>
    <View style={formLayout.head}><Text accessibilityRole="header" style={styles.heading}>Účet</Text></View>
    <Group style={{ marginTop: space.m }}><View style={account.profile}>
      <View style={account.avatar}><Text style={account.initials}>{initialsOf(profile.displayName)}</Text></View>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text numberOfLines={2} style={account.name}>{profile.displayName}</Text>
        {profile.email ? <Text numberOfLines={1} style={account.detail}>{profile.email}</Text> : null}
        <Text style={account.detail}>{roleNames[profile.role]}</Text>
      </View>
    </View></Group>
    <SectionHeader title="Prostredie" />
    <Group>
      <InfoRow first label="Dispečing" value={props.config.environment === "test" ? "Testovací dispečing" : "Produkčný dispečing"} />
      <InfoRow label="Verzia appky" value="0.1.0" />
    </Group>
    <SectionHeader title="Spodná lišta" />
    <Group>
      <Row first title="Upraviť lištu" subtitle="Prehľad, tri vaše moduly a Moduly. Platí pre tento telefón." tone="link" onPress={props.bar.onEdit} trailing={<Text style={account.chevron}>›</Text>} />
      {props.bar.customized && <Row title="Obnoviť lištu podľa roly" tone="link" onPress={props.bar.onReset} />}
    </Group>
    {(props.logoutState.message || props.logoutError || props.hasCall) && <View style={formLayout.notices}>
      {props.logoutState.message && <ErrorNotice message={props.logoutState.message} />}{props.logoutError && <ErrorNotice message={props.logoutError} />}
      {props.hasCall && <Text style={styles.muted}>Pred odhlásením ukončite hovor.</Text>}
    </View>}
    <Group style={{ marginTop: space.xl }}>
      <Row first title={busy ? "Odhlasujem…" : "Odhlásiť sa"} tone="danger" disabled={busy || props.hasCall} onPress={props.onLogout} />
      {props.logoutError && <Row title="Odhlásiť bez neuložených zmien" tone="danger" disabled={busy || props.hasCall} onPress={props.onLogoutWithoutSaving} />}
    </Group>
  </View>;
}
const labels: Record<DraftKind, string> = { "case-create": "Nový prípad", "case-edit": "Úprava prípadu", "case-note": "Poznámka prípadu", "case.owner": "Priradenie dispečera", "task-create": "Nová úloha", "task-state": "Správa alebo stav úlohy", handoff: "Odovzdanie prípadu", attachment: "Príloha prípadu" };
function LocalDrafts({ vault, onResume, onDiscarded, needsReset, deferReset }: { vault: DraftVault; onResume: (record: StoredDraft) => void; onDiscarded: () => void; needsReset: boolean; deferReset: () => void }) {
  const state = useSyncExternalStore(vault.subscribe, vault.snapshot, vault.snapshot), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  function discard(record?: StoredDraft) {
    Alert.alert("Zahodiť miestny koncept?", "Odstráni sa iba záznam v tomto zariadení. Nepotvrdený zápis už môže byť na serveri; pred ďalším pokusom ho skontrolujte.", [
      { text: "Ponechať", style: "cancel" }, { text: "Zahodiť", style: "destructive", onPress: () => {
        setBusy(true); setError(null);
        void (record ? vault.discard(record.key) : vault.discardAll()).then(result => {
          if (result && !result.resetSafe) { deferReset(); setError("Koncept je odstránený. Ostatné formuláre majú neuložené zmeny; zostali otvorené. Pred ich obnovením dokončite miestne uloženie."); }
          else onDiscarded();
        }).catch(failure => { deferReset(); setError(errorText(failure)); }).finally(() => setBusy(false));
      } },
    ]);
  }
  return <View>
    <SectionHeader title="Koncepty v tomto zariadení" detail={state.records.length ? String(state.records.length) : null} />
    {state.records.length > 0 && <Group>{state.records.map((record, index) => <View key={record.key} style={account.draft}>
      {index > 0 && <View style={account.separator} />}
      <View style={account.draftHead}><Text numberOfLines={2} style={account.draftTitle}>{labels[record.kind]}</Text><Text style={account.time}>{formatTime(record.updatedAt)}</Text></View>
      <View style={account.draftActions}>
        <DraftAction label="Pokračovať" accessibilityLabel={"Pokračovať: " + labels[record.kind]} disabled={busy || !state.ready} onPress={() => onResume(record)} />
        <DraftAction label="Zahodiť" danger accessibilityLabel={"Zahodiť: " + labels[record.kind]} disabled={busy || state.saving || state.busy} onPress={() => discard(record)} />
      </View>
    </View>)}</Group>}
    <Text style={account.note}>{!state.records.length && state.ready ? "Zatiaľ bez miestnych konceptov. " : ""}{state.durable ? "Rozpísané údaje ostanú v chránenom úložisku aj po odhlásení. Otvoríte ich po prihlásení do rovnakého účtu. Fotografie a dokumenty sa miestne neuchovávajú." : "Tento náhľad obnoví údaje iba počas otvorenia aplikácie. Fotografie a dokumenty sa miestne neuchovávajú."}</Text>
    <View style={formLayout.notices}>
      {error && <ErrorNotice message={error} />}
      {needsReset && <Button label="Obnoviť formuláre po odstránení" secondary disabled={busy || state.saving || state.busy || !!state.error} onPress={onDiscarded} />}
      <Button label="Zahodiť všetky miestne koncepty" secondary disabled={busy || state.saving || state.ready && !state.records.length} onPress={() => discard()} />
    </View>
  </View>;
}

function DraftAction({ label, accessibilityLabel, onPress, disabled, danger }: { label: string; accessibilityLabel: string; onPress: () => void; disabled?: boolean; danger?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled} onPress={onPress}
    hitSlop={{ top: 6, bottom: 6 }} style={({ pressed }) => [account.action, danger && { backgroundColor: palette.redSoft }, disabled && { opacity: 0.4 }, pressed && { opacity: 0.6 }]}>
    <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={[account.actionLabel, danger && { color: palette.redText }]}>{label}</Text>
  </Pressable>;
}
const account = StyleSheet.create({
  profile: { flexDirection: "row", alignItems: "center", gap: space.m, padding: space.m },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: palette.brand, alignItems: "center", justifyContent: "center" },
  initials: { fontSize: 18, fontWeight: "700", color: palette.label },
  name: { ...type.headline, color: palette.label },
  detail: { ...type.subhead, color: palette.secondaryLabel },
  chevron: { fontSize: 20, color: palette.tertiaryLabel },
  note: { ...type.caption, fontWeight: "400", color: palette.secondaryLabel, paddingHorizontal: 20, paddingTop: space.s },
  draft: { gap: space.s, paddingHorizontal: space.m, paddingVertical: 10, backgroundColor: palette.card },
  draftHead: { flexDirection: "row", alignItems: "baseline", gap: space.s },
  draftActions: { flexDirection: "row", flexWrap: "wrap", gap: space.s },
  time: { ...type.caption, color: palette.secondaryLabel, fontVariant: ["tabular-nums"] },
  separator: { position: "absolute", top: 0, left: space.m, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: palette.separator },
  draftTitle: { ...type.rowTitle, color: palette.label, flex: 1 },
  action: { minHeight: 32, borderRadius: 16, paddingHorizontal: 12, alignItems: "center", justifyContent: "center", backgroundColor: palette.brandSoft },
  actionLabel: { fontSize: 13, lineHeight: 17, fontWeight: "600", color: palette.brandInk },
});
