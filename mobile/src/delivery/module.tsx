import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { randomUUID } from "expo-crypto";
import { AlertTriangle, Car, Navigation, Phone } from "lucide-react-native";
import type { MobileDelivery, MobileDeliveryAction } from "../../../src/lib/mobile-api";
import { MobileApiError } from "../lib/api";
import { formatNumber, dialable } from "../lib/display";
import { useAndroidBack } from "../lib/use-android-back";
import { directionsUrl } from "../cases/maps";
import { ActionBar, DetailHeader, InfoRow, Tag } from "../design/detail";
import { Field, FormSection, formLayout } from "../design/form";
import { Group, SectionHeader } from "../design/list";
import { palette, space, type } from "../design/tokens";
import { useShellBack } from "../shell/back";
import { NAVIGATION_CONTENT_BOTTOM } from "../ui/theme";
import { Button, ErrorNotice, Loading, styles } from "../ui";
import type { DeliveryApi } from "./api";
import { DeliveryMap } from "./map";
import { agoLabel, canUseDeliveryCache, deliveryPlace, deliveryPoints, deliveryStatusLabels, deliveryStatusTones, deliveryTitle, isOpen, nextStep, replacementCar, sortDeliveries, timeLabel, visibleDelivery } from "./model";
import { useDeliveryTime } from "./use-delivery-time";
import type { DeliverySession } from "./session";
import type { LocationSharing, SharingState } from "./sharing";

/** Pristavenia inside the app: the list, and one delivery with what to do on top
 * and the map below. In a delivery the shell's top bar leads back to the list. */
export function DeliveryModule({ session, active, visible, openRequest }: {
  session: DeliverySession; active: boolean; visible: boolean; openRequest: { id: string; nonce: number } | null;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  // A tapped notice opens its delivery once.
  const [handled, setHandled] = useState<number | null>(null);
  if (openRequest && openRequest.nonce !== handled) { setHandled(openRequest.nonce); setSelected(openRequest.id); }
  const back = () => setSelected(null);
  useShellBack(visible && selected !== null, "Pristavenia", back);
  useAndroidBack(active && visible && selected !== null, back);
  if (!session.memberId) return <View style={styles.content}>{session.me.isPending ? <Loading label="Overujem prístup k pristaveniam…" />
    : <ErrorNotice message={session.me.error instanceof MobileApiError ? session.me.error.message : "Pristavenia sa nepodarilo načítať."} onRetry={() => { void session.me.refetch(); }} />}</View>;
  return selected ? <DeliveryDetail key={selected} api={session.api} id={selected} active={active && visible} queryKey={session.key} tracker={session.location}
    onChanged={() => { void queryClient.invalidateQueries({ queryKey: [...session.key, "deliveries"] }); }} />
    : <DeliveryList query={session.list} active={active && visible} onOpen={setSelected} />;
}

/** What the pristavovač reads about their position, for the app they have. */
function locationNote(tracking: boolean, location: SharingState, mode: LocationSharing["mode"]): string {
  if (!tracking) return "Poloha sa zatiaľ neposiela. Začne sa posielať, keď potvrdíte ďalší krok v aplikácii.";
  if (location.status === "denied") return "Poloha nie je povolená. Dispečer neuvidí, kde ste. Povoliť ju môžete v nastaveniach telefónu.";
  if (location.status === "error") return "Polohu sa nepodarilo zapnúť. Skúste to znova.";
  if (location.status !== "sharing") return "Poloha sa zatiaľ neposiela.";
  if (mode === "foreground") return "Vaša poloha sa posiela dispečingu, kým je pristavenie otvorené a aplikácia zapnutá. V Expo Go sa na pozadí neposiela.";
  return location.background === "always" ? "Vaša poloha sa posiela dispečingu aj na pozadí a pri zamknutom telefóne, kým je pristavenie otvorené."
    : "Poloha sa posiela, aj keď je aplikácia na pozadí, ale po jej zatvorení sa zastaví. V nastaveniach telefónu povoľte polohu „Vždy“.";
}

function DeliveryList({ query, active, onOpen }: { query: UseQueryResult<MobileDelivery[]>; active: boolean; onOpen: (id: string) => void }) {
  const now = useDeliveryTime(active);
  const usable = canUseDeliveryCache(query.error);
  const deliveries = sortDeliveries(usable ? (query.data ?? []).map(delivery => visibleDelivery(delivery, now)) : [], now);
  const open = deliveries.filter(delivery => isOpen(delivery)), done = deliveries.filter(delivery => !isOpen(delivery));
  return <ScrollView contentContainerStyle={formLayout.content}>
    {query.isError && <View style={formLayout.notices}><ErrorNotice message={query.error instanceof MobileApiError ? query.error.message : "Pristavenia sa nepodarilo načítať."} onRetry={() => { void query.refetch(); }} /></View>}
    {query.isPending ? <Loading label="Načítavam pristavenia…" /> : usable && <>
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
export function DeliveryRow({ delivery, first, onOpen }: { delivery: MobileDelivery; first: boolean; onOpen: (id: string) => void }) {
  const place = deliveryPlace(delivery);
  return <Pressable accessibilityRole="button" accessibilityLabel={"Otvoriť pristavenie " + deliveryTitle(delivery) + ", " + deliveryStatusLabels[delivery.status]}
    onPress={() => onOpen(delivery.id)} style={({ pressed }) => [s.row, pressed && { backgroundColor: "#ECECF0" }]}>
    {!first && <View style={s.separator} />}
    <View style={s.icon}><Car size={20} strokeWidth={2.2} color={palette.blueText} accessible={false} /></View>
    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
      <Text numberOfLines={2} style={s.rowTitle}>{deliveryTitle(delivery)}</Text>
      <View style={s.rowHead}><Tag text={deliveryStatusLabels[delivery.status]} tone={deliveryStatusTones[delivery.status]} />
        <Text numberOfLines={1} style={[s.rowDetail, { flexShrink: 1 }]}>{"Prípad " + delivery.caseNumber + (delivery.card?.scheduledAt ? " · " + timeLabel(delivery.card.scheduledAt) : "")}</Text></View>
      {place ? <Text numberOfLines={2} style={s.rowDetail}>{"Pristavenie: " + place}</Text> : null}
    </View>
    <Text style={s.chevron}>›</Text>
  </Pressable>;
}

function DeliveryDetail({ api, id, active, queryKey, tracker, onChanged }: { api: DeliveryApi; id: string; active: boolean; queryKey: readonly string[]; tracker: LocationSharing; onChanged: () => void }) {
  const queryClient = useQueryClient();
  const detailKey = useMemo(() => [...queryKey, "delivery", id], [queryKey, id]);
  const query = useQuery({ queryKey: detailKey, queryFn: ({ signal }) => api.read(id, signal), refetchInterval: active ? 15_000 : false });
  const location = useSyncExternalStore(tracker.subscribe, tracker.snapshot, tracker.snapshot);
  const { height } = useWindowDimensions();
  const [busy, setBusy] = useState<MobileDeliveryAction | null>(null), [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<{ action: "reject" | "blocked"; text: string } | null>(null);
  const now = useDeliveryTime(active);
  const running = useRef(false);
  const delivery = query.data && canUseDeliveryCache(query.error) ? visibleDelivery(query.data, now) : undefined;
  async function run(action: MobileDeliveryAction, extra: { comment?: string; eta?: string | null } = {}) {
    if (!delivery || running.current || !isOpen(delivery)) return;
    running.current = true;
    setBusy(action); setError(null);
    try {
      const next = await api.command(delivery.id, { commandId: randomUUID(), action, expectedRevision: delivery.revision, publishedVersion: delivery.publishedVersion, ...extra });
      queryClient.setQueryData(detailKey, next);
      setReason(null);
      onChanged();
      // Location is asked right after their own step, when its purpose is clear.
      if (next.tracking && (action === "accept" || action === "en_route" || action === "arrived")) void tracker.follow(next.id, true);
    } catch (failure) {
      setError(failure instanceof MobileApiError ? failure.message : "Krok sa nepodarilo potvrdiť. Skúste znova.");
      if (failure instanceof MobileApiError && failure.status === 409) void query.refetch();
    } finally { running.current = false; setBusy(null); }
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
  const mapHeight = Math.max(180, Math.round(height * 0.3));
  return <View style={{ flex: 1 }}>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: space.l }} keyboardShouldPersistTaps="handled">
      <DetailHeader title={deliveryTitle(delivery)} subtitle={"Prípad " + delivery.caseNumber + (card ? " · " + card.action : "")}
        tags={<Tag text={deliveryStatusLabels[delivery.status]} tone={deliveryStatusTones[delivery.status]} />}
        meta={(delivery.createdBy ? "Poslal " + delivery.createdBy + " · " : "") + timeLabel(delivery.createdAt)} />
      {(error || query.isError || !card) && <View style={formLayout.notices}>
        {error && <ErrorNotice message={error} />}
        {query.isError && <ErrorNotice message="Údaje sa nepodarilo obnoviť. Zobrazený je posledný načítaný stav." onRetry={() => { void query.refetch(); }} />}
        {!card && <Text style={styles.muted}>Pristavenie je uzavreté; údaje zákazníka sa už nezobrazujú.</Text>}
      </View>}
      {open && card && <ActionBar actions={[
        { icon: Phone, label: "Zavolať", accessibilityLabel: "Zavolať klientovi", disabled: !dialable(phone), onPress: () => { if (phone) void Linking.openURL("tel:" + phone.replace(/[^\d+]/g, "")).catch(() => setError("Hovor sa nepodarilo začať.")); } },
        { icon: Car, label: "K autu", accessibilityLabel: "Navigovať k náhradnému autu", disabled: !carTarget, onPress: () => navigate(carTarget) },
        { icon: Navigation, label: "Na miesto", accessibilityLabel: "Navigovať na miesto pristavenia", disabled: !place, onPress: () => navigate(place) },
        { icon: AlertTriangle, label: delivery.status === "offered" ? "Odmietnuť" : "Problém", accessibilityLabel: delivery.status === "offered" ? "Odmietnuť pristavenie" : "Nahlásiť problém",
          onPress: () => setReason({ action: delivery.status === "offered" ? "reject" : "blocked", text: "" }) },
      ]} />}
      {reason && open && <>
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
      {open && delivery.status !== "offered" && <Text style={s.note}>{locationNote(delivery.tracking, location, tracker.mode)}</Text>}
      {open && delivery.tracking && (location.status === "off" || location.status === "error") && <View style={formLayout.actions}>
        <Button label="Zdieľať polohu s dispečerom" secondary onPress={() => { void tracker.follow(delivery.id, true); }} /></View>}
      {open && delivery.tracking && (location.status === "denied" || location.status === "sharing" && location.background === "whenInUse") && <View style={formLayout.actions}>
        <Button label="Otvoriť nastavenia telefónu" secondary onPress={() => { void Linking.openSettings().catch(() => undefined); }} /></View>}
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
      {delivery.events.length > 0 && <>
        <SectionHeader title="História" />
        <Group>{delivery.events.map((event, index) => <InfoRow key={event.id} first={index === 0} label={timeLabel(event.createdAt) + " · " + event.actor}
          value={eventLabels[event.action] ?? event.action} detail={event.comment || null} />)}</Group>
      </>}
    </ScrollView>
    {/* The map reaches under the floating bar; its legend stays above it. */}
    {card && <DeliveryMap points={deliveryPoints(delivery)} showsUser={location.status === "sharing"} height={mapHeight + NAVIGATION_CONTENT_BOTTOM} inset={NAVIGATION_CONTENT_BOTTOM} />}
  </View>;
}

const eventLabels: Record<string, string> = {
  issue: "Odovzdanie vytvorené", publish: "Údaje aktualizované", renew: "Odkaz obnovený", extend: "Platnosť predĺžená", recover: "Odkaz získaný",
  accept: "Prijaté", reject: "Odmietnuté", en_route: "Na ceste", arrived: "Na mieste", complete: "Dokončené", update: "Aktualizácia", blocked: "Problém", revoke: "Zrušené",
};

const s = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: space.s, paddingHorizontal: 14, paddingTop: space.xs, paddingBottom: space.xs, minHeight: 48 },
  barTitle: { ...type.headline, color: palette.label, paddingLeft: space.xs },
  test: { fontSize: 10, lineHeight: 13, fontWeight: "800", letterSpacing: 0.8, color: palette.label, backgroundColor: "#FFF4AF", borderRadius: 8, paddingHorizontal: 7, paddingVertical: 4, overflow: "hidden" },
  initials: { fontSize: 12, lineHeight: 15, fontWeight: "700", color: palette.label },
  empty: { ...type.subhead, color: palette.secondaryLabel, paddingHorizontal: 20 },
  row: { flexDirection: "row", alignItems: "center", gap: space.m, paddingHorizontal: space.m, paddingVertical: 10, minHeight: 64, backgroundColor: palette.card },
  separator: { position: "absolute", top: 0, left: 60, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: palette.separator },
  icon: { width: 36, height: 36, borderRadius: 18, backgroundColor: palette.blueSoft, alignItems: "center", justifyContent: "center" },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  rowTitle: { ...type.rowTitle, color: palette.label, flexShrink: 1 },
  rowDetail: { ...type.subhead, color: palette.secondaryLabel },
  chevron: { fontSize: 20, color: palette.tertiaryLabel },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.s, paddingHorizontal: space.l },
  chip: { minHeight: 36, borderRadius: 18, paddingHorizontal: 14, alignItems: "center", justifyContent: "center", backgroundColor: palette.card },
  chipText: { ...type.rowTitle, color: palette.label },
  note: { ...type.caption, fontWeight: "400", color: palette.secondaryLabel, paddingHorizontal: 20, paddingTop: space.m },
});
