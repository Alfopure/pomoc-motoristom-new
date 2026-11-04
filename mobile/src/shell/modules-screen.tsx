import { useState } from "react";
import { ActivityIndicator, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";
import { Ellipsis, Pencil, RefreshCw, Search, Star, UserRound, X } from "lucide-react-native";
import { palette, radius, space, type } from "../design/tokens";
import { columnsForWidth, gridItemWidth } from "../design/layout";
import { NAVIGATION_CONTENT_BOTTOM } from "../ui/theme";
import { GROUPS, moduleById, type ModuleId } from "./modules";
import type { ShellTab } from "./navigation";
import { Group, Row, SectionHeader } from "../design/list";
import { Badge, MiniBar, ModuleTile, shellStyles } from "./parts";
import { Button, ErrorNotice } from "../ui";

export type ModuleAccessRefresh = {
  busy: boolean; error: string | null; message: string | null; refresh: () => Promise<void>;
};

type Props = {
  available: ModuleId[]; pins: ModuleId[]; tabs: ShellTab[]; showAdd: boolean; badges: Partial<Record<ModuleId, number>>;
  onOpen: (id: ModuleId) => void; onMenu: (id: ModuleId) => void; onEdit: () => void; onAccount: () => void;
  accessRefresh: ModuleAccessRefresh;
};
const fold = (value: string) => value.toLocaleLowerCase("sk").normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Permitted modules first; bar customization is a secondary, visible action. */
export function ModulesScreen({ available, pins, tabs, showAdd, badges, onOpen, onMenu, onEdit, onAccount, accessRefresh }: Props) {
  const [query, setQuery] = useState("");
  const { width, fontScale } = useWindowDimensions();
  const [gridWidth, setGridWidth] = useState(width - space.l * 2);
  const columns = columnsForWidth(gridWidth, fontScale, 164, 3, space.m);
  const tileWidth = gridItemWidth(gridWidth, columns, space.m);
  const q = fold(query.trim());
  const matches = available.filter(id => !q || fold(moduleById(id).name + " " + moduleById(id).description).includes(q));
  // Groups appear only when there are enough modules to benefit from them.
  const sections = available.length > 8 ? GROUPS.map(group => ({ id: group.id, name: group.name, items: matches.filter(id => moduleById(id).group === group.id) }))
    : [{ id: "all", name: q ? "Nájdené moduly" : "Všetky moduly", items: matches }];
  return <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={s.content}>
    <View style={s.titleRow}><Text accessibilityRole="header" style={s.title}>Moduly</Text>
      <Text style={s.count}>{available.length} {available.length === 1 ? "dostupný modul" : available.length < 5 ? "dostupné moduly" : "dostupných modulov"}</Text></View>
    <View style={s.search}><Search size={20} color={palette.secondaryLabel} accessible={false} />
      <TextInput accessibilityLabel="Hľadať modul" placeholder="Hľadať modul…" placeholderTextColor={palette.secondaryLabel} value={query} onChangeText={setQuery}
        style={s.searchInput} autoCorrect={false} returnKeyType="search" maxLength={60} onSubmitEditing={Keyboard.dismiss} />
      {query !== "" && <Pressable accessibilityRole="button" accessibilityLabel="Vymazať hľadanie modulov" onPress={() => setQuery("")}
        style={({ pressed }) => [s.clear, pressed && { opacity: 0.65 }]}><X size={16} color={palette.secondaryLabel} accessible={false} /><Text style={s.clearText}>Vymazať</Text></Pressable>}
    </View>
    {sections.map(group => {
      if (!group.items.length) return null;
      return <View key={group.id}><SectionHeader title={group.name} />
        <View style={s.grid} onLayout={event => setGridWidth(event.nativeEvent.layout.width)}>{group.items.map(id => {
          const item = moduleById(id), pinned = pins.includes(id), badge = badges[id] ?? 0;
          return <View key={id} style={[s.tile, { width: tileWidth }]}>
            <Pressable accessibilityRole="button" accessibilityLabel={item.name + ". " + item.description + (pinned ? ". V spodnej lište" : "") + (badge ? ". " + badge + " čaká" : "")}
              onPress={() => onOpen(id)} onLongPress={() => onMenu(id)} delayLongPress={420}
              style={({ pressed }) => [s.tileOpen, pressed && { opacity: 0.7 }]}>
              <View style={s.tileHead}><ModuleTile id={id} size={40} />{badge > 0 && <Badge count={badge} />}</View>
              <Text style={s.tileLabel}>{item.name}</Text>
              <Text style={s.tileDescription}>{item.description}</Text>
              {pinned && <View style={s.pinMark}><Star size={12} color={palette.brandInk} fill={palette.brandInk} accessible={false} /><Text style={s.pinText}>V lište</Text></View>}
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={"Možnosti modulu " + item.name} onPress={() => onMenu(id)}
              style={({ pressed }) => [s.tileMenu, pressed && { backgroundColor: palette.fill }]}>
              <Ellipsis size={18} color={palette.secondaryLabel} accessible={false} /><Text style={s.menuText}>Možnosti</Text>
            </Pressable>
          </View>;
        })}</View></View>;
    })}
    {q !== "" && matches.length === 0 && <View style={s.empty}>
      <Text accessibilityRole="header" style={s.cardTitle}>Žiadny zodpovedajúci modul</Text>
      <Text style={s.cardText}>Pre „{query.trim()}“ sme nič nenašli. Skúste iný názov alebo vymažte hľadanie.</Text>
      <Button label="Vymazať hľadanie" secondary onPress={() => setQuery("")} />
    </View>}
    {!q && <>
      <SectionHeader title="Moja lišta" />
      <View style={s.card}>
        <Text style={s.cardText}>Vyberte si moduly, ktoré chcete mať vždy po ruke.</Text>
        <MiniBar tabs={tabs} showAdd={showAdd} style={{ marginVertical: space.m }} />
        <Pressable accessibilityRole="button" accessibilityLabel="Upraviť lištu" onPress={onEdit} style={({ pressed }) => [shellStyles.yellowButton, pressed && { opacity: 0.85 }]}>
          <Pencil size={18} strokeWidth={2} color={palette.label} accessible={false} /><Text style={shellStyles.yellowButtonText}>Upraviť lištu</Text>
        </Pressable>
      </View>
    </>}
    <SectionHeader title="Účet a prístupy" />
    <Group><Row first title="Účet a koncepty" subtitle="Nastavenia, notifikácie a rozpísaná práca" onPress={onAccount}
      leading={<View style={s.rowIcon}><UserRound size={20} color={palette.label} accessible={false} /></View>}
      trailing={<Text style={s.chevron}>›</Text>} />
      <Row title={accessRefresh.busy ? "Obnovujem prístupy…" : "Obnoviť prístupy"} subtitle="Načíta moduly podľa vášho aktuálneho prístupu."
        tone="link" disabled={accessRefresh.busy} onPress={() => { void accessRefresh.refresh(); }}
        leading={<View style={s.rowIcon}><RefreshCw size={20} color={palette.label} accessible={false} /></View>}
        trailing={accessRefresh.busy ? <ActivityIndicator color={palette.secondaryLabel} /> : null} />
    </Group>
    {accessRefresh.error ? <View style={s.refreshNotice}><ErrorNotice message={accessRefresh.error} onRetry={() => { void accessRefresh.refresh(); }} /></View>
      : accessRefresh.message ? <Text accessibilityLiveRegion="polite" style={s.note}>{accessRefresh.message}</Text> : null}
    <Text style={s.note}>Cez Možnosti pri module ho pridáte do lišty alebo odoberiete. Podržanie modulu otvorí rovnakú ponuku.</Text>
  </ScrollView>;
}
const s = StyleSheet.create({
  content: { paddingBottom: NAVIGATION_CONTENT_BOTTOM },
  titleRow: { gap: space.xs, paddingHorizontal: space.l, paddingTop: space.s, paddingBottom: space.l },
  title: { ...type.title, color: palette.label },
  count: { ...type.subhead, color: palette.secondaryLabel },
  search: { marginHorizontal: space.l, minHeight: 48, borderRadius: radius.m, backgroundColor: palette.fill, flexDirection: "row", alignItems: "center", gap: space.s, paddingLeft: space.m, paddingRight: space.xs },
  searchInput: { ...type.body, flex: 1, minWidth: 0, minHeight: 48, color: palette.label, paddingVertical: space.s },
  clear: { minHeight: 44, minWidth: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.xs, paddingHorizontal: space.s },
  clearText: { ...type.caption, color: palette.secondaryLabel },
  card: { marginHorizontal: space.l, backgroundColor: palette.card, borderRadius: radius.l, borderCurve: "continuous", padding: space.l },
  cardTitle: { ...type.headline, color: palette.label },
  cardText: { ...type.subhead, color: palette.secondaryLabel },
  grid: { marginHorizontal: space.l, flexDirection: "row", flexWrap: "wrap", gap: space.m },
  tile: { backgroundColor: palette.card, borderRadius: radius.l, borderCurve: "continuous", overflow: "hidden" },
  tileOpen: { flex: 1, minHeight: 168, gap: space.s, padding: space.l },
  tileHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.s },
  tileLabel: { ...type.headline, color: palette.label },
  tileDescription: { ...type.subhead, color: palette.secondaryLabel },
  tileMenu: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.s, paddingHorizontal: space.m, paddingVertical: space.s, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.separator },
  menuText: { ...type.caption, color: palette.secondaryLabel },
  pinMark: { flexDirection: "row", alignItems: "center", gap: space.xs },
  pinText: { ...type.caption, color: palette.brandInk },
  rowIcon: { width: 36, height: 36, borderRadius: radius.m, backgroundColor: palette.fill, alignItems: "center", justifyContent: "center" },
  chevron: { ...type.objectTitle, color: palette.secondaryLabel },
  empty: { marginHorizontal: space.l, marginTop: space.l, padding: space.l, borderRadius: radius.l, backgroundColor: palette.card, gap: space.m },
  note: { ...type.caption, color: palette.secondaryLabel, paddingHorizontal: space.l, paddingTop: space.m },
  refreshNotice: { paddingHorizontal: space.l, paddingTop: space.m },
});
