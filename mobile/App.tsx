import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, AppState, KeyboardAvoidingView, Linking, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { Phone, History as HistoryIcon, UserRound, type LucideIcon } from "lucide-react-native";
import { QueryClient, QueryClientProvider, focusManager, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import type { MobileMe } from "../src/lib/mobile-api";
import { createMobileApi, MobileApiError, type MobileApi } from "./src/lib/api";
import { readMobileConfig, type MobileConfig } from "./src/lib/config";
import { createMobileSupabase } from "./src/lib/supabase";
import { callStatus, dialable, formatNumber, formatTime, presenceLabels } from "./src/lib/display";
import { Button, Card, ErrorNotice, Loading, colors, styles } from "./src/ui";
import { useDispatchPhone } from "./src/voice/use-phone";
import { CallPanel } from "./src/voice/ui";
import type { DispatchPhone, PhoneState } from "./src/voice/phone";

type Tab = "console" | "history" | "account";
type Category = "all" | "missed" | "received" | "outbound";
const tabs: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: "console", label: "Ústredňa", icon: Phone },
  { id: "history", label: "História", icon: HistoryIcon },
  { id: "account", label: "Účet", icon: UserRound },
];
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
  return <SafeAreaProvider><StatusBar style="dark" /><SafeAreaView style={styles.page}>
    {setup.config ? <ConfiguredApp key={generation} config={setup.config} onReset={() => setGeneration(value => value + 1)} /> : <View style={styles.content}>
      <Text style={styles.heading}>Linka pomoci</Text><ErrorNotice message="Aplikácia ešte nie je nastavená. Obráťte sa na správcu." />
    </View>}
  </SafeAreaView></SafeAreaProvider>;
}

function ConfiguredApp({ config, onReset }: { config: MobileConfig; onReset: () => void }) {
  const [supabase] = useState(() => createMobileSupabase(config));
  const { client } = supabase;
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
  const previousUser = useRef<string | null>(null);
  useEffect(() => {
    let alive = true;
    let observedEvent = false;
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, next) => {
      if (!alive) return;
      observedEvent = true;
      if (previousUser.current !== (next?.user.id ?? null)) queryClient.clear();
      previousUser.current = next?.user.id ?? null;
      setSession(next); setBooting(false);
    });
    void client.auth.getSession().then(({ data, error }) => {
      if (!alive) return;
      if (error) setBootError(true);
      if (!observedEvent) { setSession(data.session); previousUser.current = data.session?.user.id ?? null; }
      setBooting(false);
    }).catch(() => { if (alive) { setBootError(true); setBooting(false); } });
    return () => { alive = false; subscription.unsubscribe(); };
  }, [client, queryClient]);
  useEffect(() => {
    const update = (state: string) => {
      const foreground = state === "active";
      setActive(foreground); focusManager.setFocused(foreground);
      if (foreground) client.auth.startAutoRefresh();
      else { client.auth.stopAutoRefresh(); void queryClient.cancelQueries(); }
    };
    update(AppState.currentState ?? "active");
    const subscription = AppState.addEventListener("change", update);
    return () => { subscription.remove(); client.auth.stopAutoRefresh(); };
  }, [client, queryClient]);
  const api = useMemo(() => createMobileApi(config, async () => {
    const { data, error } = await client.auth.getSession();
    if (error) throw new MobileApiError("Prihlásenie sa nepodarilo obnoviť. Skúste znova.", 0);
    return data.session?.access_token ?? null;
  }), [config, client]);

  return <QueryClientProvider client={queryClient}>
    <View style={s.brand}><View style={s.brandMark}><Text style={s.brandInitial}>L</Text></View>
      <Text style={s.brandName}>Linka pomoci</Text>
      {config.environment === "test" && <Text style={s.testBadge}>TEST</Text>}
    </View>
    {booting ? <Loading label="Obnovujem prihlásenie…" /> : bootError ? <View style={styles.content}>
      <ErrorNotice message={resetError ? "Uložené prihlásenie sa nepodarilo odstrániť. Skúste znova." : "Uložené prihlásenie sa nepodarilo načítať. Môžete ho obnoviť a prihlásiť sa znova."} />
      <Button label="Obnoviť prihlásenie" disabled={resetting} onPress={() => {
        setResetting(true); setResetError(false);
        void supabase.clearStoredSession().then(onReset).catch(() => { setResetError(true); setResetting(false); });
      }} />
    </View> : session ? <Workspace key={config.environment + ":" + session.user.id} config={config} client={client} api={api} active={active} userId={session.user.id} />
      : <SignIn client={client} config={config} />}
  </QueryClientProvider>;
}

function SignIn({ client, config }: { client: SupabaseClient; config: MobileConfig }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function login() {
    if (busy || !email.trim() || !password) return;
    setBusy(true); setError(null);
    try {
      const { error: denied } = await client.auth.signInWithPassword({ email: email.trim(), password });
      if (denied) setError(denied.status === 400 ? "E-mail alebo heslo nie je správne." : "Prihlásenie sa nepodarilo. Skontrolujte pripojenie a skúste znova.");
      else setPassword("");
    } catch { setError("Prihlásenie sa nepodarilo. Skúste znova."); }
    finally { setBusy(false); }
  }
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { flexGrow: 1, justifyContent: "center" }]}>
      <View style={{ gap: 8, marginBottom: 14 }}><Text style={styles.heading}>Váš dispečing vo vrecku</Text>
        <Text style={styles.text}>Prihláste sa svojím účtom Linky pomoci.</Text></View>
      <View><Text style={styles.label}>E-mail</Text><TextInput accessibilityLabel="E-mail" value={email} onChangeText={setEmail} style={styles.input}
        autoCapitalize="none" autoCorrect={false} keyboardType="email-address" autoComplete="email" textContentType="username" editable={!busy} /></View>
      <View><Text style={styles.label}>Heslo</Text><TextInput accessibilityLabel="Heslo" value={password} onChangeText={setPassword} style={styles.input}
        secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="current-password" textContentType="password" editable={!busy} returnKeyType="go" onSubmitEditing={() => { void login(); }} /></View>
      {error && <ErrorNotice message={error} />}
      <Button label={busy ? "Prihlasujem…" : "Prihlásiť sa"} disabled={busy || !email.trim() || !password} onPress={() => { void login(); }} />
      <Button label="Zabudnuté heslo" secondary onPress={() => {
        void Linking.openURL(config.apiOrigin + "/auth/forgot-password?email=" + encodeURIComponent(email.trim())).catch(() => setError("Stránku na obnovu hesla sa nepodarilo otvoriť."));
      }} />
    </ScrollView>
  </KeyboardAvoidingView>;
}

function Workspace({ config, client, api, active, userId }: { config: MobileConfig; client: SupabaseClient; api: MobileApi; active: boolean; userId: string }) {
  const [tab, setTab] = useState<Tab>("console");
  const [number, setNumber] = useState("");
  const [category, setCategory] = useState<Category>("all");
  const [search, setSearch] = useState("");
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const key = ["mobile", config.environment, userId];
  // First authenticated snapshot must also load during a PushKit cold launch.
  // Periodic reads still stop when iOS suspends the app.
  const me = useQuery({ queryKey: [...key, "me"], queryFn: ({ signal }) => api.me(signal), refetchInterval: active ? 30_000 : false });
  const { phone, state: phoneState } = useDispatchPhone(config, client, userId, me.isError ? null : me.data?.profileId ?? null, active);
  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true); setLogoutError(null);
    try {
      await phone?.disconnect();
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) setLogoutError("Odhlásenie sa nepodarilo potvrdiť. Skúste znova.");
    } catch { setLogoutError("Odhlásenie sa nepodarilo. Skúste znova."); }
    finally { setLoggingOut(false); }
  }
  if (me.isPending) return <Loading label="Overujem prístup do dispečingu…" />;
  if (me.isError || !me.data) return <View style={styles.content}>
    <ErrorNotice message={errorMessage(me.error)} onRetry={() => { void me.refetch(); }} />
    {logoutError && <ErrorNotice message={logoutError} />}
    <Button label="Odhlásiť sa" onPress={() => { void logout(); }} disabled={loggingOut} secondary />
  </View>;
  return <View style={{ flex: 1 }}>
    <CallPanel phone={phone} state={phoneState} />
    {tab === "console" ? <Console api={api} me={me.data} queryKey={key} active={active} number={number} onNumber={setNumber} phone={phone} phoneState={phoneState} />
      : tab === "history" ? <History api={api} me={me.data} queryKey={key} active={active} category={category} onCategory={setCategory} search={search} onSearch={setSearch}
        onSelect={value => { setNumber(value); setTab("console"); }} />
      : <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.heading}>Účet</Text><Card><Text style={styles.subheading}>{me.data.profile.displayName}</Text>
          <Text style={styles.text}>{me.data.profile.email ?? ""}</Text>
          <Text style={styles.muted}>{({ dispatcher: "Dispečer", senior_dispatcher: "Vedúci dispečer", manager: "Manažér", admin: "Administrátor" })[me.data.profile.role]}</Text>
        </Card><Card><Text style={styles.label}>Prostredie</Text><Text style={styles.text}>{config.environment === "test" ? "Testovací dispečing" : "Produkčný dispečing"}</Text>
          <Text style={styles.muted}>Verzia 0.1.0</Text></Card>
        {logoutError && <ErrorNotice message={logoutError} />}
        {(phoneState.call || phoneState.termination) && <Text style={styles.muted}>Pred odhlásením ukončite hovor.</Text>}
        <Button label={loggingOut ? "Odhlasujem…" : "Odhlásiť sa"} disabled={loggingOut || Boolean(phoneState.call || phoneState.termination)} onPress={() => { void logout(); }} secondary />
      </ScrollView>}
    <View accessibilityRole="tablist" style={s.tabs}>{tabs.map(item => <Pressable key={item.id} accessibilityRole="tab" accessibilityLabel={item.label}
      accessibilityState={{ selected: tab === item.id }} onPress={() => setTab(item.id)} style={s.tab}>
      <View style={[s.tabIcon, tab === item.id && s.tabIconSelected]}><item.icon size={22} color={tab === item.id ? colors.ink : colors.muted} /></View><Text style={[s.tabLabel, tab === item.id && s.selected]}>{item.label}</Text>
    </Pressable>)}</View>
  </View>;
}

function Console({ api, me, queryKey, active, number, onNumber, phone, phoneState }: { api: MobileApi; me: MobileMe; queryKey: string[]; active: boolean; number: string; onNumber: (value: string) => void; phone: DispatchPhone | null; phoneState: PhoneState }) {
  const [changingPresence, setChangingPresence] = useState(false);
  const query = useQuery({ queryKey: [...queryKey, "console", me.profileId], queryFn: ({ signal }) => api.console(me.profileId, signal), enabled: active, refetchInterval: active ? 30_000 : false });
  async function presence(status: "available" | "paused") {
    if (!phone || changingPresence) return;
    setChangingPresence(true);
    try { await phone.presence(status); await query.refetch(); } catch { /* Phone displays the authorized action's error. */ }
    finally { setChangingPresence(false); }
  }
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}
    refreshControl={<RefreshControl refreshing={query.isRefetching} onRefresh={() => { void query.refetch(); }} />}>
    <View style={{ gap: 4 }}><Text style={styles.heading}>Ústredňa</Text><Text style={styles.muted}>{me.profile.displayName}</Text></View>
    {query.isPending ? <Loading /> : query.isError ? <ErrorNotice message={errorMessage(query.error)} onRetry={() => { void query.refetch(); }} /> : query.data && <>
      <Card><Text style={styles.label}>Váš stav v ústredni</Text><View style={styles.row}><View style={[s.dot, { backgroundColor: query.data.presence.status === "available" ? colors.success : colors.muted }]} />
        <Text style={styles.subheading}>{presenceLabels[query.data.presence.status]}</Text></View>
        <Text style={styles.muted}>Aktualizované {formatTime(query.data.checkedAt)}</Text>
        {phoneState.registration === "registered" && <View style={styles.row}>{(["available", "paused"] as const).map(status => <View key={status} style={{ flex: 1 }}>
          <Button label={presenceLabels[status]} secondary disabled={changingPresence || Boolean(phoneState.call || phoneState.termination) || query.data.presence.status === status}
            onPress={() => { void presence(status); }} />
        </View>)}</View>}
      </Card>
      {query.data.activeCalls.length > 0 && <><Text style={styles.subheading}>Hovory na vašom účte</Text>{query.data.activeCalls.map(call => <Card key={call.id}>
        <Text style={styles.subheading}>{call.name || formatNumber(call.number)}</Text><Text style={styles.text}>{callStatus(call.state)}</Text>
        <Text style={styles.muted}>{call.lineLabel ?? ""}</Text>
      </Card>)}</>}
    </>}
    {phoneState.supported ? <Card><Text style={styles.subheading}>{phoneState.registration === "registered" ? "Telefón pripojený" : "Pripojte svoj telefón"}</Text>
      <Text style={styles.muted}>Po pripojení môžete volať. Pre zákaznícke hovory nastavte stav Dostupný.</Text>
      {phoneState.error && <ErrorNotice message={phoneState.error} />}
      {phoneState.registration !== "registered" && <Button label={phoneState.registration === "connecting" ? "Pripájam…" : "Pripojiť telefón"}
        disabled={phoneState.registration === "connecting"} onPress={() => { void phone?.connect(); }} />}
      {phoneState.takeoverRequired && <Button label="Prevziať telefón na tomto iPhone" secondary onPress={() => Alert.alert("Prevziať telefón?", "Druhý mobil sa odpojí od ústredne.", [
        { text: "Zrušiť", style: "cancel" }, { text: "Prevziať", onPress: () => { void phone?.connect(true); } },
      ])} />}
    </Card> : <View style={s.notice}><Text style={[styles.label, { marginBottom: 2 }]}>Systémové hovory</Text>
      <Text style={styles.muted}>Telefonovanie a zvonenie pri zamknutom telefóne pripravujeme vo vlastnej aplikácii Linka pomoci. Tento Expo náhľad slúži na prihlásenie, ústredňu a históriu.</Text></View>}
    <Card><Text style={styles.subheading}>Nový hovor</Text><TextInput accessibilityLabel="Telefónne číslo" placeholder="Telefónne číslo" placeholderTextColor={colors.muted}
      keyboardType="phone-pad" maxLength={40} value={number} onChangeText={onNumber} style={styles.input} />
      <Button label={phoneState.dialing ? "Vytáčam…" : "Zavolať"} disabled={!phone || phoneState.registration !== "registered" || !dialable(number) || phoneState.dialing || Boolean(phoneState.call || phoneState.termination)}
        onPress={() => { void phone?.dial(number.trim()); }} />
    </Card>
  </ScrollView>;
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
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}
    refreshControl={<RefreshControl refreshing={query.isRefetching && !query.isFetchingNextPage} onRefresh={() => { void query.refetch(); }} />}>
    <Text style={styles.heading}>História hovorov</Text>
    <TextInput accessibilityLabel="Hľadať hovory" placeholder="Číslo alebo meno" placeholderTextColor={colors.muted} value={search} onChangeText={onSearch} maxLength={160} style={styles.input} autoCorrect={false} />
    <View style={s.filters}>{categories.map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityState={{ selected: item.id === category }}
      onPress={() => onCategory(item.id)} style={[s.filter, item.id === category && s.filterSelected]}><Text style={[styles.muted, item.id === category && { color: colors.white }]}>{item.label}</Text></Pressable>)}</View>
    {pendingSearch || query.isPending ? <Loading /> : query.isError && !query.isFetchNextPageError || denied ? <ErrorNotice message={errorMessage(query.error)} onRetry={() => { void query.refetch(); }} />
      : showCalls && <>{calls.length === 0 && <Card><Text style={styles.text}>Žiadne hovory pre tento výber.</Text></Card>}
        {calls.map(call => <Card key={call.id}><View style={[styles.row, { justifyContent: "space-between" }]}>
          <Text style={[styles.muted, { color: call.status === "missed" ? colors.danger : colors.ink }]}>{call.direction === "outbound" ? "Odchádzajúci" : call.direction === "internal" ? "Interný" : "Prichádzajúci"}</Text>
          <Text style={styles.muted}>{formatTime(call.startedAt)}</Text></View>
          <Text style={styles.subheading}>{call.name || formatNumber(call.number)}</Text>
          {call.name && <Text style={styles.text}>{formatNumber(call.number)}</Text>}
          <Text style={styles.muted}>{callStatus(call.status)} · {call.lineLabel}{call.durationSeconds === null ? "" : " · " + Math.floor(call.durationSeconds / 60) + ":" + String(Math.floor(call.durationSeconds % 60)).padStart(2, "0")}</Text>
          {dialable(call.number) && <Button label="Vybrať číslo" secondary onPress={() => { if (call.number) onSelect(call.number); }} />}
        </Card>)}
        {query.isFetchNextPageError && <ErrorNotice message={errorMessage(query.error)} onRetry={() => { void query.fetchNextPage(); }} />}
        {query.hasNextPage && !query.isFetchNextPageError && <Button label={query.isFetchingNextPage ? "Načítavam…" : "Ďalšie hovory"} secondary disabled={query.isFetchingNextPage} onPress={() => { void query.fetchNextPage(); }} />}
      </>}
  </ScrollView>;
}

const s = StyleSheet.create({
  brand: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 20, paddingVertical: 14, borderTopWidth: 5, borderTopColor: colors.brand, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.white },
  brandMark: { width: 32, height: 32, borderRadius: 10, backgroundColor: colors.brand, alignItems: "center", justifyContent: "center" },
  brandInitial: { color: colors.ink, fontWeight: "800", fontSize: 22 },
  brandName: { fontSize: 17, fontWeight: "700", color: colors.ink, flex: 1 },
  testBadge: { color: colors.ink, backgroundColor: colors.brand, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, fontWeight: "700", fontSize: 11 },
  tabs: { flexDirection: "row", backgroundColor: colors.white, paddingVertical: 9, borderTopWidth: 1, borderTopColor: colors.border },
  tab: { flex: 1, alignItems: "center", justifyContent: "center", gap: 3, minHeight: 50 },
  tabIcon: { paddingHorizontal: 14, paddingVertical: 5, borderRadius: 10 },
  tabIconSelected: { backgroundColor: colors.brand },
  tabLabel: { color: colors.muted, fontSize: 12, fontWeight: "600" },
  selected: { color: colors.ink },
  dot: { width: 10, height: 10, borderRadius: 5 },
  notice: { backgroundColor: colors.notice, borderWidth: 1, borderColor: colors.noticeBorder, borderRadius: 14, padding: 16, gap: 5 },
  filters: { flexDirection: "row", gap: 7, flexWrap: "wrap" },
  filter: { borderRadius: 18, backgroundColor: colors.surfaceMuted, paddingHorizontal: 12, paddingVertical: 8 },
  filterSelected: { backgroundColor: colors.ink },
});
