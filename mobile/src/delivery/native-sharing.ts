import { Platform } from "react-native";
import Constants, { ExecutionEnvironment } from "expo-constants";
import * as Location from "expo-location";
import * as SecureStore from "expo-secure-store";
import * as TaskManager from "expo-task-manager";
import { File, Paths } from "expo-file-system";
import type { MobileConfig } from "../lib/config";
import { MobileApiError } from "../lib/api";
import type { DeliveryApi } from "./api";
import {
  DELIVERY_TASK, DELIVERY_TRACK_PATH, OPERATION_TASK, OPERATION_TRACK_PATH, deliverReadings, parseQueue, parseTrackingState, sendReadings, toReading,
  type ReadingQueue, type TaskDeps, type TrackingStore,
} from "./background";
import { phoneLocation } from "./location";
import { BackgroundTracker, serially, type BackgroundSource, type LocationSharing, type Permission } from "./sharing";
import { DeliveryTracker } from "./tracker";

/** Background location needs the native app: Expo Go cannot keep it, and Android
 * is not configured for it yet. Both keep sending while the app is open. */
export function backgroundSupported(): boolean {
  return Platform.OS === "ios" && Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;
}

// Readable while the phone is locked after its first unlock, as the background needs.
const keychain = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const status = (value: { status?: string }): Permission => value.status === "granted" ? "granted" : value.status === "denied" ? "denied" : "undetermined";

/** One background sending of this phone: its iOS task, Keychain entry, waiting list
 * and route. Pristavenia and Moja práca each have their own, so one never stops the other. */
function channel(task: string, stateKey: string, queueName: string, path: string) {
  const store: TrackingStore = {
    load: async () => parseTrackingState(await SecureStore.getItemAsync(stateKey, keychain)),
    save: async state => { await SecureStore.setItemAsync(stateKey, JSON.stringify(state), keychain); },
    clear: async () => { await SecureStore.deleteItemAsync(stateKey, keychain); },
  };
  // In caches: not backed up, and losing it only loses positions not yet sent.
  const queueFile = () => new File(Paths.cache, queueName);
  const queue: ReadingQueue = {
    load: async () => { const file = queueFile(); return file.exists ? parseQueue(await file.text()) : []; },
    save: async readings => {
      const file = queueFile();
      if (!readings.length) { if (file.exists) file.delete(); return; }
      if (!file.exists) file.create();
      file.write(JSON.stringify({ version: 1, readings }));
    },
    clear: async () => { const file = queueFile(); if (file.exists) file.delete(); },
  };
  const running = () => Location.hasStartedLocationUpdatesAsync(task).catch(() => false);
  const source: BackgroundSource = {
    permission: async () => status(await Location.getForegroundPermissionsAsync()),
    request: async () => status(await Location.requestForegroundPermissionsAsync()),
    backgroundPermission: async () => status(await Location.getBackgroundPermissionsAsync()),
    requestBackground: async () => status(await Location.requestBackgroundPermissionsAsync()),
    running,
    // Driving: precise, every 50 m, sent at most every 20 s; the blue indicator shows it.
    start: () => Location.startLocationUpdatesAsync(task, {
      accuracy: Location.Accuracy.High, distanceInterval: 50, deferredUpdatesInterval: 20_000, pausesUpdatesAutomatically: false,
      activityType: Location.ActivityType.AutomotiveNavigation, showsBackgroundLocationIndicator: true,
    }),
    stop: () => Location.stopLocationUpdatesAsync(task),
  };
  let lastSent = 0;
  const deps: TaskDeps = {
    store, queue, send: (state, batch) => sendReadings(state, batch, fetch, path),
    stopUpdates: async () => { if (await running()) await Location.stopLocationUpdatesAsync(task); },
    sentAt: () => lastSent, markSent: at => { lastSent = at; },
  };
  return { task, store, queue, source, deps };
}
const delivery = channel(DELIVERY_TASK, "pm-delivery-tracking-v1", "pm-delivery-queue-v1.json", DELIVERY_TRACK_PATH);
const operation = channel(OPERATION_TASK, "pm-operation-tracking-v1", "pm-operation-queue-v1.json", OPERATION_TRACK_PATH);
const channels = [delivery, operation];

/** Registered when the app starts, also when iOS starts it in the background for a location.
 * Runs one after another, so two readings never write a waiting list at once. */
export function defineLocationTasks() {
  for (const { task, deps } of channels) {
    if (TaskManager.isTaskDefined(task)) continue;
    TaskManager.defineTask<{ locations?: unknown[] }>(task, async ({ data, error }) => {
      if (error) return;
      const readings = (data?.locations ?? []).flatMap(toReading);
      await serially(async () => { await deliverReadings(deps, readings); }).catch(() => undefined);
    });
  }
}

/** Signed out, also without a logout in the app (an expired session): nothing more
 * leaves this phone. The secrets themselves end with their delivery or operation. */
export function haltBackgroundSharing(): Promise<void> {
  if (!backgroundSupported()) return Promise.resolve();
  return serially(async () => {
    for (const { deps } of channels) {
      await deps.stopUpdates().catch(() => undefined);
      await deps.store.clear().catch(() => undefined);
      await deps.queue.clear().catch(() => undefined);
    }
  }).catch(() => undefined);
}

export function createLocationSharing(api: DeliveryApi, config: MobileConfig): LocationSharing {
  if (backgroundSupported()) return new BackgroundTracker({
    source: delivery.source, store: delivery.store, queue: delivery.queue,
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

/** Moja práca in the native app: the member's own accepted operation, also in the
 * background; null where only the open app can send (Expo Go, Android, web). */
export function createOperationSharing(tracker: { issue: (operationId: string) => Promise<{ token: string; expiresAt: string }>; revoke: (operationId: string) => Promise<unknown> },
  config: MobileConfig): LocationSharing | null {
  if (!backgroundSupported()) return null;
  return new BackgroundTracker({ source: operation.source, store: operation.store, queue: operation.queue, issue: tracker.issue, revoke: tracker.revoke,
    scope: { environment: config.environment, apiOrigin: config.apiOrigin } });
}
