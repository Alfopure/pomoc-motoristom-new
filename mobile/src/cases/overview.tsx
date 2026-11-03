import { Pressable, StyleSheet, Text, View } from "react-native";
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
  const query = useQuery({ queryKey: [...queryKey, "overview"], queryFn: ({ signal }) => api.overview(signal), enabled: active });
  if (!active) return null;
  return <View style={{ gap: 8 }}>
    {query.isError ? <ErrorNotice message={query.error instanceof MobileApiError ? query.error.message : "Prehľad sa nepodarilo načítať."} onRetry={() => { void query.refetch(); }} />
      : query.isPending || query.isFetching || pendingFilter ? <Loading />
        : <><View style={s.grid}>{cards.map(card => <Pressable key={card.key} accessibilityRole="button" accessibilityLabel={card.accessibilityLabel + ": " + query.data.counts[card.key]} onPress={() => onSelect(card.key)}
          style={({ pressed }) => [s.card, pressed && { opacity: 0.7 }]}>
          <Text numberOfLines={1} adjustsFontSizeToFit style={[s.count, card.key === "urgent" && { color: colors.danger }]}>{query.data.counts[card.key]}</Text>
          <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75} style={s.label}>{card.label}</Text>
        </Pressable>)}</View><Text style={styles.muted}>Otvorené prípady celej organizácie · {formatTime(query.data.checkedAt)}</Text></>}
  </View>;
}
const s = StyleSheet.create({
  grid: { flexDirection: "row", gap: 8 },
  card: { flex: 1, minWidth: 0, paddingHorizontal: 10, paddingVertical: 9, minHeight: 58, borderRadius: 14, backgroundColor: colors.white, gap: 1 },
  count: { color: colors.ink, fontSize: 20, lineHeight: 25, fontWeight: "700", letterSpacing: -0.4, fontVariant: ["tabular-nums"] },
  label: { fontSize: 12, lineHeight: 16, fontWeight: "500", color: colors.muted },
});
