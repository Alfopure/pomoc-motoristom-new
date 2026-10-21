import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import Constants, { ExecutionEnvironment } from "expo-constants";
import { randomUUID } from "expo-crypto";
import type { MobileEnvironment } from "../../../src/lib/mobile-api";
import { appVersion } from "../lib/app-version";
import type { PushDevice, PushPermission } from "./settings";
import type { PushTapInbox } from "./taps";

const INSTALLATION = "pm-installation-v1";
const stored = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const status = (value: { status?: string }): PushPermission => value.status === "granted" ? "granted" : value.status === "denied" ? "denied" : "undetermined";

/** This phone: system permission, the Expo push token, a stable installation
 * identifier and the operator's choice, kept in the keychain per account. */
export function createPushDevice(environment: MobileEnvironment, userId: string): PushDevice {
  const choice = "pm-push-v1." + environment + "." + userId;
  return {
    platform: Platform.OS === "android" ? "android" : "ios",
    appVersion: appVersion().version,
    unsupported: () => Platform.OS === "web" ? "Notifikácie fungujú iba v aplikácii v telefóne."
      : Platform.OS === "android" && Constants.executionEnvironment === ExecutionEnvironment.StoreClient
        ? "V Expo Go na Androide notifikácie nefungujú; fungujú v nainštalovanej aplikácii." : null,
    permission: async () => status(await Notifications.getPermissionsAsync()),
    request: async () => status(await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } })),
    token: async () => {
      if (Platform.OS === "android") {
        await Notifications.setNotificationChannelAsync("default", { name: "Dispečing", importance: Notifications.AndroidImportance.HIGH });
      }
      const projectId = Constants.easConfig?.projectId ?? (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
      return (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data;
    },
    installationId: () => {
      const existing = SecureStore.getItem(INSTALLATION);
      if (existing) return existing;
      const created = randomUUID();
      SecureStore.setItem(INSTALLATION, created, stored);
      return created;
    },
    remembered: () => { try { return SecureStore.getItem(choice) === "1"; } catch { return false; } },
    remember: on => {
      try { if (on) SecureStore.setItem(choice, "1", stored); else void SecureStore.deleteItemAsync(choice).catch(() => undefined); }
      catch { /* The choice is asked again next time. */ }
    },
  };
}

/** Shows notices while the app is open and hands every tap to the inbox,
 * including the one that started the app. */
export function installPushTaps(inbox: PushTapInbox): () => void {
  if (Platform.OS === "web") return () => undefined;
  try {
    Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }) });
    const last = Notifications.getLastNotificationResponse();
    if (last) { inbox.receive(last); Notifications.clearLastNotificationResponse(); }
    const subscription = Notifications.addNotificationResponseReceivedListener(response => {
      inbox.receive(response);
      Notifications.clearLastNotificationResponse();
    });
    return () => subscription.remove();
  } catch {
    return () => undefined;
  }
}
