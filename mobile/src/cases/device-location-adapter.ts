import type * as ExpoLocation from "expo-location";
import type { DeviceLocationAdapter } from "./device-location";

type LocationModule = Pick<typeof ExpoLocation, "Accuracy" | "requestForegroundPermissionsAsync" | "hasServicesEnabledAsync" | "watchPositionAsync">;
/** ExpoLocation requires its native module at import time. Check before import,
 * including in older custom binaries; web does not request browser location. */
export async function prepareDeviceLocation(platform: string, available: boolean, load: () => Promise<LocationModule>): Promise<DeviceLocationAdapter> {
  if (!available || !["ios", "android"].includes(platform)) throw new Error("Device location unavailable");
  const location = await load();
  return {
    permission: async () => {
      const response = await location.requestForegroundPermissionsAsync();
      return { granted: response.granted === true && response.status === "granted", canAskAgain: response.canAskAgain === true };
    },
    services: () => location.hasServicesEnabledAsync(),
    watch: (receive, fail) => location.watchPositionAsync({ accuracy: location.Accuracy.High, timeInterval: 1000, distanceInterval: 0, mayShowUserSettingsDialog: false }, receive, fail),
  };
}
