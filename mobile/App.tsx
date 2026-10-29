import { PhoneOverlayProvider } from "./src/ui/phone-overlays";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert, AppState, KeyboardAvoidingView, Linking, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { LockKeyhole, Mail, PhoneCall } from "lucide-react-native";
import { QueryClient, QueryClientProvider, focusManager, useQuery } from "@tanstack/react-query";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { createMobileApi, MobileApiError, usableMobileIdentity, type MobileApi } from "./src/lib/api";
import { readMobileConfig, type MobileConfig } from "./src/lib/config";
import { createMobileSupabase } from "./src/lib/supabase";
import { Button, Card, ErrorNotice, Loading, colors, styles } from "./src/ui";
import { useDispatchPhone } from "./src/voice/use-phone";
import { flushAccountDrafts } from "./src/drafts/vault";
import { AuthIncarnation } from "./src/lib/auth-incarnation";
import { supportsDurableDrafts } from "./src/drafts/storage";
import { SessionLogout, type LogoutState } from "./src/lib/logout";
import type { CallbackDialer } from "./src/callbacks/ui";
import { dialBlockedReason } from "./src/voice/dial";
import { DispatchShell } from "./src/shell/dispatch-shell";
import { appVersion, olderThan } from "./src/lib/app-version";
import { fetchAppStatus } from "./src/lib/app-status";
import { createErrorReporter, installGlobalErrorReporting, keepError } from "./src/lib/error-reporting";
import { flushKeptWithProbeFailure } from "./src/voice/probe";
import { AppErrorBoundary, ErrorReporterContext } from "./src/ui/error-boundary";
import { UpdateRequired } from "./src/ui/update-required";
import { createPushApi } from "./src/notifications/api";
import { createPushDevice, installPushTaps } from "./src/notifications/device";
import { PushSettings } from "./src/notifications/settings";
import { pushTaps } from "./src/notifications/taps";
import { useDeliverySession } from "./src/delivery/session";
import { haltBackgroundSharing } from "./src/delivery/native-sharing";
import { FieldShell } from "./src/shell/field-shell";
import { useFieldWork } from "./src/field-work/session";
import { hasField } from "./src/shell/modules";

const errorMessage = (error: unknown) => error instanceof MobileApiError ? error.message : "Údaje sa nepodarilo načítať. Skúste znova.";
/** The server's answer "signed in, but not a dispatcher": a pristavovač. Kept as the
 * query's data, so a later failed check on a weak signal does not drop their screen. */
const FIELD_ONLY = { fieldOnly: true } as const;

export default function App() {
  const [generation, setGeneration] = useState(0);
  // Before any sign-in: a tap that started the app waits for its workspace.
  useEffect(() => installPushTaps(pushTaps), []);
  const [setup] = useState(() => {
    try { return { config: readMobileConfig() }; } catch { return { config: null }; }
  });
  return <SafeAreaProvider><StatusBar style="dark" /><View style={styles.page}>
    <SafeAreaView edges={["top", "left", "right"]} style={styles.page}>
    {/* Last of all: a crash outside the signed-in workspace is kept on the device and the app restarts its frame. */}
    <AppErrorBoundary reporter={null} onReset={() => setGeneration(value => value + 1)} onCatch={error => keepError(error)}
      message="Aplikácia narazila na chybu. Skúste to znova; ak sa chyba opakuje, zatvorte aplikáciu a otvorte ju znova.">
    {setup.config ? <ConfiguredApp key={generation} config={setup.config} onReset={() => setGeneration(value => value + 1)} /> : <View style={styles.content}>
      <Text style={styles.heading}>Dispatching</Text><ErrorNotice message="Aplikácia ešte nie je nastavená. Obráťte sa na správcu." />
    </View>}
    </AppErrorBoundary>
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
      // Signed out, also by an expired session: no more position from this phone.
      if (event === "SIGNED_OUT") void haltBackgroundSharing();
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
  // Errors are reported only for a signed-in operator; reporting never interrupts work.
  const reporter = useMemo(() => createErrorReporter(config, async () => (await client.auth.getSession()).data.session?.access_token ?? null), [config, client]);
  useEffect(() => installGlobalErrorReporting(reporter), [reporter]);
  // A crash kept on the device goes out once its own user is signed in again; so does a
  // production calling build's failed boot proof (that build runs without calling).
  const sessionUser = session?.user.id ?? null;
  useEffect(() => { reporter.setUser(sessionUser); if (sessionUser) void flushKeptWithProbeFailure(reporter); }, [sessionUser, reporter]);
  // The release gate is decided once, before the workspace and its phone start; an answer
  // after 2.5 s waits for the next launch, so the gate never closes a running call.
  const [version] = useState(appVersion);
  // Launched in the background for an incoming call, the phone must not wait for it at all.
  const [release, setRelease] = useState<{ decided: boolean; minimum: string | null; updateUrl: string | null; attempt: number }>(() =>
    ({ decided: AppState.currentState === "background", minimum: null, updateUrl: null, attempt: 0 }));
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); setRelease(value => value.decided ? value : { ...value, decided: true }); }, 2500);
    void fetchAppStatus(config, fetch, controller.signal).then(status => {
      clearTimeout(timer);
      setRelease(value => value.decided ? value : { ...value, decided: true, minimum: status?.minimumVersion ?? null, updateUrl: status?.updateUrl ?? null });
    });
    return () => { clearTimeout(timer); controller.abort(); };
  }, [config, release.attempt]);
  if (release.decided && release.minimum && olderThan(version.version, release.minimum)) return <QueryClientProvider client={queryClient}>
    <BrandRow test={config.environment === "test"} />
    <UpdateRequired version={version} minimum={release.minimum} updateUrl={release.updateUrl} onRetry={() => setRelease(value => ({ decided: false, minimum: null, updateUrl: null, attempt: value.attempt + 1 }))} />
  </QueryClientProvider>;

  // Signed in, the top bar shows the environment; before that the brand row does.
  return <QueryClientProvider client={queryClient}>
    {!session && <BrandRow test={config.environment === "test"} />}
    {booting || !release.decided ? <Loading label="Obnovujem prihlásenie…" /> : bootError ? <View style={styles.content}>
      <ErrorNotice message={resetError ? "Uložené prihlásenie sa nepodarilo odstrániť. Skúste znova." : "Uložené prihlásenie sa nepodarilo načítať. Môžete ho obnoviť a prihlásiť sa znova."} />
      <Button label="Obnoviť prihlásenie" disabled={resetting} onPress={() => {
        setResetting(true); setResetError(false);
        void supabase.clearStoredSession().then(onReset).catch(() => { setResetError(true); setResetting(false); });
      }} />
    </View> : session ? <ErrorReporterContext.Provider value={reporter}>
      {/* Last resort only: screens have their own boundary inside the shell, below the phone. */}
      <AppErrorBoundary reporter={reporter} onReset={() => queryClient.removeQueries({ predicate: query => query.queryKey.at(-1) !== "me" })}><Workspace key={config.environment + ":" + session.user.id + ":" + sessionEpoch} config={config} client={client} api={api} active={active} userId={session.user.id}
      liveUser={workspaceLiveUser}
      logoutState={logoutState} onLogout={disconnect => logout.run(disconnect)} /></AppErrorBoundary></ErrorReporterContext.Provider>
      : <SignIn client={client} config={config} logoutState={logoutState} />}
  </QueryClientProvider>;
}

function BrandRow({ test }: { test: boolean }) {
  return <View style={s.brand}><View style={s.brandMark}><PhoneCall size={18} strokeWidth={2.3} color={colors.ink} accessible={false} /></View>
    <View style={s.brandText}><Text style={s.brandName}>Dispatching</Text><Text style={s.brandCaption}>Mobilný dispečing Linky pomoci</Text></View>
    {test && <Text style={s.testBadge}>TEST</Text>}
  </View>;
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
        <Text accessibilityRole="header" style={s.signInHeading}>Linka pomoci v teréne aj na dispečingu</Text>
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
  const [logoutError, setLogoutError] = useState<string | null>(null), [logoutBusy, setLogoutBusy] = useState(false);
  const preparingLogout = useRef(false);
  const key = useMemo(() => ["mobile", config.environment, userId], [config.environment, userId]);
  // First authenticated snapshot must also load during a PushKit cold launch.
  // Periodic reads still stop when iOS suspends the app.
  const me = useQuery({ queryKey: [...key, "me"], queryFn: async ({ signal }) => {
    try { return await api.me(signal); }
    catch (error) { if (error instanceof MobileApiError && error.code === "mobile_no_dispatch_profile") return FIELD_ONLY; throw error; }
  }, refetchInterval: query => !active ? false : query.state.data && "fieldOnly" in query.state.data ? 300_000 : 30_000 });
  // Signed in without a dispatch profile: a pristavovač, who gets the deliveries instead.
  // The query may hold a copy of the marker, so its shape is what counts.
  const fieldOnly = Boolean(me.data && "fieldOnly" in me.data);
  const identity = usableMobileIdentity(me.data && !("fieldOnly" in me.data) ? me.data : undefined, me.error);
  const { phone, state: phoneState } = useDispatchPhone(config, client, userId, identity?.profileId ?? null, active);
  const push = useMemo(() => new PushSettings(createPushDevice(config.environment, userId), createPushApi(config, async () => {
    if (liveUser() !== userId) throw new MobileApiError("Prihlásenie sa zmenilo. Otvorte svoj účet znova.", 401);
    const { data } = await client.auth.getSession();
    return liveUser() === userId && data.session?.user.id === userId ? data.session.access_token : null;
  })), [config, client, userId, liveUser]);
  useEffect(() => () => push.dispose(), [push]);
  // Pristavenia: a pristavovač alone, or a dispatcher who also delivers (one app, both modules).
  const delivery = useDeliverySession({ config, client, userId, liveUser, active, enabled: Boolean(identity) || fieldOnly, writable: !logoutBusy && !logoutState.busy });
  // Moja práca and Pobočka of the same field membership.
  const work = useFieldWork({ delivery, config, client, userId, liveUser, active, writable: !logoutBusy && !logoutState.busy });
  const refreshingAccess = useRef(false);
  const [accessRefreshState, setAccessRefreshState] = useState({ busy: false, error: null as string | null, message: null as string | null });
  async function refreshAccess() {
    if (refreshingAccess.current || logoutBusy || logoutState.busy || liveUser() !== userId) return;
    refreshingAccess.current = true;
    setAccessRefreshState({ busy: true, error: null, message: null });
    try {
      const [profile, field] = await Promise.all([me.refetch(), delivery.refresh()]);
      if (liveUser() !== userId) return;
      setAccessRefreshState({ busy: false,
        error: !profile.isSuccess || field === "failed" ? "Prístupy sa nepodarilo obnoviť. Skontrolujte pripojenie a skúste znova." : null,
        message: profile.isSuccess && field !== "failed" ? "Dostupné moduly sú obnovené." : null });
    } catch {
      if (liveUser() === userId) setAccessRefreshState({ busy: false, error: "Prístupy sa nepodarilo obnoviť. Skúste znova.", message: null });
    } finally { refreshingAccess.current = false; }
  }
  const accessRefresh = { ...accessRefreshState, refresh: refreshAccess };
  // A phone switched on earlier refreshes its registration quietly at start and on return.
  const verifiedProfile = identity?.profileId ?? null, verifiedMember = delivery.memberId;
  useEffect(() => { if (active && (verifiedProfile || verifiedMember)) void push.resume(); }, [active, verifiedProfile, verifiedMember, push]);
  const callbackSummary = useQuery({ queryKey: [...key, "callback-summary", identity?.profileId], enabled: active && Boolean(identity),
    queryFn: ({ signal }) => api.callbackSummary(identity!.profileId, signal), refetchInterval: active ? 30_000 : false });
  const dialBlocked = dialBlockedReason(phone, phoneState, "Zavolať späť z mobilu bude možné v natívnej aplikácii s pripojeným telefónom. V tomto náhľade môžete požiadavky prevziať a uzavrieť.");
  const dialer: CallbackDialer = { available: dialBlocked === null, reason: dialBlocked, dial: async (id, value, verificationId) => {
    if (!phone) return "Telefón nie je dostupný.";
    if (!await phone.dialCallback(id, value, verificationId)) return phone.snapshot().error ?? "Telefón práve nie je pripravený na nový hovor. Skúste to znova.";
    return phone.snapshot().error;
  } };
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
        // Notices for this account stop reaching the phone; the choice stays for the next sign-in.
        await push.forget();
        // Nothing more about this person's position leaves the phone.
        // The two revocations run one after another (4 s each at most); sign-out then halts both anyway.
        await Promise.race([Promise.all([work?.forget(), delivery.location.forget()]), new Promise(resolve => setTimeout(resolve, 9_000))]);
      });
    } finally { preparingLogout.current = false; setLogoutBusy(false); }
  }
  function logoutWithoutSaving() {
    Alert.alert("Odhlásiť bez neuložených zmien?", "Novšie neuložené údaje sa môžu stratiť. Staršie chránené koncepty zostanú pre tento účet. Zápisy na serveri sa tým nezrušia.", [
      { text: "Zostať", style: "cancel" }, { text: "Odhlásiť bez uloženia", style: "destructive", onPress: () => { void logout(true); } },
    ]);
  }
  if (me.isPending) return <><BrandRow test={config.environment === "test"} /><Loading label="Overujem prístup do aplikácie…" /></>;
  // A membership with only office roles (billing, reports…) has nothing in the app yet.
  if (fieldOnly && delivery.memberId && !hasField(delivery.modules)) return <><BrandRow test={config.environment === "test"} /><View style={styles.content}>
    <Text accessibilityRole="header" style={styles.subheading}>V aplikácii pre vás zatiaľ nie je modul</Text>
    <Text style={styles.muted}>Váš účet nemá pristavenia, jazdy, odťahy ani pobočku. Prácu kancelárie nájdete na webe dispečingu.</Text>
    <Button label="Skontrolovať prístup znova" secondary disabled={accessRefreshState.busy} onPress={() => { void refreshAccess(); }} />
    {accessRefreshState.error && <ErrorNotice message={accessRefreshState.error} />}
    {logoutState.message && <ErrorNotice message={logoutState.message} />}
    {logoutError && <ErrorNotice message={logoutError} />}
    <Button label="Odhlásiť sa" onPress={() => { void logout(); }} disabled={logoutBusy || logoutState.busy} secondary />
  </View></>;
  if (fieldOnly && delivery.memberId) return <FieldShell key={delivery.memberId} config={config} active={active} userId={userId} session={delivery} work={work} push={push}
    logoutState={logoutState} logoutError={logoutError} logoutBusy={logoutBusy} onLogout={() => { void logout(); }} accessRefresh={accessRefresh} />;
  if (fieldOnly && delivery.me.isPending) return <><BrandRow test={config.environment === "test"} /><Loading label="Overujem prístup do aplikácie…" /></>;
  if (fieldOnly) return <><BrandRow test={config.environment === "test"} /><View style={styles.content}>
    <ErrorNotice message={errorMessage(delivery.error)} onRetry={() => { void refreshAccess(); }} />
    {logoutState.message && <ErrorNotice message={logoutState.message} />}
    {logoutError && <ErrorNotice message={logoutError} />}
    <Button label="Odhlásiť sa" onPress={() => { void logout(); }} disabled={logoutBusy || logoutState.busy} secondary />
  </View></>;
  if (!identity) return <><BrandRow test={config.environment === "test"} /><View style={styles.content}>
    <ErrorNotice message={errorMessage(me.error)} onRetry={() => { void me.refetch(); }} />
    {logoutState.message && <ErrorNotice message={logoutState.message} />}
    {logoutError && <ErrorNotice message={logoutError} />}
    <Button label="Odhlásiť sa" onPress={() => { void logout(); }} disabled={logoutBusy || logoutState.busy || Boolean(phoneState.call || phoneState.termination)} secondary />
    {logoutError && <Button label="Odhlásiť bez neuložených zmien" onPress={logoutWithoutSaving} disabled={logoutBusy || logoutState.busy || Boolean(phoneState.call || phoneState.termination)} secondary />}
  </View></>;
  return <View style={{ flex: 1 }}>
    <PhoneOverlayProvider blocked={Boolean(phoneState.call || phoneState.termination)} source={phone}>
      <DispatchShell key={identity.profileId} config={config} client={client} api={api} active={active} userId={userId} liveUser={liveUser}
        identity={identity} queryKey={key} meError={me.isError ? me.error : null} onRetryMe={() => { void me.refetch(); }}
        phone={phone} phoneState={phoneState} callbackSummary={callbackSummary} dialer={dialer}
        logoutState={logoutState} logoutError={logoutError} logoutBusy={logoutBusy} onLogout={() => { void logout(); }} onLogoutWithoutSaving={logoutWithoutSaving} push={push}
        delivery={delivery.memberId ? delivery : null} work={work} accessRefresh={accessRefresh} />
    </PhoneOverlayProvider>
  </View>;
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
  inputWrap: { position: "relative" },
  inputIcon: { position: "absolute", left: 16, top: 0, bottom: 0, justifyContent: "center", zIndex: 1 },
  inputWithIcon: { paddingLeft: 46 },
});
