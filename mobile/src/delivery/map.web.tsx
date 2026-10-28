import { StyleSheet, Text, View } from "react-native";
import { palette, space, type } from "../design/tokens";
import type { DeliveryPoint } from "./model";

/** The browser preview has no native map (react-native-maps has no web view); the
 * places stay listed above with their navigation buttons. */
export function DeliveryMap({ points, height, inset = 0 }: { points: DeliveryPoint[]; showsUser: boolean; height: number; inset?: number }) {
  return <View style={[s.empty, { height: Math.min(height - inset, 120), marginBottom: inset }]}>
    <Text style={s.emptyText}>{points.length ? "Mapa sa zobrazí v aplikácii v telefóne. Navigujte podľa adresy vyššie." : "Miesta tohto pristavenia nemajú súradnice. Navigujte podľa adresy vyššie."}</Text>
  </View>;
}

const s = StyleSheet.create({
  empty: { marginHorizontal: space.l, borderRadius: 16, backgroundColor: palette.fill, alignItems: "center", justifyContent: "center", padding: space.m },
  emptyText: { ...type.subhead, color: palette.secondaryLabel, textAlign: "center" },
});
