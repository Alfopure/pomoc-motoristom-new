import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { randomUUID } from "expo-crypto";
import { AlertTriangle, Car, ChevronLeft, Navigation, Phone } from "lucide-react-native";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MobileDelivery, MobileDeliveryAction } from "../../../src/lib/mobile-api";
import { MobileApiError } from "../lib/api";
import type { MobileConfig } from "../lib/config";
import type { LogoutState } from "../lib/logout";
import { appVersion, versionLabel } from "../lib/app-version";
import { formatNumber, dialable } from "../lib/display";
import { directionsUrl } from "../cases/maps";
import { ActionBar, DetailHeader, InfoRow, Tag } from "../design/detail";
import { Field, FormSection, formLayout } from "../design/form";
import { Group, Row, SectionHeader } from "../design/list";
import { palette, space, type } from "../design/tokens";
import { GlassButton } from "../shell/parts";
import { initialsOf } from "../shell/top-bar";
import { Button, ErrorNotice, Loading, styles } from "../ui";
import { useAndroidBack } from "../lib/use-android-back";
import { NotificationSettings } from "../notifications/ui";
import type { PushSettings } from "../notifications/settings";
import { pushTaps } from "../notifications/taps";
import { createDeliveryApi, type DeliveryApi } from "./api";
import { phoneLocation } from "./location";
import { DeliveryMap } from "./map";
import { agoLabel, deliveryPlace, deliveryPoints, deliveryStatusLabels, deliveryStatusTones, deliveryTitle, isOpen, nextStep, replacementCar, sharesPosition, sortDeliveries, timeLabel } from "./model";
import { DeliveryTracker } from "./tracker";

type Screen = { kind: "list" } | { kind: "detail"; id: string } | { kind: "account" };
type Props = {
  config: MobileConfig; client: SupabaseClient; userId: string; liveUser: () => string | null; active: boolean; push: PushSettings;
  logoutState: LogoutState; logoutError: string | null; logoutBusy: boolean; onLogout: () => void;
};
const ACCOUNT_LINKS = [
  { title: "Ochrana súkromia", path: "/aplikacia/sukromie" },
  { title: "Podpora", path: "/aplikacia/podpora" },
] as const;

/** The pristavovač's app: deliveries a dispatcher sent them, one at a time in detail,
 * with what to do on top and the map below. No dispatch module is shown. */
export function FieldWorkspace(props: Props) {
  const { config, client, userId, liveUser, active, push } = props;
  const queryClient = useQueryClient();
  const api = useMemo(() => createDeliveryApi(config, async () => {
    if (liveUser() !== userId) throw new MobileApiError("Prihlásenie sa zmenilo. Otvorte svoj účet znova.", 401);
    const { data } = await client.auth.getSession();
    return liveUser() === userId && data.session?.user.id === userId ? data.session.access_token : null;
  }), [config, client, userId, liveUser]);
  const key = useMemo(() => ["mobile", config.environment, userId, "field"], [config.environment, userId]);
  const me = useQuery({ queryKey: [...key, "me"], queryFn: ({ signal }) => api.me(signal) });
  const memberId = me.data?.memberId ?? null;
  const list = useQuery({ queryKey: [...key, "deliveries"], enabled: Boolean(memberId), queryFn: ({ signal }) => api.list(signal), refetchInterval: active ? 30_000 : false });
  const [view, setView] = useState<Screen>({ kind: "list" });
  const tracker = useMemo(() => new DeliveryTracker(phoneLocation, (id, position) => api.position(id, position)), [api]);
  useEffect(() => () => tracker.dispose(), [tracker]);
  // Position goes to the dispatcher for the accepted delivery while the app is open.
  const sharing = (list.data ?? []).find(delivery => sharesPosition(delivery)) ?? null;
  useEffect(() => { void tracker.follow(active && sharing ? sharing.id : null); }, [tracker, active, sharing]);
  useEffect(() => { if (active && memberId) void push.resume(); }, [active, memberId, push]);
  // A tapped notice opens its delivery, only in the account it was sent to.
  // Taken from the inbox as it arrives, also the tap that started the app.
  useEffect(() => {
    if (!memberId) return;
    const consume = () => {
      if (!pushTaps.snapshot()) return;
      const target = pushTaps.take(memberId);
      if (target?.kind === "delivery") setView({ kind: "detail", id: target.id });
    };
    const unsubscribe = pushTaps.subscribe(consume);
    const pending = setTimeout(consume, 0);
    return () => { unsubscribe(); clearTimeout(pending); };
  }, [memberId]);
  useAndroidBack(active && view.kind !== "list", () => setView({ kind: "list" }));

  const top = <View style={s.bar}>
    {view.kind === "list" ? <Text accessibilityRole="header" style={s.barTitle}>Pristavenia</Text>
      : <GlassButton label="Pristavenia" accessibilityLabel="Späť na Pristavenia" onPress={() => setView({ kind: "list" })}
        icon={<ChevronLeft size={20} strokeWidth={2.5} color={palette.label} accessible={false} style={{ marginLeft: -4 }} />} />}
    <View style={{ flex: 1 }} />
    {config.environment === "test" && <Text accessibilityLabel="Testovacie prostredie" style={s.test}>TEST</Text>}
    <GlassButton round tone="brand" accessibilityLabel="Účet a nastavenia" onPress={() => setView({ kind: "account" })}
      icon={<Text maxFontSizeMultiplier={1.2} style={s.initials}>{initialsOf(me.data?.member.displayName ?? "?")}</Text>} />
  </View>;

  if (me.isPending) return <>{top}<Loading label="Overujem prístup k pristaveniam…" /></>;
  if (!me.data) return <>{top}<View style={styles.content}>
    <ErrorNotice message={me.error instanceof MobileApiError ? me.error.message : "Účet sa nepodarilo načítať."} onRetry={() => { void me.refetch(); }} />
    <Button label="Odhlásiť sa" secondary disabled={props.logoutBusy || props.logoutState.busy} onPress={props.onLogout} />
  </View></>;
  return <View style={{ flex: 1 }}>
    {top}
    {view.kind === "account" ? <FieldAccount {...props} name={me.data.member.displayName} email={me.data.member.email} />
      : view.kind === "detail" ? <DeliveryDetail key={view.id} api={api} id={view.id} active={active} queryKey={key} tracker={tracker}
        onChanged={() => { void queryClient.invalidateQueries({ queryKey: [...key, "deliveries"] }); }} />
      : <DeliveryList query={list} onOpen={id => setView({ kind: "detail", id })} />}
  </View>;
}

function DeliveryList({ query, onOpen }: { query: ReturnType<typeof useQuery<MobileDelivery[]>>; onOpen: (id: string) => void }) {
  const deliveries = sortDeliveries(query.data ?? []);
  const open = deliveries.filter(delivery => isOpen(delivery)), done = deliveries.filter(delivery => !isOpen(delivery));
  return <ScrollView contentContainerStyle={formLayout.content}>
    {query.isError && <View style={formLayout.notices}><ErrorNotice message={query.error instanceof MobileApiError ? query.error.message : "Pristavenia sa nepodarilo načítať."} onRetry={() => { void query.refetch(); }} /></View>}
    {query.isPending ? <Loading label="Načítavam pristavenia…" /> : <>
      <SectionHeader title="Na vybavenie" detail={open.length ? String(open.length) : null} />
      {open.length ? <Group>{open.map((delivery, index) => <DeliveryRow key={delivery.id} delivery={delivery} first={index === 0} onOpen={onOpen} />)}</Group>
        : <Text style={s.empty}>Teraz nemáte žiadne pristavenie. Keď vám ho dispečer pošle, príde aj notifikácia.</Text>}
      {done.length > 0 && <>
        <SectionHeader title="Dokončené za posledný deň" detail={String(done.length)} />
        <Group>{done.map((delivery, index) => <DeliveryRow key={delivery.id} delivery={delivery} first={index === 0} onOpen={onOpen} />)}</Group>
      </>}
    </>}
    <View style={formLayout.actions}><Button label={query.isFetching ? "Obnovujem…" : "Obnoviť"} secondary disabled={query.isFetching} onPress={() => { void query.refetch(); }} /></View>
  </ScrollView>;
}

/** As in the assistance app: state, the car with its plate, and what it is for. */
function DeliveryRow({ delivery, first, onOpen }: { delivery: MobileDelivery; first: boolean; onOpen: (id: string) => void }) {
  const place = deliveryPlace(delivery);
  return <Pressable accessibilityRole="button" accessibilityLabel={"Otvoriť pristavenie " + deliveryTitle(delivery) + ", " + deliveryStatusLabels[delivery.status]}
    onPress={() => onOpen(delivery.id)} style={({ pressed }) => [s.row, pressed && { backgroundColor: "#ECECF0" }]}>
    {!first && <View style={s.separator} />}
    <View style={s.icon}><Car size={20} strokeWidth={2.2} color={palette.blueText} accessible={false} /></View>
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <View style={s.rowHead}><Text numberOfLines={2} style={s.rowTitle}>{deliveryTitle(delivery)}</Text><Tag text={deliveryStatusLabels[delivery.status]} tone={deliveryStatusTones[delivery.status]} /></View>
      <Text numberOfLines={1} style={s.rowDetail}>{"Prípad " + delivery.caseNumber + (delivery.card?.scheduledAt ? " · " + timeLabel(delivery.card.scheduledAt) : "")}</Text>
      {place ? <Text numberOfLines={2} style={s.rowDetail}>{"Pristavenie: " + place}</Text> : null}
    </View>
    <Text style={s.chevron}>›</Text>
  </Pressable>;
}

function DeliveryDetail({ api, id, active, queryKey, tracker, onChanged }: { api: DeliveryApi; id: string; active: boolean; queryKey: string[]; tracker: DeliveryTracker; onChanged: () => void }) {
  const queryClient = useQueryClient();
  const detailKey = useMemo(() => [...queryKey, "delivery", id], [queryKey, id]);
  const query = useQuery({ queryKey: detailKey, queryFn: ({ signal }) => api.read(id, signal), refetchInterval: active ? 15_000 : false });
  const location = useSyncExternalStore(tracker.subscribe, tracker.snapshot, tracker.snapshot);
  const { height } = useWindowDimensions();
  const [busy, setBusy] = useState<MobileDeliveryAction | null>(null), [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<{ action: "reject" | "blocked"; text: string } | null>(null);
  const delivery = query.data;
  async function run(action: MobileDeliveryAction, extra: { comment?: string; eta?: string | null } = {}) {
    if (!delivery || busy) return;
    setBusy(action); setError(null);
    try {
      const next = await api.command(delivery.id, { commandId: randomUUID(), action, expectedRevision: delivery.revision, publishedVersion: delivery.publishedVersion, ...extra });
      queryClient.setQueryData(detailKey, next);
      setReason(null);
      onChanged();
      // Location is asked right after accepting, when its purpose is clear.
      if (action === "accept") void tracker.follow(next.id, true);
    } catch (failure) {
      setError(failure instanceof MobileApiError ? failure.message : "Krok sa nepodarilo potvrdiť. Skúste znova.");
      if (failure instanceof MobileApiError && failure.status === 409) void query.refetch();
    } finally { setBusy(null); }
  }
  if (query.isPending) return <Loading label="Načítavam pristavenie…" />;
  if (!delivery) return <View style={styles.content}><ErrorNotice message={query.error instanceof MobileApiError ? query.error.message : "Pristavenie sa nepodarilo načítať."} onRetry={() => { void query.refetch(); }} /></View>;
  const card = delivery.card, step = nextStep(delivery), open = isOpen(delivery);
  const car = replacementCar(delivery), place = deliveryPlace(delivery), phone = card?.contact.phone ?? null;
  const navigate = (target: string | null) => { if (target) void Linking.openURL(directionsUrl(target)).catch(() => setError("Navigáciu sa nepodarilo otvoriť.")); };
  const carTarget = delivery.replacementPosition ? delivery.replacementPosition.lat + "," + delivery.replacementPosition.lng : null;
  const confirmStep = () => {
    if (!step) return;
    if (!step.confirm) { void run(step.action); return; }
    Alert.alert(step.label, step.confirm, [{ text: "Späť", style: "cancel" }, { text: step.label, onPress: () => { void run(step.action); } }]);
  };
  const mapHeight = Math.max(200, Math.round(height * 0.34));
  return <View style={{ flex: 1 }}>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: space.l }} keyboardShouldPersistTaps="handled">
      <DetailHeader title={deliveryTitle(delivery)} subtitle={"Prípad " + delivery.caseNumber + (card ? " · " + card.action : "")}
        tags={<Tag text={deliveryStatusLabels[delivery.status]} tone={deliveryStatusTones[delivery.status]} />}
        meta={(delivery.createdBy ? "Poslal " + delivery.createdBy + " · " : "") + timeLabel(delivery.createdAt)} />
      {(error || !card) && <View style={formLayout.notices}>
        {error && <ErrorNotice message={error} />}
        {!card && <Text style={styles.muted}>Pristavenie je uzavreté; údaje zákazníka sa už nezobrazujú.</Text>}
      </View>}
      {open && card && <ActionBar actions={[
        { icon: Phone, label: "Zavolať", accessibilityLabel: "Zavolať klientovi", disabled: !dialable(phone), onPress: () => { if (phone) void Linking.openURL("tel:" + phone.replace(/[^\d+]/g, "")).catch(() => setError("Hovor sa nepodarilo začať.")); } },
        { icon: Car, label: "K autu", accessibilityLabel: "Navigovať k náhradnému autu", disabled: !carTarget, onPress: () => navigate(carTarget) },
        { icon: Navigation, label: "Pristavenie", accessibilityLabel: "Navigovať na miesto pristavenia", disabled: !place, onPress: () => navigate(place) },
        { icon: AlertTriangle, label: delivery.status === "offered" ? "Odmietnuť" : "Problém", accessibilityLabel: delivery.status === "offered" ? "Odmietnuť pristavenie" : "Nahlásiť problém",
          onPress: () => setReason({ action: delivery.status === "offered" ? "reject" : "blocked", text: "" }) },
      ]} />}
      {reason && <>
        <FormSection title={reason.action === "reject" ? "Odmietnuť pristavenie" : "Nahlásiť problém"} footer="Dispečer dostane upozornenie s vaším dôvodom.">
          <Field label="Dôvod" value={reason.text} onChangeText={text => setReason({ ...reason, text })} multiline maxLength={1000} autoFocus />
        </FormSection>
        <View style={formLayout.actions}>
          <Button primary label={busy === reason.action ? "Odosielam…" : reason.action === "reject" ? "Odmietnuť" : "Odoslať problém"} disabled={!reason.text.trim() || Boolean(busy)}
            onPress={() => { void run(reason.action, { comment: reason.text.trim() }); }} />
          <Button label="Zrušiť" secondary disabled={Boolean(busy)} onPress={() => setReason(null)} />
        </View>
      </>}
      {step && !reason && <View style={formLayout.actions}>
        <Button primary label={busy === step.action ? "Ukladám…" : step.label} disabled={Boolean(busy)} onPress={confirmStep} />
      </View>}
      {open && (delivery.status === "accepted" || delivery.status === "en_route") && !reason && <>
        <SectionHeader title="Čas príchodu" detail={delivery.eta ? "do " + timeLabel(delivery.eta) : null} />
        <View style={s.chips}>{[15, 30, 60].map(minutes => <Pressable key={minutes} accessibilityRole="button" accessibilityLabel={"Príchod o " + minutes + " minút"} disabled={Boolean(busy)}
          onPress={() => { void run("update", { eta: new Date(Date.now() + minutes * 60_000).toISOString() }); }} style={({ pressed }) => [s.chip, pressed && { opacity: 0.6 }]}>
          <Text style={s.chipText}>{"o " + minutes + " min"}</Text></Pressable>)}</View>
      </>}
      {card && <>
        <SectionHeader title="Čo treba urobiť" />
        <Group>
          <InfoRow first label="Náhradné auto" value={car} empty="Auto zatiaľ nie je priradené"
            detail={delivery.replacementPosition ? "Poloha podľa GPS " + agoLabel(delivery.replacementPosition.recordedAt) : null} />
          <InfoRow label="Pristavenie" value={place} empty="Miesto zatiaľ nie je uvedené" />
          <InfoRow label="Dohodnutý čas" value={card.scheduledAt ? timeLabel(card.scheduledAt) : null} empty="Neuvedený" />
          <InfoRow label="Pokyny" value={card.instructions || null} empty="Bez pokynov" />
        </Group>
        <SectionHeader title="Klient" />
        <Group>
          <InfoRow first label="Meno" value={card.contact.name || null} />
          <InfoRow label="Telefón" value={phone ? formatNumber(phone) : null} />
          <InfoRow label="Vozidlo klienta" value={[card.vehicle.make, card.vehicle.model, card.vehicle.plate].filter(Boolean).join(" ") || null} />
          <InfoRow label="Miesto klienta" value={card.pickup?.address || null} />
          {card.assistance?.name ? <InfoRow label="Asistenčná služba" value={card.assistance.name} detail={card.assistance.reference || null} /> : null}
        </Group>
      </>}
      {open && delivery.status !== "offered" && <Text style={s.note}>{location.status === "sharing" ? "Vaša poloha sa posiela dispečingu, kým je pristavenie otvorené a aplikácia zapnutá."
        : location.status === "denied" ? "Poloha nie je povolená. Dispečer neuvidí, kde ste. Povoliť ju môžete v nastaveniach telefónu."
          : "Poloha sa zatiaľ neposiela."}</Text>}
      {location.status === "denied" && open && <View style={formLayout.actions}><Button label="Otvoriť nastavenia telefónu" secondary onPress={() => { void Linking.openSettings().catch(() => undefined); }} /></View>}
      {delivery.events.length > 0 && <>
        <SectionHeader title="História" />
        <Group>{delivery.events.map((event, index) => <InfoRow key={event.id} first={index === 0} label={timeLabel(event.createdAt) + " · " + event.actor}
          value={eventLabels[event.action] ?? event.action} detail={event.comment || null} />)}</Group>
      </>}
    </ScrollView>
    {card && <DeliveryMap points={deliveryPoints(delivery)} showsUser={location.status === "sharing"} height={mapHeight} />}
  </View>;
}
const eventLabels: Record<string, string> = {
  issue: "Odovzdanie vytvorené", publish: "Údaje aktualizované", renew: "Odkaz obnovený", extend: "Platnosť predĺžená", recover: "Odkaz získaný",
  accept: "Prijaté", reject: "Odmietnuté", en_route: "Na ceste", arrived: "Na mieste", complete: "Dokončené", update: "Aktualizácia", blocked: "Problém", revoke: "Zrušené",
};

function FieldAccount(props: Props & { name: string; email: string | null }) {
  const [version] = useState(appVersion);
  const [linkError, setLinkError] = useState<string | null>(null);
  const busy = props.logoutBusy || props.logoutState.busy;
  return <ScrollView contentContainerStyle={formLayout.content}>
    <View style={formLayout.head}><Text accessibilityRole="header" style={styles.heading}>Účet</Text></View>
    <Group style={{ marginTop: space.m }}>
      <InfoRow first label="Pristavovač" value={props.name} detail={props.email} />
      <InfoRow label="Prostredie" value={props.config.environment === "test" ? "Testovací dispečing" : "Produkčný dispečing"} />
      <InfoRow label="Verzia aplikácie" value={versionLabel(version)} />
    </Group>
    <NotificationSettings settings={props.push} kinds={["handoffs"]} />
    <SectionHeader title="Informácie" />
    <Group>{ACCOUNT_LINKS.map((link, index) => <Row key={link.path} first={index === 0} title={link.title} tone="link"
      onPress={() => { setLinkError(null); void Linking.openURL(props.config.apiOrigin + link.path).catch(() => setLinkError("Stránku sa nepodarilo otvoriť.")); }} />)}</Group>
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
  bar: { flexDirection: "row", alignItems: "center", gap: space.s, paddingHorizontal: 14, paddingTop: space.xs, paddingBottom: space.xs, minHeight: 48 },
  barTitle: { ...type.headline, color: palette.label, paddingLeft: space.xs },
  test: { fontSize: 10, lineHeight: 13, fontWeight: "800", letterSpacing: 0.8, color: palette.label, backgroundColor: "#FFF4AF", borderRadius: 8, paddingHorizontal: 7, paddingVertical: 4, overflow: "hidden" },
  initials: { fontSize: 12, lineHeight: 15, fontWeight: "700", color: palette.label },
  empty: { ...type.subhead, color: palette.secondaryLabel, paddingHorizontal: 20 },
  row: { flexDirection: "row", alignItems: "center", gap: space.m, paddingHorizontal: space.m, paddingVertical: 10, minHeight: 64, backgroundColor: palette.card },
  separator: { position: "absolute", top: 0, left: 60, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: palette.separator },
  icon: { width: 36, height: 36, borderRadius: 18, backgroundColor: palette.blueSoft, alignItems: "center", justifyContent: "center" },
  rowHead: { flexDirection: "row", alignItems: "center", gap: space.s },
  rowTitle: { ...type.rowTitle, color: palette.label, flexShrink: 1 },
  rowDetail: { ...type.subhead, color: palette.secondaryLabel },
  chevron: { fontSize: 20, color: palette.tertiaryLabel },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.s, paddingHorizontal: space.l },
  chip: { minHeight: 36, borderRadius: 18, paddingHorizontal: 14, alignItems: "center", justifyContent: "center", backgroundColor: palette.card },
  chipText: { ...type.rowTitle, color: palette.label },
  note: { ...type.caption, fontWeight: "400", color: palette.secondaryLabel, paddingHorizontal: 20, paddingTop: space.m },
});
