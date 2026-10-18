import { PhoneOverlayProvider } from "./src/ui/phone-overlays";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert, AppState, KeyboardAvoidingView, Linking, Platform, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";
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
import { CallPanel } from "./src/voice/ui";
import { SessionLogout, type LogoutState } from "./src/lib/logout";
import { NAVIGATION_CONTENT_BOTTOM, navigationContentBottom } from "./src/ui/theme";
import type { CallbackDialer } from "./src/callbacks/ui";
import { DispatchShell } from "./src/shell/dispatch-shell";

const errorMessage = (error: unknown) => error instanceof MobileApiError ? error.message : "Údaje sa nepodarilo načítať. Skúste znova.";

export default function App() {
  const [generation, setGeneration] = useState(0);
  const [setup] = useState(() => {
    try { return { config: readMobileConfig() }; } catch { return { config: null }; }
  });
  return <SafeAreaProvider><StatusBar style="dark" /><View style={styles.page}>
    <SafeAreaView edges={["top", "left", "right"]} style={styles.page}>
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

  // Signed in, the top bar shows the environment; before that the brand row does.
  return <QueryClientProvider client={queryClient}>
    {!session && <View style={s.brand}><View style={s.brandMark}><PhoneCall size={18} strokeWidth={2.3} color={colors.ink} accessible={false} /></View>
      <View style={s.brandText}><Text style={s.brandName}>Linka pomoci</Text><Text style={s.brandCaption}>Mobilný dispečing</Text></View>
      {config.environment === "test" && <Text style={s.testBadge}>TEST</Text>}
    </View>}
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
  const [logoutError, setLogoutError] = useState<string | null>(null), [logoutBusy, setLogoutBusy] = useState(false);
  const preparingLogout = useRef(false);
  const { fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const extraNavigationSpace = Math.max(0, navigationContentBottom(fontScale, insets.bottom) - NAVIGATION_CONTENT_BOTTOM);
  const key = useMemo(() => ["mobile", config.environment, userId], [config.environment, userId]);
  // First authenticated snapshot must also load during a PushKit cold launch.
  // Periodic reads still stop when iOS suspends the app.
  const me = useQuery({ queryKey: [...key, "me"], queryFn: ({ signal }) => api.me(signal), refetchInterval: active ? 30_000 : false });
  const identity = usableMobileIdentity(me.data, me.error);
  const { phone, state: phoneState } = useDispatchPhone(config, client, userId, identity?.profileId ?? null, active);
  const callbackSummary = useQuery({ queryKey: [...key, "callback-summary", identity?.profileId], enabled: active && Boolean(identity),
    queryFn: ({ signal }) => api.callbackSummary(identity!.profileId, signal), refetchInterval: active ? 30_000 : false });
  const dialBlocked = !phone ? "Zavolať späť z mobilu bude možné v natívnej aplikácii s pripojeným telefónom. V tomto náhľade môžete požiadavky prevziať a uzavrieť."
    : phoneState.registration !== "registered" ? "Telefón nie je pripojený k ústredni. Pripojte ho v Ústredni."
      : phoneState.microphonePermission === "denied" ? "Na volanie povoľte prístup k mikrofónu."
        : phoneState.call || phoneState.termination ? "Počas hovoru nemožno začať ďalší."
          : phoneState.retryTarget ? "Najprv v Ústredni dokončite nepotvrdené volanie."
            : phoneState.dialing || phoneState.cancelingAttempt ? "Telefón práve vytáča." : null;
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
    <PhoneOverlayProvider blocked={Boolean(phoneState.call || phoneState.termination)} source={phone}>
      <DispatchShell key={identity.profileId} config={config} client={client} api={api} active={active} userId={userId} liveUser={liveUser}
        identity={identity} queryKey={key} meError={me.isError ? me.error : null} onRetryMe={() => { void me.refetch(); }}
        phone={phone} phoneState={phoneState} callbackSummary={callbackSummary} dialer={dialer}
        logoutState={logoutState} logoutError={logoutError} logoutBusy={logoutBusy} onLogout={() => { void logout(); }} onLogoutWithoutSaving={logoutWithoutSaving} />
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
