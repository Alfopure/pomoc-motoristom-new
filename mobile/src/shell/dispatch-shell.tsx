import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AccessibilityInfo, Alert, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { ArrowRight, CircleMinus, Pencil, Star, X } from "lucide-react-native";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MobileMe, MobilePresence } from "../../../src/lib/mobile-api";
import type { MobileCallContextTarget } from "../../../src/lib/mobile-call-context";
import type { MobileCallbackSummary } from "../../../src/lib/mobile-callbacks";
import { MobileApiError, type MobileApi } from "../lib/api";
import type { MobileConfig } from "../lib/config";
import type { LogoutState } from "../lib/logout";
import { formatNumber, presenceLabels } from "../lib/display";
import { useAndroidBack } from "../lib/use-android-back";
import { ErrorNotice } from "../ui";
import { palette, space } from "../design/tokens";
import { NAVIGATION_CONTENT_BOTTOM, navigationContentBottom, tabBarBottom, tabBarHeight } from "../ui/theme";
import { usePhoneOverlay } from "../ui/phone-overlays";
import { DraftWorkspace } from "../drafts/workspace";
import { draftId } from "../drafts/port";
import type { CallbackDialer } from "../callbacks/ui";
import type { DispatchPhone, PhoneState } from "../voice/phone";
import { Console } from "../calls/console";
import { History, type HistoryCategory } from "../calls/history";
import { HovoryHeader } from "../calls/header";
import { DoneButton, EditBarContent } from "./edit-bar";
import { HomeScreen, type HomeTarget } from "./home";
import { SearchScreen } from "./search";
import { AlertsScreen } from "../alerts/ui";
import { ModulesScreen } from "./modules-screen";
import { PIN_LIMIT, moduleAccess, moduleById, roleNames, rolePins, type ModuleId } from "./modules";
import { barTabs, dispatchView, initialShell, openModule, reconcileShell, selectTab, shellBack, type DispatchView, type HovoryView, type ShellState, type ShellTab } from "./navigation";
import { Group, Row } from "../design/list";
import { GlassButton, ModuleTile, Sheet, Toast, tabLabel } from "./parts";
import { ShellBackContext } from "./back";
import { ShellBackStore } from "./back-store";
import { pinsFull, replacingPin, withPin, withoutPin } from "./pins";
import { ShellPreferences, shellPreferencesKey } from "./preferences";
import { createShellPreferencesStorage } from "./preferences-storage";
import { DockTabBar } from "./tab-bar";
import { CALL_BAR_SPACE, CallBar, callBarCall, type CallBarCall } from "./call-bar";
import { useKeyboardShown } from "./keyboard";
import { CallScreen, CallStrip, type CallFacts } from "../calls/call-screen";
import { callView } from "../calls/call-screen-model";
import { CallActionContext, dialBlockedReason, type CallAction, type CallCase } from "../voice/dial";
import { customerCallNumber } from "../call-context/number";
import { dialDecision } from "../callbacks/model";
import { ShellTopBar, initialsOf, type PresenceTone } from "./top-bar";

type Props = {
  config: MobileConfig; client: SupabaseClient; api: MobileApi; active: boolean; userId: string; liveUser: () => string | null;
  identity: MobileMe; queryKey: string[]; meError: unknown; onRetryMe: () => void;
  phone: DispatchPhone | null; phoneState: PhoneState; callbackSummary: UseQueryResult<MobileCallbackSummary>; dialer: CallbackDialer;
  logoutState: LogoutState; logoutError: string | null; logoutBusy: boolean; onLogout: () => void; onLogoutWithoutSaving: () => void;
};
type ShellSheet = { kind: "edit" } | { kind: "pin"; id: ModuleId } | { kind: "menu"; id: ModuleId };
const shellOwnedBack: readonly DispatchView[] = ["modules", "console", "history", "account", "search", "alerts"];
const presenceTone: Record<MobilePresence, PresenceTone> = { available: "green", paused: "orange", after_call_work: "orange", ringing: "red", on_call: "red", offline: "gray" };
const errorMessage = (error: unknown) => error instanceof MobileApiError ? error.message : "Údaje sa nepodarilo načítať. Skúste znova.";

/** App frame: top bar, the visible module and the bottom bar. Module screens
 * keep their own state; the frame only decides where each one is shown. */
export function DispatchShell(props: Props) {
  const { config, api, active, userId, identity, queryKey, phone, phoneState, callbackSummary } = props;
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const available = useMemo(() => moduleAccess(identity.profile.role), [identity.profile.role]);
  const prefs = useMemo(() => new ShellPreferences(createShellPreferencesStorage(),
    shellPreferencesKey({ environment: config.environment, userId, profileId: identity.profileId }), available, rolePins(identity.profile.role)),
  [config.environment, userId, identity.profileId, identity.profile.role, available]);
  useEffect(() => () => prefs.dispose(), [prefs]);
  const preferences = useSyncExternalStore(prefs.subscribe, prefs.snapshot, prefs.snapshot);
  // An unreadable Keychain (locked phone) is retried each time the app returns to the foreground.
  useEffect(() => { if (active && !preferences.loaded) void prefs.load(); }, [active, preferences.loaded, prefs]);
  const pins = preferences.pins;
  const [shell, setShell] = useState<ShellState>(initialShell);
  const nav = reconcileShell(shell, pins, available);
  const view = dispatchView(nav);
  const [number, setNumber] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [category, setCategory] = useState<HistoryCategory>("all");
  const [search, setSearch] = useState("");
  const [callSelection, setCallSelection] = useState<{ target: MobileCallContextTarget; view: DispatchView } | null>(null);
  const [toast, setToast] = useState<{ message: string; key: number } | null>(null);
  const sheet = usePhoneOverlay<ShellSheet>(active);
  const [backStore] = useState(() => new ShellBackStore());
  const moduleBack = useSyncExternalStore(backStore.subscribe, backStore.snapshot, backStore.snapshot);
  const callTarget = callSelection?.view === view ? callSelection.target : null;
  const consoleQuery = useQuery({ queryKey: [...queryKey, "console", identity.profileId], queryFn: ({ signal }) => api.console(identity.profileId, signal),
    enabled: active, refetchInterval: active ? 30_000 : false });
  const keyboard = useKeyboardShown();
  // A session that ended in this phone never runs again, though the server may list it for a while.
  const phoneSession = (phoneState.call?.sessionId ?? phoneState.termination ?? null)?.toLowerCase() ?? null;
  const [sessions, setSessions] = useState<{ current: string | null; ended: string[] }>({ current: phoneSession, ended: [] });
  if (sessions.current !== phoneSession) setSessions({ current: phoneSession, ended: sessions.current ? [...sessions.ended, sessions.current].slice(-20) : sessions.ended });
  const refetchConsole = consoleQuery.refetch;
  useEffect(() => { if (sessions.ended.length) void refetchConsole(); }, [sessions.ended, refetchConsole]);
  // The phone's own call: the screen opens for each new call and can be hidden to work in
  // the app. An ending call keeps the choice, so a hidden screen does not pop up to close.
  const ownCall = callView(phoneState);
  const callId = phoneState.call?.id ?? null;
  // `focusStrip`: Skryť hands VoiceOver to the strip; Detail and Nový prípad leave it on their screen.
  const [callScreen, setCallScreen] = useState<{ id: string | null; open: boolean; connectedAt: number | null; focusStrip: boolean }>({ id: callId, open: true, connectedAt: null, focusStrip: false });
  if (callScreen.id !== callId) setCallScreen({ id: callId, open: callId !== null || callScreen.open, connectedAt: null, focusStrip: false });
  const callConnected = Boolean(phoneState.call?.connected);
  // Talk time counts from the moment this phone saw the call connected.
  useEffect(() => {
    if (!callConnected) return;
    const timer = setTimeout(() => setCallScreen(value => value.connectedAt === null && value.id === callId ? { ...value, connectedAt: Date.now() } : value), 0);
    return () => clearTimeout(timer);
  }, [callConnected, callId]);
  const ownFacts = phoneState.call ? (consoleQuery.data?.activeCalls ?? []).find(call => call.id.toLowerCase() === phoneState.call!.sessionId.toLowerCase()) : undefined;
  const callFacts: CallFacts | null = ownFacts ? { lineLabel: ownFacts.lineLabel, partner: ownFacts.name, contact: ownFacts.contactName ?? null } : null;
  // "Nový prípad" from the call waits only on Prípady; leaving it drops the request.
  const [callCase, setCallCase] = useState<{ number: string; nonce: number } | null>(null);
  if (callCase && view !== "cases") setCallCase(null);
  // Never reused: the workspace remembers the last nonce it handled.
  const callCaseSeq = useRef(0);
  const callCaseNumber = phoneState.call ? customerCallNumber(phoneState.call.outgoing ? "outbound" : "inbound", phoneState.call.number) : null;
  const dialBlocked = dialBlockedReason(phone, phoneState);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 2400); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { if (view === "modules" && preferences.loaded && !preferences.tipDismissed) prefs.dismissTip(); }, [view, preferences.loaded, preferences.tipDismissed, prefs]);

  const go = (next: ShellState) => { setCallSelection(null); setShell(next); };
  const navigate = (id: ModuleId, hovory?: HovoryView) => go(openModule(nav, pins, id, hovory));
  const back = () => { const next = shellBack(nav); if (next) go(next); };
  const notify = (message: string) => setToast(current => ({ message, key: (current?.key ?? 0) + 1 }));
  function openOwnCallDetail() {
    const sessionId = phoneState.call?.sessionId;
    if (!sessionId || !draftId(sessionId)) return;
    setCallScreen(value => ({ ...value, open: false, focusStrip: false }));
    go(openModule(nav, pins, "hovory", "console"));
    setCallSelection({ target: { kind: "session", id: sessionId.toLowerCase() }, view: "console" });
  }
  function newCaseFromCall() {
    if (!callCaseNumber) return;
    setCallScreen(value => ({ ...value, open: false, focusStrip: false }));
    navigate("pripady");
    setCallCase({ number: callCaseNumber, nonce: ++callCaseSeq.current });
  }
  // One confirmation and one dial at a time; a second tap while either is open does nothing.
  const placing = useRef(false);
  // A dial result can arrive after the dispatcher moved on; its alert navigates from the current screen.
  const latestNavigate = useRef(navigate);
  useEffect(() => { latestNavigate.current = navigate; });
  const release = () => { placing.current = false; };
  // The same verified-number decision as Ústredňa; a blocked phone sends the number there instead.
  // A refused or unconfirmed start is reported here, since the caller may not be on Ústredňa.
  async function placeCall(number: string, fromCase?: CallCase) {
    if (!phone) { release(); return; }
    let confirming = false;
    const start = async (verificationId?: string) => {
      try {
        const sent = await phone.dial(number, verificationId, fromCase?.id);
        const after = phone.snapshot();
        if (sent && !after.error) return;
        const message = after.error ?? "Telefón práve nie je pripravený na nový hovor. Skúste to znova.";
        if (after.retryTarget) Alert.alert("Hovor nie je potvrdený", message + "\n\nPokus dokončite alebo zrušte v Ústredni.", [
          { text: "Zavrieť", style: "cancel" }, { text: "Otvoriť Ústredňu", onPress: () => latestNavigate.current("hovory", "console") }]);
        else Alert.alert("Hovor sa nezačal", message);
      } finally { release(); }
    };
    try {
      const decision = dialDecision(await api.callTarget(identity.profileId, number));
      if (decision.kind === "blocked") { Alert.alert("Volanie nie je možné", decision.message); return; }
      if (decision.kind === "dial") { await start(); return; }
      confirming = true;
      Alert.alert(decision.title, decision.message, [{ text: "Zrušiť", style: "cancel", onPress: release }, { text: "Zavolať", onPress: () => { void start(decision.verificationId); } }],
        { cancelable: true, onDismiss: release });
    } catch (error) { Alert.alert("Hovor sa nezačal", errorMessage(error)); }
    finally { if (!confirming && placing.current) release(); }
  }
  const callAction: CallAction = {
    ready: dialBlocked === null,
    call: (value, name, fromCase) => {
      const number = value.trim();
      if (!number || placing.current) return;
      if (!phone || dialBlockedReason(phone, phone.snapshot()) !== null) { setNumber(number); navigate("hovory", "console"); return; }
      placing.current = true;
      Alert.alert("Zavolať?", [name, formatNumber(number)].filter(Boolean).join("\n") + "\n\nHovor pôjde cez ústredňu" + (fromCase ? " a zapíše sa k prípadu " + fromCase.caseNumber + "." : "."), [
        { text: "Zrušiť", style: "cancel", onPress: release }, { text: "Zavolať", onPress: () => { void placeCall(number, fromCase); } }], { cancelable: true, onDismiss: release });
    },
  };
  useAndroidBack(active && !callTarget && !sheet.value && shellOwnedBack.includes(view), back);
  function openCallContext(target: MobileCallContextTarget) {
    if (!draftId(target.id)) return;
    setCallSelection({ target: { ...target, id: target.id.toLowerCase() }, view });
  }
  function pin(id: ModuleId) {
    if (pins.includes(id)) return;
    if (pinsFull(pins)) { sheet.open({ kind: "pin", id }); return; }
    prefs.setPins(withPin(pins, id));
    notify(moduleById(id).name + " je v lište");
  }
  function replace(replaced: ModuleId, id: ModuleId) {
    sheet.close();
    prefs.setPins(replacingPin(pins, replaced, id));
    notify(moduleById(id).name + " je v lište namiesto " + moduleById(replaced).name);
  }
  function unpin(id: ModuleId) {
    sheet.close();
    prefs.setPins(withoutPin(pins, id));
    notify(moduleById(id).name + " odobraté z lišty");
  }
  function homeTarget(target: HomeTarget) {
    if (target === "console" || target === "callbacks") navigate("hovory", target);
    else navigate(target === "cases" ? "pripady" : "ulohy");
  }
  const presence = consoleQuery.data?.presence.status;
  const statusLabel = presence ? (presence === "after_call_work" ? "Po hovore" : presenceLabels[presence]) : consoleQuery.isError ? "Stav neznámy" : "Stav…";
  const phoneDetail = !phone ? "Volanie v natívnej appke" : phoneState.registration === "registered" ? "Pripojený k ústredni" : phoneState.registration === "connecting" ? "Pripájam…" : "Nepripojený";
  const waiting = callbackSummary.data?.counts.open ?? 0;
  const openedInModules = nav.tab === "moduly" && nav.opened !== null && !nav.account;
  const sheetModule = sheet.value && sheet.value.kind !== "edit" ? sheet.value.id : null;
  const tabs = barTabs(pins);
  const hovoryVisible = (view === "console" || view === "history" || view === "callbacks") && !callTarget;
  // The bar lists calls on the account outside this phone; the call panel shows the phone's own.
  const barCall = callBarCall(consoleQuery.data?.activeCalls ?? [], phoneSession ? [phoneSession, ...sessions.ended] : sessions.ended);
  // Ústredňa and the call's own detail already show it; with the keyboard up it steps aside.
  const callBar = barCall && !keyboard && !(view === "console" && !callTarget) && !(callTarget?.kind === "session" && callTarget.id === barCall.id.toLowerCase()) ? barCall : null;
  const openBarCall = (call: CallBarCall) => {
    if (call.count > 1 || !draftId(call.id)) { navigate("hovory", "console"); return; }
    go(openModule(nav, pins, "hovory", "history"));
    setCallSelection({ target: { kind: "session", id: call.id.toLowerCase() }, view: "history" });
  };
  // Larger text or a taller system bar grows the floating bar; content ends above it.
  const extraNavigationSpace = Math.max(0, navigationContentBottom(fontScale, insets.bottom) - NAVIGATION_CONTENT_BOTTOM) + (callBar ? CALL_BAR_SPACE : 0);
  // A module sub-screen (detail, form) owns Back first; then account, then the module opened in Moduly.
  const layerOpen = nav.account || nav.search || nav.alerts;
  const left = moduleBack && !layerOpen ? { kind: "back" as const, label: moduleBack.label, onPress: moduleBack.onBack, disabled: moduleBack.disabled }
    : layerOpen ? { kind: "back" as const, label: nav.tab === "moduly" && nav.opened ? moduleById(nav.opened).short : tabLabel(nav.tab), onPress: back }
      : openedInModules ? { kind: "back" as const, label: "Moduly", onPress: back }
        : { kind: "status" as const, label: statusLabel, tone: presence ? presenceTone[presence] : "gray" as const, onPress: () => navigate("hovory", "console") };
  return <View style={{ flex: 1 }}><ShellBackContext.Provider value={backStore}><CallActionContext.Provider value={callAction}><View style={{ flex: 1, paddingBottom: extraNavigationSpace }}>
    {ownCall && phone && !callScreen.open && <CallStrip view={ownCall} facts={callFacts} connectedAt={callScreen.connectedAt} attention={Boolean(phoneState.error) || ownCall.holdUncertain}
      focus={callScreen.focusStrip} onExpand={() => setCallScreen(value => ({ ...value, open: true }))} />}
    <ShellTopBar test={config.environment === "test"} initials={initialsOf(identity.profile.displayName)} onAccount={() => go({ ...nav, account: true, search: false, alerts: false })}
      left={left} onPin={openedInModules && !moduleBack && nav.opened && !pins.includes(nav.opened) ? () => pin(nav.opened!) : null} />
    {Boolean(props.meError) && <View style={{ paddingHorizontal: space.l }}><ErrorNotice message={errorMessage(props.meError)} onRetry={props.onRetryMe} /></View>}
    {hovoryVisible && <HovoryHeader view={nav.hovory} onView={value => go({ ...nav, hovory: value })} waiting={callbackSummary.data ? waiting : null} />}
    {view === "console" && !callTarget && <Console api={api} me={identity} queryKey={queryKey} active={active} number={number} onNumber={setNumber}
      phone={phone} phoneState={phoneState} onCallContext={openCallContext} />}
    {view === "history" && !callTarget && <History api={api} me={identity} queryKey={queryKey} active={active} category={category} onCategory={setCategory}
      search={search} onSearch={setSearch} onCallContext={openCallContext} onSelect={value => { setNumber(value); navigate("hovory", "console"); }} />}
    {view === "modules" && <ModulesScreen available={available} pins={pins} tabs={tabs} showAdd={pins.length < PIN_LIMIT} badges={{ hovory: waiting }}
      onOpen={id => navigate(id)} onMenu={id => sheet.open({ kind: "menu", id })} onEdit={() => sheet.open({ kind: "edit" })} onAccount={() => go({ ...nav, account: true })} />}
    <DraftWorkspace key={identity.profileId} config={config} client={props.client} identity={identity} userId={userId} liveUser={props.liveUser} active={active}
      view={view} onView={target => {
        if (target === "account") go({ ...nav, account: true });
        else if (target === "console") navigate("hovory", "console");
        else navigate(target === "cases" ? "pripady" : "ulohy");
      }}
      onLeaveModule={back} callTarget={callTarget} onCloseCallContext={() => setCallSelection(null)} callBackLabel={callSelection?.view === "home" ? "Prehľad" : "Hovory"}
      onShowCalls={back} dialer={props.dialer}
      onSelectNumber={value => { setNumber(value); navigate("hovory", "console"); }} callCase={callCase}
      onCallCaseHandled={nonce => setCallCase(value => value?.nonce === nonce ? null : value)}
      renderLayer={(layer, scope, notice, open) => {
        const targets = open ? { ...open, openCallbacks: () => navigate("hovory", "callbacks") } : null;
        if (layer === "search") return <SearchScreen active={active && view === "search"} api={api} profileId={identity.profileId} queryKey={queryKey}
          input={searchInput} onInput={setSearchInput}
          available={available} scope={scope} scopeNotice={notice} onModule={id => navigate(id)} onCase={id => open?.openCase(id)}
          onCall={id => { if (!draftId(id)) return; go(openModule(nav, pins, "hovory", "history")); setCallSelection({ target: { kind: "call", id: id.toLowerCase() }, view: "history" }); }} />;
        if (layer === "alerts") return <AlertsScreen active={active && view === "alerts"} scope={scope} targets={targets} notice={notice} />;
        return <HomeScreen active={active && view === "home"} scope={scope} scopeNotice={notice} onSearch={() => go({ ...nav, search: true })}
          alerts={scope && targets ? { scope, targets, onAll: () => go({ ...nav, alerts: true }) } : null}
          phone={{ label: statusLabel, tone: presence ? presenceTone[presence] : "gray", detail: phoneDetail }}
          callbacks={callbackSummary} activeCalls={consoleQuery.data?.activeCalls ?? []}
          tip={preferences.loaded && !preferences.tipDismissed} onDismissTip={() => prefs.dismissTip()}
          onOpen={homeTarget} onCall={id => openCallContext({ kind: "session", id })}
          onRefresh={() => { void Promise.allSettled([callbackSummary.refetch(), consoleQuery.refetch(), queryClient.invalidateQueries({ queryKey: [...queryKey, identity.profileId] })]); }} />;
      }}
      bar={{ customized: preferences.customized, onEdit: () => sheet.open({ kind: "edit" }), onReset: () => { prefs.reset(); notify("Lišta je podľa roly " + roleNames[identity.profile.role]); } }}
      logoutState={props.logoutState} logoutError={props.logoutError} logoutBusy={props.logoutBusy}
      hasCall={Boolean(phoneState.call || phoneState.termination)} onLogout={props.onLogout} onLogoutWithoutSaving={props.onLogoutWithoutSaving} />
    </View></CallActionContext.Provider></ShellBackContext.Provider>
    {callBar && <CallBar call={callBar} active={active} onPress={() => openBarCall(callBar)} />}
    <DockTabBar tabs={tabs} selected={nav.account ? null : nav.tab} badges={{ hovory: waiting }} showAdd={pins.length < PIN_LIMIT}
      onSelect={(tab: ShellTab) => go(selectTab(nav, tab))} onAdd={() => sheet.open({ kind: "edit" })} />
    <Sheet visible={sheet.value !== null} large={sheet.value?.kind === "edit"} onClose={sheet.close}
      title={sheet.value?.kind === "edit" ? "Upraviť lištu" : sheet.value?.kind === "pin" ? "Do lišty" : sheetModule ? moduleById(sheetModule).name : ""}
      left={sheet.value?.kind === "pin" ? <Pressable accessibilityRole="button" onPress={sheet.close} style={s.cancel}><Text style={s.link}>Zrušiť</Text></Pressable> : undefined}
      right={sheet.value?.kind === "edit" ? <DoneButton onPress={sheet.close} />
        : sheet.value?.kind === "menu" ? <GlassButton round accessibilityLabel="Zavrieť" onPress={sheet.close} icon={<X size={18} strokeWidth={2.4} color={palette.label} accessible={false} />} /> : undefined}>
      {sheet.value?.kind === "edit" && <EditBarContent pins={pins} available={available} roleLabel={roleNames[identity.profile.role]}
        customized={preferences.customized} saveError={preferences.saveError}
        onChange={(next, message) => { prefs.setPins(next); AccessibilityInfo.announceForAccessibility?.(message); }}
        onReset={() => { prefs.reset(); AccessibilityInfo.announceForAccessibility?.("Lišta je podľa roly"); }} />}
      {sheet.value?.kind === "pin" && sheetModule && <>
        <Text style={s.note}>Lišta má {PIN_LIMIT} miesta a je plná. Ktorý modul nahradí <Text style={{ fontWeight: "700", color: palette.label }}>{moduleById(sheetModule).name}</Text>?</Text>
        <Group style={{ marginTop: space.m }}>{pins.map((id, index) => <Row key={id} first={index === 0} title={moduleById(id).name} leading={<ModuleTile id={id} />}
          accessibilityLabel={"Nahradiť " + moduleById(id).name} onPress={sheet.guard(() => replace(id, sheetModule))}
          trailing={<View style={s.replace}><Text style={s.replaceText}>Nahradiť</Text></View>} />)}</Group>
        <Text style={s.note}>Nahradený modul zostane v Moduloch.</Text>
      </>}
      {sheet.value?.kind === "menu" && sheetModule && <Group style={{ marginTop: space.s }}>
        <Row first title="Otvoriť" leading={<ModuleTile id={sheetModule} />} trailing={<ArrowRight size={18} color={palette.secondaryLabel} accessible={false} />}
          onPress={sheet.guard(() => { sheet.close(); navigate(sheetModule); })} />
        {pins.includes(sheetModule)
          ? <Row title="Odobrať z lišty" tone="danger" leading={<View style={s.menuIcon}><CircleMinus size={18} color={palette.redText} accessible={false} /></View>} onPress={sheet.guard(() => unpin(sheetModule))} />
          : <Row title={pinsFull(pins) ? "Pridať do lišty…" : "Pridať do lišty"} leading={<View style={s.menuIcon}><Star size={18} color={palette.label} accessible={false} /></View>}
            onPress={sheet.guard(() => { if (pinsFull(pins)) sheet.open({ kind: "pin", id: sheetModule }); else { sheet.close(); pin(sheetModule); } })} />}
        <Row title="Upraviť lištu…" leading={<View style={s.menuIcon}><Pencil size={17} color={palette.label} accessible={false} /></View>} onPress={sheet.guard(() => sheet.open({ kind: "edit" }))} />
      </Group>}
    </Sheet>
    <Toast key={toast?.key} message={toast?.message ?? null} bottom={tabBarBottom(insets.bottom) + tabBarHeight(fontScale) + 12 + (callBar ? CALL_BAR_SPACE : 0)} />
    {ownCall && phone && <CallScreen visible={callScreen.open} view={ownCall} facts={callFacts} connectedAt={callScreen.connectedAt} phone={phone} state={phoneState}
      onMinimize={() => setCallScreen(value => ({ ...value, open: false, focusStrip: true }))}
      onDetail={phoneState.call && draftId(phoneState.call.sessionId) ? openOwnCallDetail : null}
      onNewCase={callCaseNumber && available.includes("pripady") ? newCaseFromCall : null} />}
  </View>;
}
const s = StyleSheet.create({
  link: { fontSize: 16, lineHeight: 20, fontWeight: "600", color: palette.brandInk },
  cancel: { minHeight: 44, justifyContent: "center", paddingRight: 12 },
  note: { fontSize: 13, lineHeight: 18, color: palette.secondaryLabel, paddingHorizontal: 22, paddingTop: space.s, textAlign: "center" },
  replace: { borderRadius: 13, backgroundColor: "#1C1C1E", paddingHorizontal: 11, paddingVertical: 5 },
  replaceText: { fontSize: 13, lineHeight: 16, fontWeight: "700", color: "#FFFFFF" },
  menuIcon: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
});
