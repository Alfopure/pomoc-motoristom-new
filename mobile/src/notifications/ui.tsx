import { useState, useSyncExternalStore } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import type { MobilePushType } from "../../../src/lib/mobile-api";
import { formLayout } from "../design/form";
import { Group, Row, SectionHeader, SwitchRow } from "../design/list";
import { palette, type } from "../design/tokens";
import { ErrorNotice } from "../ui";
import type { PushSettings } from "./settings";

const SWITCHES: readonly { type: MobilePushType; title: string; subtitle: string }[] = [
  { type: "tasks", title: "Úlohy", subtitle: "Nová úloha, kontrola a vrátenie na dopracovanie" },
  { type: "task_due", title: "Termíny úloh", subtitle: "Pripomienka a úloha po termíne" },
  { type: "cases", title: "Prípady", subtitle: "Kolega vám pridelil prípad" },
  { type: "callbacks_mine", title: "Moje spätné volania", subtitle: "Prevzaté spätné volanie po termíne" },
  { type: "callbacks_unclaimed", title: "Spätné volania bez dispečera", subtitle: "Požiadavka po termíne, ktorú nikto neprevzal" },
  { type: "handoffs", title: "Pristavenia", subtitle: "Nové pristavenie od dispečera" },
];
/** A dispatcher's kinds; a pristavovač has only deliveries; someone with both roles both. */
const DISPATCH: readonly MobilePushType[] = ["tasks", "task_due", "cases", "callbacks_mine", "callbacks_unclaimed"];
export function pushKinds(dispatch: boolean, delivery: boolean): MobilePushType[] {
  return [...(dispatch ? DISPATCH : []), ...(delivery ? ["handoffs" as const] : [])];
}

/** Účet → Notifikácie: switched on by the operator, then one switch per kind. */
export function NotificationSettings({ settings, kinds = DISPATCH }: { settings: PushSettings; kinds?: readonly MobilePushType[] }) {
  const view = useSyncExternalStore(settings.subscribe, settings.snapshot, settings.snapshot);
  const [settingsError, setSettingsError] = useState(false);
  const openSettings = () => { setSettingsError(false); void Linking.openSettings().catch(() => setSettingsError(true)); };
  const informational = view.status === "unsupported" || view.status === "unavailable" || view.status === "denied";
  return <View>
    <SectionHeader title="Notifikácie" />
    {view.status === "on" && view.preferences ? <Group>
      {SWITCHES.filter(item => kinds.includes(item.type)).map((item, index) => <SwitchRow key={item.type} first={index === 0} title={item.title} subtitle={item.subtitle}
        value={view.preferences![item.type]} disabled={view.busy} onChange={on => { void settings.set(item.type, on); }} />)}
      <Row title="Vypnúť na tomto telefóne" tone="link" disabled={view.busy} onPress={() => { void settings.disable(); }} />
    </Group> : view.status !== "unsupported" && <Group>
      {view.status === "working" ? <Row first title="Nastavujem notifikácie…" disabled />
        : view.status === "denied" ? <>
          <Row first title="Otvoriť nastavenia telefónu" tone="link" onPress={openSettings} />
          <Row title="Skúsiť znova" subtitle="Po povolení v nastaveniach" tone="link" disabled={view.busy} onPress={() => { void settings.enable(); }} />
        </> : <Row first title={view.status === "off" ? "Zapnúť notifikácie" : "Skúsiť znova"} subtitle={view.status === "off" ? (!kinds.includes("tasks") ? "Nové pristavenia aj pri zamknutom telefóne"
          : kinds.includes("handoffs") ? "Úlohy, prípady, spätné volania a pristavenia aj pri zamknutom telefóne" : "Úlohy, prípady a spätné volania aj pri zamknutom telefóne") : null}
          tone="link" disabled={view.busy} onPress={() => { void settings.enable(); }} />}
    </Group>}
    {informational && view.message ? <Text style={s.note}>{view.message}</Text>
      : <Text style={s.note}>Nastavenie platí pre tento telefón. Notifikácie neobsahujú mená ani telefónne čísla, nanajvýš číslo prípadu.</Text>}
    {(view.message && !informational || settingsError) && <View style={formLayout.notices}>
      {view.message && !informational && <ErrorNotice message={view.message} />}
      {settingsError && <ErrorNotice message="Nastavenia telefónu sa nepodarilo otvoriť." />}
    </View>}
  </View>;
}

const s = StyleSheet.create({
  note: { ...type.caption, fontWeight: "400", color: palette.secondaryLabel, paddingHorizontal: 20, paddingTop: 6 },
});
