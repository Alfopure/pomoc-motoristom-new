import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AccessibilityInfo, Linking, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MapPin } from "lucide-react-native";
import type { MobileConfig } from "../lib/config";
import type { LogoutState } from "../lib/logout";
import { appVersion, versionLabel } from "../lib/app-version";
import { useAndroidBack } from "../lib/use-android-back";
import { InfoRow } from "../design/detail";
import { formLayout } from "../design/form";
import { Group, Row, SectionHeader } from "../design/list";
import { palette, radius, space, type } from "../design/tokens";
import { ErrorNotice, styles } from "../ui";
import { NAVIGATION_CONTENT_BOTTOM, navigationContentBottom } from "../ui/theme";
import { DeliveryModule, DeliveryRow } from "../delivery/module";
import { canUseDeliveryCache, isOpen, sortDeliveries, visibleDelivery } from "../delivery/model";
import { useDeliveryTime } from "../delivery/use-delivery-time";
import type { DeliverySession } from "../delivery/session";
import type { SharingState } from "../delivery/sharing";
import type { PushSettings } from "../notifications/settings";
import { pushTaps } from "../notifications/taps";
import { NotificationSettings } from "../notifications/ui";
import { ShellBackContext } from "./back";
import { ShellBackStore } from "./back-store";
import { DoneButton, EditBarContent } from "./edit-bar";
import { todayLabel } from "./home";
import { DELIVERY_ROLE_NAME, PIN_LIMIT, moduleAccess, moduleById, rolePins, type ModuleId } from "./modules";
import { ModulesScreen, type ModuleAccessRefresh } from "./modules-screen";
import { barTabs, dispatchView, initialShell, openModule, reconcileShell, selectTab, shellBack, type ShellState, type ShellTab } from "./navigation";
import { ModulesMark, Sheet, shellStyles, tabLabel } from "./parts";
import { ShellPreferences, shellPreferencesKey } from "./preferences";
import { createShellPreferencesStorage } from "./preferences-storage";
import { DockTabBar } from "./tab-bar";
import { ShellTopBar, initialsOf, type PresenceTone } from "./top-bar";

type Props = {
  config: MobileConfig; active: boolean; userId: string; session: DeliverySession; push: PushSettings;
  logoutState: LogoutState; logoutError: string | null; logoutBusy: boolean; onLogout: () => void;
  accessRefresh: ModuleAccessRefresh;
};
const ACCOUNT_LINKS = [
  { title: "Ochrana súkromia", path: "/aplikacia/sukromie" },
  { title: "Podpora", path: "/aplikacia/podpora" },
] as const;
/** The top bar's status for a pristavovač: whether dispatch sees where they are. */
export function locationStatus(state: SharingState, open: number): { label: string; tone: PresenceTone } {
  if (state.status === "sharing") return { label: "Poloha zapnutá", tone: "green" };
  if (state.status === "denied") return { label: "Poloha nepovolená", tone: "orange" };
  if (state.status === "error") return { label: "Poloha nefunguje", tone: "red" };
  return { label: open ? "Poloha vypnutá" : "Bez pristavenia", tone: "gray" };
}

/** The same app for someone who only delivers: Prehľad · their modules · Moduly,
 * the same top bar and account, without any dispatch module. */
export function FieldShell(props: Props) {
  const { config, active, userId, session } = props;
  const memberId = session.memberId!;
  const insets = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const available = useMemo(() => moduleAccess(null, true), []);
  const prefs = useMemo(() => new ShellPreferences(createShellPreferencesStorage(),
    shellPreferencesKey({ environment: config.environment, userId, profileId: memberId }), available, rolePins(null, true)), [config.environment, userId, memberId, available]);
  useEffect(() => () => prefs.dispose(), [prefs]);
  const preferences = useSyncExternalStore(prefs.subscribe, prefs.snapshot, prefs.snapshot);
  useEffect(() => { if (active && !preferences.loaded) void prefs.load(); }, [active, preferences.loaded, prefs]);
  const pins = preferences.pins;
  const [shell, setShell] = useState<ShellState>(initialShell);
  const nav = reconcileShell(shell, pins, available);
  const view = dispatchView(nav);
  const [editing, setEditing] = useState(false);
  const [backStore] = useState(() => new ShellBackStore());
  const moduleBack = useSyncExternalStore(backStore.subscribe, backStore.snapshot, backStore.snapshot);
  const location = useSyncExternalStore(session.location.subscribe, session.location.snapshot, session.location.snapshot);
  const [openRequest, setOpenRequest] = useState<{ id: string; nonce: number } | null>(null);
  const go = (next: ShellState) => setShell(next);
  const navigate = (id: ModuleId) => go(openModule(nav, pins, id));
  const back = () => { const next = shellBack(nav); if (next) go(next); };
  const openDelivery = (id: string) => { navigate("pristavenia"); setOpenRequest(value => ({ id, nonce: (value?.nonce ?? 0) + 1 })); };
  // A tapped delivery notice opens its delivery, in the account it was sent to.
  useEffect(() => {
    const consume = () => {
      const tap = pushTaps.snapshot();
      if (tap?.target.kind !== "delivery") return;
      const target = pushTaps.take(memberId);
      if (target?.kind === "delivery") {
        setShell(current => openModule(reconcileShell(current, pins, available), pins, "pristavenia"));
        setOpenRequest(value => ({ id: target.id, nonce: (value?.nonce ?? 0) + 1 }));
      }
    };
    const unsubscribe = pushTaps.subscribe(consume);
    const pending = setTimeout(consume, 0);
    return () => { unsubscribe(); clearTimeout(pending); };
  }, [memberId, pins, available]);
  // A delivery opened in the module owns Back first; then the account and Moduly.
  useAndroidBack(active && (nav.account || nav.tab === "moduly" && nav.opened !== null && !moduleBack), back);
  const now = useDeliveryTime(active);
  const deliveries = sortDeliveries(canUseDeliveryCache(session.list.error) ? (session.list.data ?? []).map(delivery => visibleDelivery(delivery, now)) : [], now);
  const open = deliveries.filter(delivery => isOpen(delivery, now));
  const status = locationStatus(location, open.length);
  const tabs = barTabs(pins);
  const showAdd = pins.length < Math.min(PIN_LIMIT, available.length);
  const openedInModules = nav.tab === "moduly" && nav.opened !== null && !nav.account;
  const left = moduleBack && !nav.account ? { kind: "back" as const, label: moduleBack.label, onPress: moduleBack.onBack, disabled: moduleBack.disabled }
    : nav.account ? { kind: "back" as const, label: nav.tab === "moduly" && nav.opened ? moduleById(nav.opened).short : tabLabel(nav.tab), onPress: back }
      : openedInModules ? { kind: "back" as const, label: "Moduly", onPress: back }
        : { kind: "status" as const, label: status.label, tone: status.tone, onPress: () => navigate("pristavenia"), accessibilityLabel: "Poloha pre dispečing: " + status.label + ". Otvoriť pristavenia" };
  const extraNavigationSpace = Math.max(0, navigationContentBottom(fontScale, insets.bottom) - NAVIGATION_CONTENT_BOTTOM);
  return <View style={{ flex: 1 }}><ShellBackContext.Provider value={backStore}><View style={{ flex: 1, paddingBottom: extraNavigationSpace }}>
    <ShellTopBar test={config.environment === "test"} initials={initialsOf(session.me.data?.member.displayName ?? "?")} onAccount={() => go({ ...nav, account: true })} left={left} />
    {view === "home" && <FieldHome open={open} location={location} status={status} tip={preferences.loaded && !preferences.tipDismissed}
      onDismissTip={() => prefs.dismissTip()} onOpen={openDelivery} onModule={() => navigate("pristavenia")} error={session.list.isError ? session.list.error : null}
      onRefresh={() => { void props.accessRefresh.refresh(); }} />}
    {view === "modules" && <ModulesScreen available={available} pins={pins} tabs={tabs} showAdd={showAdd} badges={{ pristavenia: open.length }}
      onOpen={id => navigate(id)} onMenu={() => setEditing(true)} onEdit={() => setEditing(true)} onAccount={() => go({ ...nav, account: true })} accessRefresh={props.accessRefresh} />}
    {view === "account" && <FieldAccount {...props} name={session.me.data?.member.displayName ?? ""} email={session.me.data?.member.email ?? null} onEditBar={() => setEditing(true)} />}
    <View style={view === "deliveries" ? { flex: 1 } : { display: "none" }}>
      <DeliveryModule session={session} active={active} visible={view === "deliveries"} openRequest={openRequest} />
    </View>
  </View></ShellBackContext.Provider>
    <DockTabBar tabs={tabs} selected={nav.account ? null : nav.tab} badges={{ pristavenia: open.length }} showAdd={showAdd}
      onSelect={(tab: ShellTab) => go(selectTab(nav, tab))} onAdd={() => setEditing(true)} />
    <Sheet visible={editing} large onClose={() => setEditing(false)} title="Upraviť lištu" right={<DoneButton onPress={() => setEditing(false)} />}>
      <EditBarContent pins={pins} available={available} roleLabel={DELIVERY_ROLE_NAME} customized={preferences.customized} saveError={preferences.saveError}
        onChange={(next, message) => { prefs.setPins(next); AccessibilityInfo.announceForAccessibility?.(message); }}
        onReset={() => { prefs.reset(); AccessibilityInfo.announceForAccessibility?.("Lišta je podľa roly"); }} />
    </Sheet>
  </View>;
}

/** Prehľad of a pristavovač: what is waiting for them and whether dispatch sees them. */
function FieldHome({ open, location, status, tip, onDismissTip, onOpen, onModule, error, onRefresh }: {
  open: ReturnType<typeof sortDeliveries>; location: SharingState; status: { label: string; tone: PresenceTone }; tip: boolean;
  onDismissTip: () => void; onOpen: (id: string) => void; onModule: () => void; error: unknown; onRefresh: () => void;
}) {
  const tones: Record<PresenceTone, [string, string]> = { green: [palette.greenSoft, palette.greenText], orange: [palette.orangeSoft, palette.orangeText],
    red: [palette.redSoft, palette.redText], gray: [palette.fill, palette.secondaryLabel] };
  const [soft, ink] = tones[status.tone];
  return <ScrollView contentContainerStyle={{ paddingBottom: NAVIGATION_CONTENT_BOTTOM }}>
    <View style={s.titleRow}><Text accessibilityRole="header" style={s.title}>Prehľad</Text><Text style={s.date}>{todayLabel()}</Text></View>
    <Pressable accessibilityRole="button" accessibilityLabel={"Poloha pre dispečing: " + status.label} onPress={onModule} style={({ pressed }) => [s.card, pressed && { opacity: 0.85 }]}>
      <View style={[s.cardIcon, { backgroundColor: soft }]}><MapPin size={16} color={ink} accessible={false} /></View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={s.cardTitle}>{status.label}</Text>
        <Text style={s.cardText}>{location.status === "sharing" ? location.background === "whenInUse" ? "Dispečer vidí, kde ste, kým je aplikácia spustená."
          : "Dispečer vidí, kde ste, kým je pristavenie otvorené." : "Poloha sa posiela až počas pristavenia, ktoré ste prijali."}</Text>
      </View>
    </Pressable>
    {Boolean(error) && <View style={formLayout.notices}><ErrorNotice message="Pristavenia sa nepodarilo načítať." onRetry={onRefresh} /></View>}
    <SectionHeader title="Na vybavenie" detail={open.length ? String(open.length) : null} />
    {open.length ? <Group>{open.map((delivery, index) => <DeliveryRow key={delivery.id} delivery={delivery} first={index === 0} onOpen={onOpen} />)}</Group>
      : <Text style={s.empty}>{error ? "Zoznam pristavení sa nepodarilo overiť. Skúste obnoviť údaje." : "Teraz nemáte žiadne pristavenie. Keď vám ho dispečer pošle, príde aj notifikácia."}</Text>}
    <Group style={{ marginTop: space.l }}><Row first title="Všetky pristavenia" subtitle="Aj dokončené za posledný deň" tone="link" onPress={onModule} trailing={<Text style={s.chevron}>›</Text>} /></Group>
    {tip && <View style={s.tip}>
      <ModulesMark size={30} />
      <View style={{ flex: 1, gap: 2 }}><Text style={s.tipTitle}>Všetky moduly sú pod žltou ikonou Moduly</Text>
        <Text style={s.tipText}>Vpravo dole v lište. Keď dostanete ďalšiu rolu, pribudne tam jej modul.</Text></View>
      <Pressable accessibilityRole="button" accessibilityLabel="Rozumiem, skryť tip" onPress={onDismissTip} hitSlop={8} style={({ pressed }) => [s.tipButton, pressed && { opacity: 0.7 }]}>
        <Text style={shellStyles.yellowButtonText}>OK</Text></Pressable>
    </View>}
  </ScrollView>;
}

function FieldAccount(props: Props & { name: string; email: string | null; onEditBar: () => void }) {
  const [version] = useState(appVersion);
  const [linkError, setLinkError] = useState<string | null>(null);
  const busy = props.logoutBusy || props.logoutState.busy;
  return <ScrollView contentContainerStyle={formLayout.content}>
    <View style={formLayout.head}><Text accessibilityRole="header" style={styles.heading}>Účet</Text></View>
    <Group style={{ marginTop: space.m }}>
      <InfoRow first label={DELIVERY_ROLE_NAME} value={props.name} detail={props.email} />
      <InfoRow label="Prostredie" value={props.config.environment === "test" ? "Testovací dispečing" : "Produkčný dispečing"} />
      <InfoRow label="Verzia aplikácie" value={versionLabel(version)} />
    </Group>
    <NotificationSettings settings={props.push} kinds={["handoffs"]} />
    <SectionHeader title="Informácie" />
    <Group>{ACCOUNT_LINKS.map((link, index) => <Row key={link.path} first={index === 0} title={link.title} tone="link"
      onPress={() => { setLinkError(null); void Linking.openURL(props.config.apiOrigin + link.path).catch(() => setLinkError("Stránku sa nepodarilo otvoriť.")); }} />)}</Group>
    <SectionHeader title="Spodná lišta" />
    <Group><Row first title="Upraviť lištu" subtitle="Prehľad, vaše moduly a Moduly. Platí pre tento telefón." tone="link" onPress={props.onEditBar} trailing={<Text style={s.chevron}>›</Text>} /></Group>
    {(linkError || props.logoutState.message || props.logoutError) && <View style={formLayout.notices}>
      {linkError && <ErrorNotice message={linkError} />}
      {props.logoutState.message && <ErrorNotice message={props.logoutState.message} />}
      {props.logoutError && <ErrorNotice message={props.logoutError} />}
    </View>}
    <Group style={{ marginTop: space.xl }}>
      <Row first title={busy ? "Odhlasujem…" : "Odhlásiť sa"} tone="danger" disabled={busy} onPress={props.onLogout} />
    </Group>
  </ScrollView>;
}

const s = StyleSheet.create({
  titleRow: { flexDirection: "row", alignItems: "baseline", gap: space.s, paddingHorizontal: space.l, paddingTop: 2, paddingBottom: space.s, flexWrap: "wrap" },
  title: { ...type.title, color: palette.label },
  date: { ...type.subhead, fontWeight: "500", color: palette.secondaryLabel },
  card: { flexDirection: "row", alignItems: "center", gap: space.m, marginHorizontal: space.l, marginTop: space.xs, padding: space.m, borderRadius: radius.l, backgroundColor: palette.card },
  cardIcon: { width: 32, height: 32, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  cardTitle: { ...type.rowTitle, color: palette.label },
  cardText: { ...type.caption, fontWeight: "400", color: palette.secondaryLabel },
  empty: { ...type.subhead, color: palette.secondaryLabel, paddingHorizontal: 20 },
  chevron: { fontSize: 20, color: palette.tertiaryLabel },
  tip: { flexDirection: "row", alignItems: "center", gap: space.m, marginHorizontal: space.l, marginTop: space.l, padding: space.m, borderRadius: radius.l, backgroundColor: palette.card },
  tipTitle: { ...type.rowTitle, fontSize: 14, color: palette.label },
  tipText: { ...type.caption, fontWeight: "400", color: palette.secondaryLabel },
  tipButton: { minHeight: 36, minWidth: 48, borderRadius: 18, backgroundColor: palette.brand, alignItems: "center", justifyContent: "center", paddingHorizontal: space.m },
});
