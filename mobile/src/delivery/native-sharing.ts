import { Platform } from "react-native";
import Constants, { ExecutionEnvironment } from "expo-constants";
import * as Location from "expo-location";
import * as SecureStore from "expo-secure-store";
import * as TaskManager from "expo-task-manager";
import { File, Paths } from "expo-file-system";
import type { MobileConfig } from "../lib/config";
import { MobileApiError } from "../lib/api";
import type { DeliveryApi } from "./api";
import { DELIVERY_TASK, deliverReadings, parseQueue, parseTrackingState, sendReadings, toReading, type ReadingQueue, type TaskDeps, type TrackingStore } from "./background";
import { phoneLocation } from "./location";
import { BackgroundTracker, type BackgroundSource, type LocationSharing, type Permission } from "./sharing";
import { DeliveryTracker } from "./tracker";

/** Background location needs the native app: Expo Go cannot keep it, and Android
 * is not configured for it yet. Both keep sending while the app is open. */
export function backgroundSupported(): boolean {
  return Platform.OS === "ios" && Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;
}

const STATE_KEY = "pm-delivery-tracking-v1";
// Readable while the phone is locked after its first unlock, as the background needs.
const keychain = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
export const keychainStore: TrackingStore = {
  load: async () => parseTrackingState(await SecureStore.getItemAsync(STATE_KEY, keychain)),
  save: async state => { await SecureStore.setItemAsync(STATE_KEY, JSON.stringify(state), keychain); },
  clear: async () => { await SecureStore.deleteItemAsync(STATE_KEY, keychain); },
};
const queueFile = () => new File(Paths.document, "pm-delivery-queue-v1.json");
export const fileQueue: ReadingQueue = {
  load: async () => { const file = queueFile(); return file.exists ? parseQueue(await file.text()) : []; },
  save: async readings => {
    const file = queueFile();
    if (!readings.length) { if (file.exists) file.delete(); return; }
    if (!file.exists) file.create();
    file.write(JSON.stringify({ version: 1, readings }));
  },
  clear: async () => { const file = queueFile(); if (file.exists) file.delete(); },
};

const status = (value: { status?: string }): Permission => value.status === "granted" ? "granted" : value.status === "denied" ? "denied" : "undetermined";
const running = () => Location.hasStartedLocationUpdatesAsync(DELIVERY_TASK).catch(() => false);
export const backgroundSource: BackgroundSource = {
  permission: async () => status(await Location.getForegroundPermissionsAsync()),
  request: async () => status(await Location.requestForegroundPermissionsAsync()),
  backgroundPermission: async () => status(await Location.getBackgroundPermissionsAsync()),
  requestBackground: async () => status(await Location.requestBackgroundPermissionsAsync()),
  running,
  // Driving: precise, every 50 m, sent at most every 20 s; the blue indicator shows it.
  start: () => Location.startLocationUpdatesAsync(DELIVERY_TASK, {
    accuracy: Location.Accuracy.High, distanceInterval: 50, deferredUpdatesInterval: 20_000, pausesUpdatesAutomatically: false,
    activityType: Location.ActivityType.AutomotiveNavigation, showsBackgroundLocationIndicator: true,
  }),
  stop: () => Location.stopLocationUpdatesAsync(DELIVERY_TASK),
};
const taskDeps: TaskDeps = {
  store: keychainStore, queue: fileQueue, send: (state, batch) => sendReadings(state, batch),
  stopUpdates: async () => { if (await running()) await Location.stopLocationUpdatesAsync(DELIVERY_TASK); },
};

/** Registered when the app starts, also when iOS starts it in the background for a location. */
export function defineDeliveryTask() {
  if (TaskManager.isTaskDefined(DELIVERY_TASK)) return;
  TaskManager.defineTask<{ locations?: unknown[] }>(DELIVERY_TASK, async ({ data, error }) => {
    if (error) return;
    await deliverReadings(taskDeps, (data?.locations ?? []).flatMap(toReading)).catch(() => undefined);
  });
}

export function createLocationSharing(api: DeliveryApi, config: MobileConfig): LocationSharing {
  if (backgroundSupported()) return new BackgroundTracker({
    source: backgroundSource, store: keychainStore, queue: fileQueue,
    issue: async deliveryId => { const tracker = await api.tracker(deliveryId); return { token: tracker.token, expiresAt: tracker.expiresAt }; },
    revoke: deliveryId => api.untrack(deliveryId),
    scope: { environment: config.environment, apiOrigin: config.apiOrigin },
  });
  return new DeliveryTracker(phoneLocation, async (id, position) => {
    try { return (await api.position(id, position)).active; }
    // A delivery that is gone, or an account without access any more: stop sharing.
    catch (error) { if (error instanceof MobileApiError && [403, 404].includes(error.status)) return false; throw error; }
  });
}
