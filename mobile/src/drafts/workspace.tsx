import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert, ScrollView, Text, View } from "react-native";
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
import { Button, Card, ErrorNotice, Loading, styles } from "../ui";
import { DraftNotSentError } from "./port";
import { createDraftStorage } from "./storage";
import { DraftVault, type DraftKind, type DraftScope, type StoredDraft } from "./vault";
import { DraftAuthority, DraftScopeSuperseded } from "./authority";
import type { MobileCallContextTarget } from "../../../src/lib/mobile-call-context";
import { createCallContextApi } from "../call-context/api";
import { CallContextPanel } from "../call-context/ui";
import { customerCallNumber } from "../call-context/number";
import { useAndroidBack } from "../lib/use-android-back";
import { createCallbacksApi } from "../callbacks/api";
import { CallbackQueueStore } from "../callbacks/store";
import { CallbacksPanel, HistorySegment, type CallbackDialer } from "../callbacks/ui";

type Props = { config: MobileConfig; client: SupabaseClient; identity: MobileMe; userId: string; liveUser: () => string | null;
  active: boolean; tab: string; onTab: (tab: "cases" | "tasks" | "console" | "account") => void; onSelectNumber: (number: string) => void;
  toolsOpen: boolean; onCloseTools: () => void;
  callTarget: MobileCallContextTarget | null; onCloseCallContext: () => void;
  callbacksOpen: boolean; onShowCalls: () => void; dialer: CallbackDialer;
  logoutState: LogoutState; logoutError: string | null; logoutBusy: boolean; hasCall: boolean; onLogout: () => void; onLogoutWithoutSaving: () => void };
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
  const toolsVisible = props.toolsOpen && props.tab === "console";
  // Before the scope is verified the panel is not mounted; Back still returns to calls.
  useAndroidBack(active && props.callbacksOpen && !verified, props.onShowCalls);
  const operationsVisible = toolsVisible || props.callTarget !== null || props.callbacksOpen || ["cases", "tasks", "account"].includes(props.tab);
  if (!verified) return operationsVisible ? <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content}>
    {props.tab === "account" && <Account {...props} />}
    {props.callbacksOpen && <HistorySegment view="callbacks" onView={view => { if (view === "calls") props.onShowCalls(); }} />}
    {toolsVisible && <Button label="Späť do ústredne" secondary onPress={props.onCloseTools} />}
    {props.callTarget && <Button label="Späť na hovory" secondary onPress={props.onCloseCallContext} />}
    {query.isPending ? <Loading label="Overujem prístup k prípadom a konceptom…" /> : <View style={styles.content}><ErrorNotice message={errorText(authorityState.error ?? query.error)} onRetry={() => { void query.refetch(); }} /></View>}
  </ScrollView> : null;
  return <>
    <ScopedTools key={"tools:" + verified.profileId + ":" + verified.organizationId} config={config} verified={verified} getToken={getToken} current={current}
      active={active} visible={toolsVisible} mapBlocked={props.hasCall} onClose={props.onCloseTools} />
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
  const [caseRequest, setCaseRequest] = useState<CaseOpenRequest>(), [taskRequest, setTaskRequest] = useState<{ taskId: string; nonce: number }>();
  const request = useRef(0);
  function resume(record: StoredDraft) {
    if (record.kind === "task-state") {
      if (record.resourceId) { setTaskRequest({ taskId: record.resourceId, nonce: ++request.current }); props.onTab("tasks"); }
    } else { setCaseRequest({ kind: record.kind, id: record.resourceId, nonce: ++request.current }); props.onTab("cases"); }
  }
  const callContext = props.callTarget && <CallContextPanel key={props.callTarget.kind + ":" + props.callTarget.id} api={callApi} target={props.callTarget} active={props.active} current={current}
    onBack={props.onCloseCallContext} onSelectNumber={props.onSelectNumber} onOpenCase={id => {
      if (!current()) return;
      setCaseRequest({ kind: "detail", id, nonce: ++request.current }); props.onCloseCallContext(); props.onTab("cases");
    }} onNewCase={number => {
      if (!current()) return;
      const phone = customerCallNumber("inbound", number);
      if (!phone) return;
      setCaseRequest({ kind: "case-call-create", id: null, number: phone, nonce: ++request.current }); props.onCloseCallContext(); props.onTab("cases");
    }} />;
  const callbacks = props.callbacksOpen && <CallbacksPanel store={callbackStore} active={props.active} current={current} dialer={props.dialer}
    onShowCalls={props.onShowCalls} onOpenCase={id => {
      if (!current()) return;
      setCaseRequest({ kind: "detail", id, nonce: ++request.current }); props.onTab("cases");
    }} />;
  if (!vault) return <>{callContext}{callbacks}{["cases", "tasks", "account"].includes(props.tab) ? <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content}>
    {props.tab === "account" && <Account {...props} />}
    {error ? <ErrorNotice message={error} onRetry={() => { setError(null); setAttempt(value => value + 1); }} /> : <Loading label="Načítavam miestne koncepty…" />}
  </ScrollView> : null}</>;
  return <>{callContext}{callbacks}<VaultOperations key={epoch} {...props} api={api} vault={vault} queryKey={actorRoot} caseRequest={caseRequest} taskRequest={taskRequest}
    onOpenCase={id => { setCaseRequest({ kind: "detail", id, nonce: ++request.current }); props.onTab("cases"); }} onResume={resume} onDiscarded={() => { setCaseRequest(undefined); setTaskRequest(undefined); setEpoch(value => value + 1); }} /></>;
}

function VaultOperations(props: Props & { api: CasesApi; vault: DraftVault; queryKey: string[]; caseRequest?: CaseOpenRequest; taskRequest?: { taskId: string; nonce: number };
  onOpenCase: (id: string) => void; onResume: (record: StoredDraft) => void; onDiscarded: () => void }) {
  const { api, vault, queryKey, tab, active, identity, onDiscarded } = props;
  const client = useQueryClient(), state = useSyncExternalStore(vault.subscribe, vault.snapshot, vault.snapshot);
  const [needsReset, setNeedsReset] = useState(false);
  const resetReady = needsReset && !state.error && !state.saving && !state.busy;
  useEffect(() => { if (resetReady) onDiscarded(); }, [resetReady, onDiscarded]);
  const store = useMemo(() => new WorkStore(api.work, () => { void client.invalidateQueries({ queryKey }); }, (kind, id) => vault.bind(kind, id)), [api.work, client, queryKey, vault]);
  useEffect(() => () => store.dispose(), [store]);
  const caseKey = useMemo(() => [...queryKey, "cases", identity.profileId], [queryKey, identity.profileId]);
  const visible = ["cases", "tasks", "account"].includes(tab);
  return <>
    {visible && <View style={{ paddingHorizontal: 20, paddingTop: 8 }}>
      {!state.durable && <Text style={styles.muted}>Koncepty v tomto náhľade ostávajú iba do zatvorenia aplikácie.</Text>}
      {state.saving && <Text style={styles.muted}>{state.durable ? "Ukladám koncepty v telefóne…" : "Zapamätávam koncepty…"}</Text>}
      {state.error && <ErrorNotice message={state.error} onRetry={() => { void vault.retry().catch(() => undefined); }} />}
    </View>}
    {tab === "account" && <ScrollView contentContainerStyle={styles.content}><Account {...props} /><LocalDrafts vault={vault} onResume={props.onResume} onDiscarded={props.onDiscarded} needsReset={needsReset} deferReset={() => setNeedsReset(true)} /></ScrollView>}
    {!state.ready && visible && tab !== "account" && <View style={styles.content}><Text style={styles.text}>Pred otvorením formulárov obnovte miestne koncepty v účte.</Text><Button label="Otvoriť účet" onPress={() => props.onTab("account")} secondary /></View>}
    {state.ready && <>
      <View style={tab === "cases" ? { flex: 1 } : { display: "none" }}><Cases api={api} environment={props.config.environment} userId={props.userId} profileId={identity.profileId}
        active={active && tab === "cases"} visible={tab === "cases"} workStore={store} vault={vault} queryKey={caseKey} openRequest={props.caseRequest} onLeaveCases={() => props.onTab("console")} onSelectNumber={props.onSelectNumber} /></View>
      <View style={tab === "tasks" ? { flex: 1 } : { display: "none" }}><MyTasks store={store} queryKey={queryKey} profileId={identity.profileId}
        active={active && tab === "tasks"} onLeave={() => props.onTab("console")} onOpenCase={props.onOpenCase} openTaskRequest={props.taskRequest} /></View>
    </>}
  </>;
}

function Account(props: Props) {
  return <View style={{ gap: 18 }}><Text style={styles.heading}>Účet</Text><Card><Text style={styles.subheading}>{props.identity.profile.displayName}</Text><Text style={styles.text}>{props.identity.profile.email ?? ""}</Text>
    <Text style={styles.muted}>{({ dispatcher: "Dispečer", senior_dispatcher: "Vedúci dispečer", manager: "Manažér", admin: "Administrátor" })[props.identity.profile.role]}</Text></Card>
    <Card><Text style={styles.label}>Prostredie</Text><Text style={styles.text}>{props.config.environment === "test" ? "Testovací dispečing" : "Produkčný dispečing"}</Text><Text style={styles.muted}>Verzia 0.1.0</Text></Card>
    {props.logoutState.message && <ErrorNotice message={props.logoutState.message} />}{props.logoutError && <ErrorNotice message={props.logoutError} />}
    {props.hasCall && <Text style={styles.muted}>Pred odhlásením ukončite hovor.</Text>}
    <Button label={props.logoutBusy || props.logoutState.busy ? "Odhlasujem…" : "Odhlásiť sa"} disabled={props.logoutBusy || props.logoutState.busy || props.hasCall} onPress={props.onLogout} secondary />
    {props.logoutError && <Button label="Odhlásiť bez neuložených zmien" disabled={props.logoutBusy || props.logoutState.busy || props.hasCall} onPress={props.onLogoutWithoutSaving} secondary />}
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
  return <View style={{ gap: 12 }}><Text style={styles.subheading}>Koncepty v tomto zariadení</Text>
    <Text style={styles.muted}>{state.durable ? "Rozpísané údaje ostanú v chránenom úložisku aj po odhlásení. Otvoríte ich po prihlásení do rovnakého účtu. Fotografie a dokumenty sa miestne neuchovávajú." : "Tento náhľad obnoví údaje iba počas otvorenia aplikácie. Fotografie a dokumenty sa miestne neuchovávajú."}</Text>
    {error && <ErrorNotice message={error} />}{!state.records.length && state.ready && <Text style={styles.muted}>Zatiaľ bez miestnych konceptov.</Text>}
    {state.records.map(record => <Card key={record.key}><Text style={styles.subheading}>{labels[record.kind]}</Text><Text style={styles.muted}>{formatTime(record.updatedAt)}</Text>
      <Button label={"Pokračovať: " + labels[record.kind]} disabled={busy || !state.ready} onPress={() => onResume(record)} />
      <Button label={"Zahodiť: " + labels[record.kind]} secondary disabled={busy || state.saving || state.busy} onPress={() => discard(record)} /></Card>)}
    {needsReset && <Button label="Obnoviť formuláre po odstránení" secondary disabled={busy || state.saving || state.busy || !!state.error} onPress={onDiscarded} />}
    <Button label="Zahodiť všetky miestne koncepty" secondary disabled={busy || state.saving || state.ready && !state.records.length} onPress={() => discard()} />
  </View>;
}
