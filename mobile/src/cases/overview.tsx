import { Pressable, StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import type { CasesApi } from "./api";
import type { CaseShortcut } from "./filters";
import { MobileApiError } from "../lib/api";
import { formatTime } from "../lib/display";
import { ErrorNotice, Loading, colors, styles } from "../ui";

const cards: { key: CaseShortcut; label: string }[] = [
  { key: "open", label: "Všetky otvorené" }, { key: "mine", label: "Moje otvorené" },
  { key: "unassigned", label: "Nepriradené otvorené" }, { key: "urgent", label: "Horí · otvorené" },
];
export function CaseOverview({ api, queryKey, active, pendingFilter, onSelect }: {
  api: CasesApi; queryKey: string[]; active: boolean; pendingFilter: boolean; onSelect: (value: CaseShortcut) => void;
}) {
  const query = useQuery({ queryKey: [...queryKey, "overview"], queryFn: ({ signal }) => api.overview(signal), enabled: active });
  if (!active) return null;
  return <View style={{ gap: 8 }}>
    <Text style={styles.subheading}>Prehľad otvorených prípadov</Text>
    {query.isError ? <ErrorNotice message={query.error instanceof MobileApiError ? query.error.message : "Prehľad sa nepodarilo načítať."} onRetry={() => { void query.refetch(); }} />
      : query.isPending || query.isFetching || pendingFilter ? <Loading />
        : <><View style={s.grid}>{cards.map(card => <Pressable key={card.key} accessibilityRole="button" accessibilityLabel={card.label} onPress={() => onSelect(card.key)} style={s.card}>
          <Text style={[s.count, card.key === "urgent" && { color: colors.danger }]}>{query.data.counts[card.key]}</Text>
          <Text style={styles.muted}>{card.label}</Text>
        </Pressable>)}</View><Text style={styles.muted}>Celá organizácia · {formatTime(query.data.checkedAt)}</Text></>}
  </View>;
}
const s = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  card: { flexGrow: 1, flexBasis: "45%", padding: 14, minHeight: 84, borderRadius: 16, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.border, gap: 4 },
  count: { color: colors.ink, fontSize: 26, fontWeight: "700" },
});
