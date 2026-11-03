import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Pencil, RefreshCw, Search, Star, UserRound } from "lucide-react-native";
import { palette, radius, space, type } from "../design/tokens";
import { NAVIGATION_CONTENT_BOTTOM } from "../ui/theme";
import { GROUPS, moduleById, type ModuleId } from "./modules";
import type { ShellTab } from "./navigation";
import { Group, Row, SectionHeader } from "../design/list";
import { Badge, MiniBar, ModuleTile, shellStyles } from "./parts";
import { ErrorNotice } from "../ui";

export type ModuleAccessRefresh = {
  busy: boolean; error: string | null; message: string | null; refresh: () => Promise<void>;
};

type Props = {
  available: ModuleId[]; pins: ModuleId[]; tabs: ShellTab[]; showAdd: boolean; badges: Partial<Record<ModuleId, number>>;
  onOpen: (id: ModuleId) => void; onMenu: (id: ModuleId) => void; onEdit: () => void; onAccount: () => void;
  accessRefresh: ModuleAccessRefresh;
};
const fold = (value: string) => value.toLocaleLowerCase("sk").normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Every permitted module, like the iPhone Home Screen, plus the bar editor. */
export function ModulesScreen({ available, pins, tabs, showAdd, badges, onOpen, onMenu, onEdit, onAccount, accessRefresh }: Props) {
  const [query, setQuery] = useState("");
  const q = fold(query.trim());
  const matches = available.filter(id => !q || fold(moduleById(id).name + " " + moduleById(id).description).includes(q));
  // A few modules fit one grid; groups appear once there is something to group.
  const sections = available.length > 8 ? GROUPS.map(group => ({ id: group.id, name: group.name, items: matches.filter(id => moduleById(id).group === group.id) }))
    : [{ id: "all", name: q ? "Nájdené moduly" : "Všetky moduly", items: matches }];
  return <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={s.content}>
    <View style={s.titleRow}><Text accessibilityRole="header" style={s.title}>Moduly</Text>
      <Text style={s.count}>{available.length} {available.length === 1 ? "dostupný" : available.length < 5 ? "dostupné" : "dostupných"}</Text></View>
    <View style={s.search}><Search size={16} color={palette.secondaryLabel} accessible={false} />
      <TextInput accessibilityLabel="Hľadať modul" placeholder="Hľadať modul" placeholderTextColor={palette.secondaryLabel} value={query} onChangeText={setQuery}
        style={s.searchInput} autoCorrect={false} returnKeyType="search" maxLength={60} /></View>
    {!q && <View style={s.card}>
      <Text accessibilityRole="header" style={s.cardTitle}>Moja lišta</Text>
      <Text style={s.cardText}>Moduly, ktoré máte stále dole po ruke.</Text>
      <MiniBar tabs={tabs} showAdd={showAdd} style={{ marginVertical: space.m }} />
      <Pressable accessibilityRole="button" accessibilityLabel="Upraviť lištu" onPress={onEdit} style={({ pressed }) => [shellStyles.yellowButton, pressed && { opacity: 0.85 }]}>
        <Pencil size={16} strokeWidth={2.2} color={palette.label} accessible={false} /><Text style={shellStyles.yellowButtonText}>Upraviť lištu</Text>
      </Pressable>
    </View>}
    {sections.map(group => {
      const items = group.items;
      if (!items.length) return null;
      return <View key={group.id}><SectionHeader title={group.name} />
        <View style={s.grid}>{items.map(id => {
          const item = moduleById(id), pinned = pins.includes(id), badge = badges[id] ?? 0;
          return <Pressable key={id} accessibilityRole="button" accessibilityLabel={item.name + (pinned ? ", v lište" : "") + (badge ? ", " + badge + " čaká" : "")}
            accessibilityHint="Podržaním pridáte do lišty alebo odoberiete" onPress={() => onOpen(id)} onLongPress={() => onMenu(id)} delayLongPress={420}
            style={({ pressed }) => [s.tile, pressed && { opacity: 0.75 }]}>
            <View><ModuleTile id={id} size={52} />
              {pinned && <View style={s.pinMark}><Star size={10} color={palette.brand} fill={palette.brand} accessible={false} /></View>}
              {badge > 0 && <View style={s.badge}><Badge count={badge} /></View>}</View>
            <Text numberOfLines={2} style={s.tileLabel}>{item.short}</Text>
          </Pressable>;
        })}</View></View>;
    })}
    {q !== "" && matches.length === 0 && <Text style={s.note}>Žiadny modul pre „{query.trim()}“.</Text>}
    <SectionHeader title="Ostatné" />
    <Group><Row first title={accessRefresh.busy ? "Obnovujem prístupy…" : "Obnoviť prístupy"} subtitle="Načíta dostupné moduly podľa vášho aktuálneho prístupu."
      tone="link" disabled={accessRefresh.busy} onPress={() => { void accessRefresh.refresh(); }}
      leading={<View style={[s.rowIcon, { backgroundColor: palette.fill }]}><RefreshCw size={16} color={palette.label} accessible={false} /></View>}
      trailing={accessRefresh.busy ? <ActivityIndicator color={palette.secondaryLabel} /> : null} />
      <Row title="Účet a koncepty" subtitle="Prihlásenie, prostredie, uložené koncepty" onPress={onAccount}
      leading={<View style={[s.rowIcon, { backgroundColor: palette.fill }]}><UserRound size={16} color={palette.label} accessible={false} /></View>}
      trailing={<Text style={s.chevron}>›</Text>} /></Group>
    {accessRefresh.error ? <View style={s.refreshNotice}><ErrorNotice message={accessRefresh.error} onRetry={() => { void accessRefresh.refresh(); }} /></View>
      : accessRefresh.message ? <Text accessibilityLiveRegion="polite" style={s.note}>{accessRefresh.message}</Text> : null}
    <Text style={s.note}>★ = modul je v lište. Ťuknutím modul otvoríte, podržaním ho pridáte do lišty alebo odoberiete.</Text>
  </ScrollView>;
}
const s = StyleSheet.create({
  content: { paddingBottom: NAVIGATION_CONTENT_BOTTOM },
  titleRow: { flexDirection: "row", alignItems: "baseline", gap: space.s, paddingHorizontal: space.l, paddingTop: 2, paddingBottom: space.s },
  title: { ...type.title, color: palette.label },
  count: { ...type.subhead, fontWeight: "500", color: palette.secondaryLabel },
  search: { marginHorizontal: space.l, marginBottom: space.m, minHeight: 38, borderRadius: 19, backgroundColor: palette.fill, flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: space.m },
  searchInput: { flex: 1, minHeight: 38, fontSize: 16, color: palette.label, paddingVertical: 0 },
  card: { marginHorizontal: space.l, backgroundColor: palette.card, borderRadius: 18, padding: space.m },
  cardTitle: { ...type.rowTitle, color: palette.label },
  cardText: { ...type.caption, fontWeight: "400", color: palette.secondaryLabel },
  grid: { marginHorizontal: space.l, backgroundColor: palette.card, borderRadius: 18, paddingVertical: 14, paddingHorizontal: space.xs, flexDirection: "row", flexWrap: "wrap", rowGap: 14 },
  tile: { width: "25%", alignItems: "center", gap: 6, paddingHorizontal: 2 },
  tileLabel: { fontSize: 11.5, lineHeight: 14, fontWeight: "600", color: palette.label, textAlign: "center" },
  pinMark: { position: "absolute", top: -5, left: -6, width: 19, height: 19, borderRadius: 10, backgroundColor: palette.label, borderWidth: 2, borderColor: palette.card, alignItems: "center", justifyContent: "center" },
  badge: { position: "absolute", top: -6, right: -8, borderRadius: 11, borderWidth: 2, borderColor: palette.card },
  rowIcon: { width: 28, height: 28, borderRadius: radius.s, alignItems: "center", justifyContent: "center" },
  chevron: { fontSize: 20, color: palette.tertiaryLabel },
  note: { ...type.caption, fontWeight: "400", color: palette.secondaryLabel, paddingHorizontal: 22, paddingTop: space.m },
  refreshNotice: { paddingHorizontal: space.l, paddingTop: space.m },
});
