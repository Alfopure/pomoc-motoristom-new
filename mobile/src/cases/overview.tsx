import { useState } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { columnsForWidth, gridItemWidth } from "../design/layout";
import { palette, radius, space, type } from "../design/tokens";
import { useQuery } from "@tanstack/react-query";
import type { CasesApi } from "./api";
import type { CaseShortcut } from "./filters";
import { MobileApiError } from "../lib/api";
import { formatTime } from "../lib/display";
import { ErrorNotice, Loading, colors, styles } from "../ui";

const cards: { key: CaseShortcut; label: string; accessibilityLabel: string }[] = [
  { key: "open", label: "Otvorené", accessibilityLabel: "Všetky otvorené" }, { key: "mine", label: "Moje", accessibilityLabel: "Moje otvorené" },
  { key: "unassigned", label: "Nepriradené", accessibilityLabel: "Nepriradené otvorené" }, { key: "urgent", label: "Horí", accessibilityLabel: "Horí · otvorené" },
];
export function CaseOverview({ api, queryKey, active, pendingFilter, onSelect }: {
  api: CasesApi; queryKey: string[]; active: boolean; pendingFilter: boolean; onSelect: (value: CaseShortcut) => void;
}) {
  const { width, fontScale } = useWindowDimensions();
  const [gridWidth, setGridWidth] = useState(width - space.l * 2);
  const columns = columnsForWidth(gridWidth, fontScale, 136, 4, space.s);
  const cardWidth = gridItemWidth(gridWidth, columns, space.s);
  const query = useQuery({ queryKey: [...queryKey, "overview"], queryFn: ({ signal }) => api.overview(signal), enabled: active });
  if (!active) return null;
  return <View style={{ gap: 8 }}>
    {query.isError ? <ErrorNotice message={query.error instanceof MobileApiError ? query.error.message : "Prehľad sa nepodarilo načítať."} onRetry={() => { void query.refetch(); }} />
      : query.isPending || pendingFilter ? <Loading />
        : <><View style={s.grid} onLayout={event => setGridWidth(event.nativeEvent.layout.width)}>{cards.map(card => <Pressable key={card.key} accessibilityRole="button" accessibilityLabel={card.accessibilityLabel + ": " + query.data.counts[card.key]} onPress={() => onSelect(card.key)}
          style={({ pressed }) => [s.card, { width: cardWidth }, pressed && { opacity: 0.7 }]}>
          <Text style={[s.count, card.key === "urgent" && { color: colors.danger }]}>{query.data.counts[card.key]}</Text>
          <Text style={s.label}>{card.label}</Text>
        </Pressable>)}</View><Text style={styles.muted}>Otvorené prípady celej organizácie · {formatTime(query.data.checkedAt)}</Text></>}
  </View>;
}
const s = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space.s },
  card: { minWidth: 0, padding: space.m, minHeight: 88, borderRadius: radius.l, borderCurve: "continuous", backgroundColor: palette.card, gap: space.xs },
  count: { ...type.number, color: palette.label },
  label: { ...type.subhead, color: palette.secondaryLabel },
});
