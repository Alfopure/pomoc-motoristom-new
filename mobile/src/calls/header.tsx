import { StyleSheet, Text, View } from "react-native";
import { palette, space, type } from "../design/tokens";
import type { HovoryView } from "../shell/navigation";
import { Segmented } from "../shell/parts";

/** One module, three parts; the badge counts callback requests still waiting. */
export function HovoryHeader({ view, onView, waiting }: { view: HovoryView; onView: (view: HovoryView) => void; waiting: number | null }) {
  return <View style={s.header}>
    <Text accessibilityRole="header" style={s.title}>Hovory</Text>
    <Segmented accessibilityLabel="Časti modulu Hovory" value={view} onChange={onView} items={[
      { id: "console", label: "Ústredňa" }, { id: "history", label: "História" }, { id: "callbacks", label: "Spätné", badge: waiting },
    ]} />
  </View>;
}
const s = StyleSheet.create({
  header: { paddingHorizontal: space.l, paddingTop: 2, paddingBottom: space.xs, gap: space.s },
  title: { ...type.title, color: palette.label },
});
