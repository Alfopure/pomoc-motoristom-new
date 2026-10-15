import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert, AppState, KeyboardAvoidingView, Linking, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";
import { StatusBar } from "expo-status-bar";
import Svg, { Defs, LinearGradient as SvgGradient, Rect, Stop } from "react-native-svg";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowDownLeft, ArrowUpRight, LockKeyhole, Mail, Phone, PhoneCall, Search } from "lucide-react-native";
import { QueryClient, QueryClientProvider, focusManager, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import type { MobileMe } from "../src/lib/mobile-api";
import { createMobileApi, MobileApiError, usableMobileIdentity, type MobileApi } from "./src/lib/api";
import { readMobileConfig, type MobileConfig } from "./src/lib/config";
import { createMobileSupabase } from "./src/lib/supabase";
import { callStatus, dialable, formatNumber, formatTime, presenceLabels } from "./src/lib/display";
import { Button, Card, ErrorNotice, Loading, colors, styles } from "./src/ui";
import { useDispatchPhone } from "./src/voice/use-phone";
import { DraftWorkspace } from "./src/drafts/workspace";
import { flushAccountDrafts } from "./src/drafts/vault";
import { AuthIncarnation } from "./src/lib/auth-incarnation";
import { supportsDurableDrafts } from "./src/drafts/storage";
import { CallPanel } from "./src/voice/ui";
import { PhoneReadinessCard } from "./src/voice/readiness-ui";
import { ColleaguesCard } from "./src/voice/colleagues-ui";
import type { DispatchPhone, PhoneState } from "./src/voice/phone";
import { SessionLogout, type LogoutState } from "./src/lib/logout";
import { useAndroidBack } from "./src/lib/use-android-back";
import { GlassTabBar, type DispatchTab } from "./src/ui/navigation";
import { NAVIGATION_CONTENT_BOTTOM, navigationContentBottom } from "./src/ui/theme";

type Tab = DispatchTab;
type Category = "all" | "missed" | "received" | "outbound";
const categories: { id: Category; label: string }[] = [
  { id: "all", label: "Všetky" }, { id: "missed", label: "Zmeškané" },
  { id: "received", label: "Prijaté" }, { id: "outbound", label: "Odchádzajúce" },
];
const errorMessage = (error: unknown) => error instanceof MobileApiError ? error.message : "Údaje sa nepodarilo načítať. Skúste znova.";

export default function App() {
  const [generation, setGeneration] = useState(0);
  const [setup] = useState(() => {
    try { return { config: readMobileConfig() }; } catch { return { config: null }; }
  });
  return <SafeAreaProvider><StatusBar style="dark" /><View style={styles.page}>
    <Svg pointerEvents="none" width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" style={StyleSheet.absoluteFill}>
      <Defs><SvgGradient id="dispatch-background" x1="0" y1="0" x2="0" y2="1">
        <Stop offset="0" stopColor="#FFFDF7" /><Stop offset="0.42" stopColor="#F5F6F8" /><Stop offset="1" stopColor="#EDF0F4" />
      </SvgGradient></Defs><Rect width="100" height="100" fill="url(#dispatch-background)" />
    </Svg>
    <SafeAreaView edges={["top", "left", "right"]} style={[styles.page, { backgroundColor: "transparent" }]}>
    {setup.config ? <ConfiguredApp key={generation} config={setup.config} onReset={() => setGeneration(value => value + 1)} /> : <View style={styles.content}>
      <Text style={styles.heading}>Linka pomoci</Text><ErrorNotice message="Aplikácia ešte nie je nastavená. Obráťte sa na správcu." />
    </View>}
  </SafeAreaView></View></SafeAreaProvider>;
}

function ConfiguredApp({ config, onReset }: { config: MobileConfig; onReset: () => void }) {
  const [supabase] = useState(() => createMobileSupabase(config));
  const { client } = supabase;
  const [logout] = useState(() => new SessionLogout(() => client.auth.signOut({ scope: "local" })));
  const logoutState = useSyncExternalStore(logout.subscribe, logout.snapshot, logout.snapshot);
  useEffect(() => () => logout.dispose(), [logout]);
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: {
    staleTime: 15_000, gcTime: 5 * 60_000,
    retry: (count, error) => count < 1 && !(error instanceof MobileApiError && [401, 403, 409, 502].includes(error.status)),
  } } }));
  const [session, setSession] = useState<Session | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState(false);
  const [resetError, setResetError] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [active, setActive] = useState(AppState.currentState === null || AppState.currentState === "active");
  const [authScope] = useState(() => new AuthIncarnation());
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const liveUser = useMemo(() => () => authScope.snapshot().userId, [authScope]);
  const workspaceUser = session?.user.id ?? null;
  const workspaceLiveUser = useMemo(() => () => authScope.current(workspaceUser, sessionEpoch) ? workspaceUser : null, [authScope, workspaceUser, sessionEpoch]);
  useEffect(() => {
    let alive = true;
    let observedEvent = false;
    const { data: { subscription } } = client.auth.onAuthStateChange((event, next) => {
      if (!alive) return;
      observedEvent = true;
      logout.observe(event, next?.user.id ?? null);
      if (authScope.observe(next?.user.id ?? null)) queryClient.clear();
      setSessionEpoch(authScope.snapshot().epoch);
      setSession(next); setBooting(false);
    });
    void client.auth.getSession().then(({ data, error }) => {
      if (!alive) return;
      if (error) setBootError(true);
      if (!observedEvent) { authScope.observe(data.session?.user.id ?? null); setSessionEpoch(authScope.snapshot().epoch); setSession(data.session); logout.observe("INITIAL_SESSION", liveUser()); }
      setBooting(false);
    }).catch(() => { if (alive) { setBootError(true); setBooting(false); } });
    return () => { alive = false; subscription.unsubscribe(); };
  }, [client, queryClient, logout, authScope, liveUser]);
  useEffect(() => {
    const update = (state: string) => {
      const foreground = state === "active";
      setActive(foreground); focusManager.setFocused(foreground);
      if (foreground) client.auth.startAutoRefresh();
      else {
        client.auth.stopAutoRefresh();
        // PushKit cold launch still needs its initial identity to construct the
        // native phone. Let that one request finish even while iOS stays locked.
        void queryClient.cancelQueries({ predicate: query => query.queryKey.at(-1) !== "me" || query.state.data !== undefined });
      }
    };
    update(AppState.currentState ?? "active");
    const subscription = AppState.addEventListener("change", update);
    return () => { subscription.remove(); client.auth.stopAutoRefresh(); };
  }, [client, queryClient]);
  const api = useMemo(() => createMobileApi(config, async () => {
    const expected = authScope.snapshot();
    const { data, error } = await client.auth.getSession();
    if (error) throw new MobileApiError("Prihlásenie sa nepodarilo obnoviť. Skúste znova.", 0);
    if (!authScope.current(expected.userId, expected.epoch) || data.session?.user.id !== expected.userId) throw new MobileApiError("Prihláste sa do aplikácie.", 401);
    return data.session?.access_token ?? null;
  }), [config, client, authScope]);

  return <QueryClientProvider client={queryClient}>
    <View style={s.brand}><View style={s.brandMark}><Phone size={20} strokeWidth={2.3} color={colors.ink} accessible={false} /></View>
      <View style={s.brandText}><Text style={s.brandName}>Linka pomoci</Text><Text style={s.brandCaption}>Mobilný dispečing</Text></View>
      {config.environment === "test" && <Text style={s.testBadge}>TEST</Text>}
    </View>
    {booting ? <Loading label="Obnovujem prihlásenie…" /> : bootError ? <View style={styles.content}>
      <ErrorNotice message={resetError ? "Uložené prihlásenie sa nepodarilo odstrániť. Skúste znova." : "Uložené prihlásenie sa nepodarilo načítať. Môžete ho obnoviť a prihlásiť sa znova."} />
      <Button label="Obnoviť prihlásenie" disabled={resetting} onPress={() => {
        setResetting(true); setResetError(false);
        void supabase.clearStoredSession().then(onReset).catch(() => { setResetError(true); setResetting(false); });
      }} />
    </View> : session ? <Workspace key={config.environment + ":" + session.user.id + ":" + sessionEpoch} config={config} client={client} api={api} active={active} userId={session.user.id}
      liveUser={workspaceLiveUser}
      logoutState={logoutState} onLogout={disconnect => logout.run(disconnect)} />
      : <SignIn client={client} config={config} logoutState={logoutState} />}
  </QueryClientProvider>;
}

function SignIn({ client, config, logoutState }: { client: SupabaseClient; config: MobileConfig; logoutState: LogoutState }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [durableDrafts] = useState(supportsDurableDrafts);
  const passwordInput = useRef<TextInput>(null);
  const insets = useSafeAreaInsets();
  async function login() {
    if (busy || logoutState.busy || !email.trim() || !password) return;
    setBusy(true); setError(null);
    try {
      const { error: denied } = await client.auth.signInWithPassword({ email: email.trim(), password });
      if (denied) setError(denied.status === 400 ? "E-mail alebo heslo nie je správne." : "Prihlásenie sa nepodarilo. Skontrolujte pripojenie a skúste znova.");
      else setPassword("");
    } catch { setError("Prihlásenie sa nepodarilo. Skúste znova."); }
    finally { setBusy(false); }
  }
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={[styles.content, s.signInContent, { paddingBottom: Math.max(28, insets.bottom + 16) }]}>
      <View style={s.signInHero}>
        <View style={s.signInEmblem}><PhoneCall size={38} strokeWidth={1.8} color={colors.ink} accessible={false} /></View>
        <Text accessibilityRole="header" style={s.signInHeading}>Váš dispečing vo vrecku</Text>
        <Text style={[styles.muted, s.signInDescription]}>Prihláste sa svojím účtom Linky pomoci.</Text>
      </View>
      <Card>
        <View><Text style={styles.label}>E-mail</Text><View style={s.inputWrap}>
          <View pointerEvents="none" style={s.inputIcon}><Mail size={19} color={colors.muted} accessible={false} /></View>
          <TextInput accessibilityLabel="E-mail" placeholder="vas@email.sk" placeholderTextColor={colors.muted} value={email} onChangeText={setEmail} style={[styles.input, s.inputWithIcon]}
            selectionColor={colors.brand} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" textContentType="username" editable={!busy && !logoutState.busy}
            returnKeyType="next" onSubmitEditing={() => passwordInput.current?.focus()} />
        </View></View>
        <View><Text style={styles.label}>Heslo</Text><View style={s.inputWrap}>
          <View pointerEvents="none" style={s.inputIcon}><LockKeyhole size={19} color={colors.muted} accessible={false} /></View>
          <TextInput ref={passwordInput} accessibilityLabel="Heslo" placeholder="Vaše heslo" placeholderTextColor={colors.muted} value={password} onChangeText={setPassword} style={[styles.input, s.inputWithIcon]}
            selectionColor={colors.brand} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="current-password" textContentType="password" editable={!busy && !logoutState.busy} returnKeyType="go" onSubmitEditing={() => { void login(); }} />
        </View></View>
        {logoutState.message && <ErrorNotice message={logoutState.message} />}
        {logoutState.busy && <Text style={styles.muted}>Dokončujem odhlásenie…</Text>}
        {error && <ErrorNotice message={error} />}
        <Button label={busy ? "Prihlasujem…" : "Prihlásiť sa"} disabled={busy || logoutState.busy || !email.trim() || !password} onPress={() => { void login(); }} />
        <Button label="Zabudnuté heslo" secondary onPress={() => {
          void Linking.openURL(config.apiOrigin + "/auth/forgot-password?email=" + encodeURIComponent(email.trim())).catch(() => setError("Stránku na obnovu hesla sa nepodarilo otvoriť."));
        }} />
      </Card>
      <Text style={[styles.muted, s.signInFootnote]}>{durableDrafts ? "Aplikácia podporuje chránené uloženie rozpísaných formulárov." : "Koncepty v tomto náhľade ostávajú iba do zatvorenia aplikácie."}</Text>
    </ScrollView>
  </KeyboardAvoidingView>;
}

function Workspace({ config, client, api, active, userId, liveUser, logoutState, onLogout }: { config: MobileConfig; client: SupabaseClient; api: MobileApi; active: boolean; userId: string; liveUser: () => string | null;
  logoutState: LogoutState; onLogout: (disconnect: () => Promise<void>) => Promise<void> }) {
  const [tab, setTab] = useState<Tab>("console");
  const [number, setNumber] = useState("");
  const [category, setCategory] = useState<Category>("all");
  const [search, setSearch] = useState("");
  const [logoutError, setLogoutError] = useState<string | null>(null), [logoutBusy, setLogoutBusy] = useState(false);
  const preparingLogout = useRef(false);
  const { fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const extraNavigationSpace = Math.max(0, navigationContentBottom(fontScale, insets.bottom) - NAVIGATION_CONTENT_BOTTOM);
  useAndroidBack(active && tab !== "console" && tab !== "cases" && tab !== "tasks", () => setTab("console"));
  const key = ["mobile", config.environment, userId];
  // First authenticated snapshot must also load during a PushKit cold launch.
  // Periodic reads still stop when iOS suspends the app.
  const me = useQuery({ queryKey: [...key, "me"], queryFn: ({ signal }) => api.me(signal), refetchInterval: active ? 30_000 : false });
  const identity = usableMobileIdentity(me.data, me.error);
  const { phone, state: phoneState } = useDispatchPhone(config, client, userId, identity?.profileId ?? null, active);
  async function logout(leaveUnsaved = false) {
    const currentPhone = phone?.snapshot();
    if (currentPhone?.call || currentPhone?.termination || preparingLogout.current || logoutState.busy) return;
    preparingLogout.current = true; setLogoutBusy(true); setLogoutError(null);
    try {
      try { await flushAccountDrafts({ environment: config.environment, projectUrl: config.supabaseUrl, userId }); }
      catch { if (!leaveUnsaved) { setLogoutError("Niektoré koncepty sa pred odhlásením nepodarilo uložiť. Skúste miestne uloženie znova alebo sa vedome odhláste bez neuložených zmien."); return; } }
      const afterFlush = phone?.snapshot();
      if (afterFlush?.call || afterFlush?.termination) { setLogoutError("Pred odhlásením ukončite hovor. Koncepty zostali zachované."); return; }
      if (liveUser() === userId) await onLogout(async () => {
        const beforeDisconnect = phone?.snapshot();
        if (beforeDisconnect?.call || beforeDisconnect?.termination) { setLogoutError("Pred odhlásením ukončite hovor. Koncepty zostali zachované."); throw new Error("Active call prevents logout"); }
        await phone?.disconnect();
      });
    } finally { preparingLogout.current = false; setLogoutBusy(false); }
  }
  function logoutWithoutSaving() {
    Alert.alert("Odhlásiť bez neuložených zmien?", "Novšie neuložené údaje sa môžu stratiť. Staršie chránené koncepty zostanú pre tento účet. Zápisy na serveri sa tým nezrušia.", [
      { text: "Zostať", style: "cancel" }, { text: "Odhlásiť bez uloženia", style: "destructive", onPress: () => { void logout(true); } },
    ]);
  }
  if (me.isPending) return <Loading label="Overujem prístup do dispečingu…" />;
  if (!identity) return <View style={styles.content}>
    <ErrorNotice message={errorMessage(me.error)} onRetry={() => { void me.refetch(); }} />
    {logoutState.message && <ErrorNotice message={logoutState.message} />}
    {logoutError && <ErrorNotice message={logoutError} />}
    <Button label="Odhlásiť sa" onPress={() => { void logout(); }} disabled={logoutBusy || logoutState.busy || Boolean(phoneState.call || phoneState.termination)} secondary />
    {logoutError && <Button label="Odhlásiť bez neuložených zmien" onPress={logoutWithoutSaving} disabled={logoutBusy || logoutState.busy || Boolean(phoneState.call || phoneState.termination)} secondary />}
  </View>;
  return <View style={{ flex: 1, paddingBottom: extraNavigationSpace }}>
    <CallPanel phone={phone} state={phoneState} />
    {me.isError && <ErrorNotice message={errorMessage(me.error)} onRetry={() => { void me.refetch(); }} />}
    {tab === "console" ? <Console api={api} me={identity} queryKey={key} active={active} number={number} onNumber={setNumber} phone={phone} phoneState={phoneState} />
      : tab === "history" ? <History api={api} me={identity} queryKey={key} active={active} category={category} onCategory={setCategory} search={search} onSearch={setSearch}
        onSelect={value => { setNumber(value); setTab("console"); }} />
      : null}
    <DraftWorkspace key={identity.profileId} config={config} client={client} identity={identity} userId={userId} liveUser={liveUser} active={active} tab={tab} onTab={setTab}
      onSelectNumber={value => { setNumber(value); setTab("console"); }} logoutState={logoutState} logoutError={logoutError} logoutBusy={logoutBusy}
      hasCall={Boolean(phoneState.call || phoneState.termination)} onLogout={() => { void logout(); }} onLogoutWithoutSaving={logoutWithoutSaving} />
    <GlassTabBar selected={tab} onSelect={setTab} />
  </View>;
}

function Console({ api, me, queryKey, active, number, onNumber, phone, phoneState }: { api: MobileApi; me: MobileMe; queryKey: string[]; active: boolean; number: string; onNumber: (value: string) => void; phone: DispatchPhone | null; phoneState: PhoneState }) {
  const cache = useQueryClient();
  const [changingPresence, setChangingPresence] = useState(false);
  const query = useQuery({ queryKey: [...queryKey, "console", me.profileId], queryFn: ({ signal }) => api.console(me.profileId, signal), enabled: active, refetchInterval: active ? 30_000 : false });
  const readiness = useQuery({ queryKey: [...queryKey, "voice-readiness", me.profileId], queryFn: ({ signal }) => api.voiceReadiness(me.profileId, signal), enabled: active, refetchInterval: active ? 30_000 : false });
  function refreshPhone() { void Promise.allSettled([query.refetch(), readiness.refetch(), phone?.refreshDiagnostics(), cache.invalidateQueries({ queryKey: [...queryKey, "voice-colleagues", me.profileId] })]); }
  async function presence(status: "available" | "paused") {
    if (!phone || changingPresence) return;
    setChangingPresence(true);
    try { await phone.presence(status); await query.refetch(); } catch { /* Phone displays the authorized action's error. */ }
    finally { setChangingPresence(false); }
  }
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.content}
    refreshControl={<RefreshControl refreshing={query.isRefetching || readiness.isRefetching || phoneState.checkingDiagnostics} onRefresh={refreshPhone} />}>
    <View style={s.screenHeading}><Text accessibilityRole="header" style={styles.heading}>Ústredňa</Text><Text style={styles.muted}>{me.profile.displayName}</Text></View>
    {query.isPending ? <Loading /> : query.isError ? <ErrorNotice message={errorMessage(query.error)} onRetry={() => { void query.refetch(); }} /> : query.data && <>
      <Card style={s.presenceCard}><Text style={styles.label}>Váš stav v ústredni</Text><View style={styles.row}>
        <View style={[s.presenceIndicator, { backgroundColor: query.data.presence.status === "available" ? "#E1F5EC" : colors.surfaceMuted }]}>
          <View style={[s.dot, { backgroundColor: query.data.presence.status === "available" ? colors.success : colors.muted }]} />
        </View><Text style={s.presenceTitle}>{presenceLabels[query.data.presence.status]}</Text></View>
        <Text style={styles.muted}>Aktualizované {formatTime(query.data.checkedAt)}</Text>
        {phoneState.registration === "registered" && <View style={styles.row}>{(["available", "paused"] as const).map(status => <View key={status} style={{ flex: 1 }}>
          <Button label={presenceLabels[status]} secondary disabled={changingPresence || phoneState.microphonePermission === "denied" || Boolean(phoneState.call || phoneState.termination) || query.data.presence.status === status}
            onPress={() => { void presence(status); }} />
        </View>)}</View>}
      </Card>
      {query.data.activeCalls.length > 0 && <><Text style={styles.subheading}>Hovory na vašom účte</Text>{query.data.activeCalls.map(call => <Card key={call.id}>
        <Text style={styles.subheading}>{call.name || formatNumber(call.number)}</Text><Text style={styles.text}>{callStatus(call.state)}</Text>
        <Text style={styles.muted}>{call.lineLabel ?? ""}</Text>
      </Card>)}</>}
    </>}
    <PhoneReadinessCard state={phoneState} configuration={readiness.data} configurationError={readiness.isError}
      presence={query.isError ? undefined : query.data?.presence.status} checking={readiness.isFetching || phoneState.checkingDiagnostics}
      onRefresh={refreshPhone} onConnect={() => { void phone?.connect(); }} onTakeover={() => Alert.alert("Prevziať telefón?", "Druhý mobil sa odpojí od ústredne.", [
        { text: "Zrušiť", style: "cancel" }, { text: "Prevziať", onPress: () => { void phone?.connect(true); } },
      ])} />
    {phoneState.retryTarget && !phoneState.dialing && <Card><Text style={styles.subheading}>Nepotvrdené volanie</Text>
      <Text style={styles.text}>{phoneState.retryTarget.kind === "internal" ? phoneState.retryTarget.name : formatNumber(phoneState.retryTarget.number)}</Text>
      <Text style={styles.muted}>Zopakujeme pôvodný pokus o volanie. Tým sa nevytvorí druhý súbežný pokus.</Text>
      <Button label="Zopakovať pôvodné volanie" disabled={!phone || phoneState.registration !== "registered" || phoneState.cancelingAttempt || phoneState.microphonePermission === "denied" || Boolean(phoneState.call || phoneState.termination)}
        onPress={() => { void phone?.retryDial(); }} />
      <Button label={phoneState.cancelingAttempt ? "Ukončujem pôvodný pokus…" : "Ukončiť pôvodný pokus"} secondary
        disabled={!phone || phoneState.registration !== "registered" || phoneState.cancelingAttempt || Boolean(phoneState.call || phoneState.termination)} onPress={() => { void phone?.cancelAttempt(); }} />
    </Card>}
    <Card><View style={styles.row}><View style={s.smallEmblem}><PhoneCall size={20} color={colors.ink} accessible={false} /></View><Text style={styles.subheading}>Nový hovor</Text></View>
      <TextInput accessibilityLabel="Telefónne číslo" placeholder="Telefónne číslo" placeholderTextColor={colors.muted}
      selectionColor={colors.brand} keyboardType="phone-pad" maxLength={40} value={number} onChangeText={onNumber} style={[styles.input, s.phoneInput]} />
      <Button label={phoneState.dialing ? "Vytáčam…" : "Zavolať"} disabled={!phone || phoneState.registration !== "registered" || phoneState.microphonePermission === "denied" || Boolean(phoneState.retryTarget) || !dialable(number) || phoneState.dialing || phoneState.cancelingAttempt || Boolean(phoneState.call || phoneState.termination)}
        onPress={() => { void phone?.dial(number.trim()); }} />
    </Card>
    <ColleaguesCard key={me.profileId} api={api} profileId={me.profileId} queryKey={queryKey} active={active} phone={phone} state={phoneState} />
    </ScrollView>
  </KeyboardAvoidingView>;
}

function History({ api, me, queryKey, active, category, onCategory, search, onSearch, onSelect }: {
  api: MobileApi; me: MobileMe; queryKey: string[]; active: boolean; category: Category; onCategory: (value: Category) => void;
  search: string; onSearch: (value: string) => void; onSelect: (number: string) => void;
}) {
  const [debounced, setDebounced] = useState(search.trim());
  useEffect(() => { const timer = setTimeout(() => setDebounced(search.trim()), 300); return () => clearTimeout(timer); }, [search]);
  const query = useInfiniteQuery({
    queryKey: [...queryKey, "history", me.profileId, category, debounced], enabled: active,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => api.history(me.profileId, { category, q: debounced, cursor: pageParam }, signal),
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
  const pendingSearch = search.trim() !== debounced;
  const denied = query.error instanceof MobileApiError && [401, 403, 409, 502].includes(query.error.status);
  const showCalls = !pendingSearch && !denied && !(query.isError && !query.isFetchNextPageError);
  const calls = [...new Map(query.data?.pages.flatMap(page => page.calls).map(call => [call.id, call]) ?? []).values()];
  return <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={styles.content}
    refreshControl={<RefreshControl refreshing={query.isRefetching && !query.isFetchingNextPage} onRefresh={() => { void query.refetch(); }} />}>
    <Text accessibilityRole="header" style={styles.heading}>História hovorov</Text>
    <View style={s.inputWrap}><View pointerEvents="none" style={s.inputIcon}><Search size={20} color={colors.muted} accessible={false} /></View>
      <TextInput accessibilityLabel="Hľadať hovory" placeholder="Číslo alebo meno" placeholderTextColor={colors.muted} value={search} onChangeText={onSearch} maxLength={160} style={[styles.input, s.inputWithIcon]} autoCorrect={false} selectionColor={colors.brand} />
    </View>
    <View style={s.filters}>{categories.map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityState={{ selected: item.id === category }}
      onPress={() => onCategory(item.id)} style={({ pressed }) => [s.filter, item.id === category && s.filterSelected, pressed && { opacity: 0.75 }]}>
      <Text style={[s.filterText, item.id === category && { color: colors.white }]}>{item.label}</Text></Pressable>)}</View>
    {pendingSearch || query.isPending ? <Loading /> : query.isError && !query.isFetchNextPageError || denied ? <ErrorNotice message={errorMessage(query.error)} onRetry={() => { void query.refetch(); }} />
      : showCalls && <>{calls.length === 0 && <Card><Text style={styles.text}>Žiadne hovory pre tento výber.</Text></Card>}
        {calls.map(call => {
          const DirectionIcon = call.direction === "outbound" ? ArrowUpRight : call.direction === "internal" ? Phone : ArrowDownLeft;
          return <Card key={call.id}><View style={[styles.row, { alignItems: "flex-start" }]}>
            <View style={[s.callIcon, call.status === "missed" && s.missedIcon]}><DirectionIcon size={23} strokeWidth={1.9} color={call.status === "missed" ? colors.danger : colors.ink} accessible={false} /></View>
            <View style={{ flex: 1, gap: 5 }}><Text style={styles.subheading}>{call.name || formatNumber(call.number)}</Text>
              {call.name && <Text style={styles.text}>{formatNumber(call.number)}</Text>}
              <View style={s.callMeta}><Text style={[styles.muted, { color: call.status === "missed" ? colors.danger : colors.muted }]}>{call.direction === "outbound" ? "Odchádzajúci" : call.direction === "internal" ? "Interný" : "Prichádzajúci"}</Text>
                <Text style={styles.muted}>{formatTime(call.startedAt)}</Text></View>
            </View></View>
          <Text style={styles.muted}>{callStatus(call.status)} · {call.lineLabel}{call.durationSeconds === null ? "" : " · " + Math.floor(call.durationSeconds / 60) + ":" + String(Math.floor(call.durationSeconds % 60)).padStart(2, "0")}</Text>
          {call.direction !== "internal" && dialable(call.number) && <Button label="Vybrať číslo" secondary onPress={() => { if (call.number) onSelect(call.number); }} />}
        </Card>; })}
        {query.isFetchNextPageError && <ErrorNotice message={errorMessage(query.error)} onRetry={() => { void query.fetchNextPage(); }} />}
        {query.hasNextPage && !query.isFetchNextPageError && <Button label={query.isFetchingNextPage ? "Načítavam…" : "Ďalšie hovory"} secondary disabled={query.isFetchingNextPage} onPress={() => { void query.fetchNextPage(); }} />}
      </>}
  </ScrollView>;
}

const s = StyleSheet.create({
  brand: { flexDirection: "row", alignItems: "center", gap: 11, paddingHorizontal: 22, paddingVertical: 12 },
  brandMark: { width: 40, height: 40, borderRadius: 14, backgroundColor: colors.brand, alignItems: "center", justifyContent: "center" },
  brandText: { flex: 1, gap: 2 },
  brandName: { fontSize: 17, fontWeight: "700", letterSpacing: -0.4, color: colors.ink },
  brandCaption: { fontSize: 12, color: colors.muted, fontWeight: "500" },
  testBadge: { color: colors.ink, backgroundColor: "#FFF4AF", paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12, fontWeight: "700", fontSize: 10, letterSpacing: 0.8 },
  signInContent: { flexGrow: 1, justifyContent: "center", gap: 22 },
  signInHero: { gap: 12, paddingBottom: 4 },
  signInEmblem: { width: 76, height: 76, borderRadius: 25, backgroundColor: colors.brand, alignItems: "center", justifyContent: "center", marginBottom: 8 },
  signInHeading: { fontSize: 36, lineHeight: 42, letterSpacing: -1.3, fontWeight: "700", color: colors.ink },
  signInDescription: { fontSize: 16, lineHeight: 24 },
  signInFootnote: { textAlign: "center", fontSize: 12, lineHeight: 19, paddingHorizontal: 10 },
  screenHeading: { gap: 5, paddingBottom: 2 },
  inputWrap: { position: "relative" },
  inputIcon: { position: "absolute", left: 16, top: 0, bottom: 0, justifyContent: "center", zIndex: 1 },
  inputWithIcon: { paddingLeft: 46 },
  phoneInput: { fontSize: 21, letterSpacing: 0.3, minHeight: 60, fontVariant: ["tabular-nums"] },
  smallEmblem: { width: 36, height: 36, borderRadius: 12, backgroundColor: "#FFF5B8", alignItems: "center", justifyContent: "center" },
  presenceCard: { backgroundColor: "#FEFEFB" },
  presenceIndicator: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  presenceTitle: { fontSize: 25, fontWeight: "600", letterSpacing: -0.6, color: colors.ink, flexShrink: 1 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  notice: { backgroundColor: "#FFFBEA", borderWidth: 1, borderColor: "#F3E8BC", borderRadius: 22, padding: 18, gap: 6 },
  callIcon: { width: 44, height: 44, borderRadius: 16, backgroundColor: colors.surfaceMuted, alignItems: "center", justifyContent: "center" },
  missedIcon: { backgroundColor: "#FFF0EF" },
  callMeta: { flexDirection: "row", flexWrap: "wrap", gap: 5, columnGap: 12 },
  filters: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  filter: { borderRadius: 22, minHeight: 44, backgroundColor: "#EDEFF2", paddingHorizontal: 15, paddingVertical: 11, alignItems: "center", justifyContent: "center" },
  filterText: { fontSize: 14, fontWeight: "600", color: colors.muted },
  filterSelected: { backgroundColor: colors.ink },
});
