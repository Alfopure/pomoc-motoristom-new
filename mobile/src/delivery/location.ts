import * as Location from "expo-location";
import type { LocationSource } from "./tracker";

const status = (value: { status?: string }) => value.status === "granted" ? "granted" as const : value.status === "denied" ? "denied" as const : "undetermined" as const;

/** expo-location while the app is open: balanced accuracy, every 30 s or 50 m. */
export const phoneLocation: LocationSource = {
  permission: async () => status(await Location.getForegroundPermissionsAsync()),
  request: async () => status(await Location.requestForegroundPermissionsAsync()),
  watch: async onPosition => Location.watchPositionAsync({ accuracy: Location.Accuracy.Balanced, timeInterval: 30_000, distanceInterval: 50 }, reading => {
    onPosition({ lat: reading.coords.latitude, lng: reading.coords.longitude, accuracy: reading.coords.accuracy ?? null, recordedAt: new Date(reading.timestamp).toISOString() });
  }),
};
