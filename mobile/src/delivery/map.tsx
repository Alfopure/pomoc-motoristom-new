import { StyleSheet, Text, View } from "react-native";
import MapView, { Marker } from "react-native-maps";
import { palette, space, type } from "../design/tokens";
import type { DeliveryPoint } from "./model";

const colors: Record<DeliveryPoint["key"], string> = { car: palette.blue, client: palette.red, destination: "#8E8E93" };

/** The lower part of a delivery: where the car is, where the client is, and the
 * pristavovač's own dot once location is shared. Apple Maps on iPhone, no key needed.
 * `inset`: the bottom part covered by the app's floating bar. */
export function DeliveryMap({ points, showsUser, height, inset = 0 }: { points: DeliveryPoint[]; showsUser: boolean; height: number; inset?: number }) {
  if (!points.length) {
    return <View style={[s.empty, { height: Math.min(height - inset, 120), marginBottom: inset }]}>
      <Text style={s.emptyText}>Miesta tohto pristavenia nemajú súradnice. Navigujte podľa adresy vyššie.</Text>
    </View>;
  }
  const lats = points.map(p => p.lat), lngs = points.map(p => p.lng);
  const region = {
    latitude: (Math.min(...lats) + Math.max(...lats)) / 2, longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2,
    latitudeDelta: Math.max(0.02, (Math.max(...lats) - Math.min(...lats)) * 1.6), longitudeDelta: Math.max(0.02, (Math.max(...lngs) - Math.min(...lngs)) * 1.6),
  };
  return <View style={{ height }} accessibilityLabel={"Mapa: " + points.map(p => p.label).join(", ")}>
    <MapView style={StyleSheet.absoluteFill} initialRegion={region} mapPadding={{ top: 0, left: 0, right: 0, bottom: inset }} showsUserLocation={showsUser} showsCompass={false} toolbarEnabled={false} rotateEnabled={false}>
      {points.map(point => <Marker key={point.key} coordinate={{ latitude: point.lat, longitude: point.lng }} title={point.label} description={point.title} pinColor={colors[point.key]} />)}
    </MapView>
    <View style={[s.legend, { bottom: inset + space.s }]} pointerEvents="none">
      {points.map(point => <View key={point.key} style={s.legendItem}><View style={[s.dot, { backgroundColor: colors[point.key] }]} /><Text style={s.legendText}>{point.label}</Text></View>)}
    </View>
  </View>;
}

const s = StyleSheet.create({
  empty: { marginHorizontal: space.l, borderRadius: 16, backgroundColor: palette.fill, alignItems: "center", justifyContent: "center", padding: space.m },
  emptyText: { ...type.subhead, color: palette.secondaryLabel, textAlign: "center" },
  legend: { position: "absolute", left: space.s, bottom: space.s, flexDirection: "row", flexWrap: "wrap", gap: 6 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "rgba(255,255,255,0.92)", borderRadius: 10, paddingHorizontal: 7, paddingVertical: 3 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { ...type.caption, color: palette.label },
});
