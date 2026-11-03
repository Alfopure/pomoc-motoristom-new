import { requireOptionalNativeModule } from "expo";
import { randomUUID } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { createSessionStorage, memoryStorage, type StorageDriver } from "../lib/session-storage";
import { draftStorageKey, type DraftScope } from "./vault";

type Dependencies = { platform: string; checkedAndroidCommit: boolean; secure: StorageDriver; uuid: () => string };
const volatile = memoryStorage();

/** Separate queue/service from login. Unsupported Android builds may never
 * silently replace an existing durable write barrier with volatile storage. */
export function draftStorage(scope: DraftScope, dependencies: Dependencies) {
  const { platform, checkedAndroidCommit, secure, uuid } = dependencies;
  if (platform === "web") return { storage: volatile, durable: false };
  const encrypted = createSessionStorage(secure, uuid);
  if (platform === "ios" || platform === "android" && checkedAndroidCommit) return { storage: encrypted, durable: true };
  const key = draftStorageKey(scope);
  const absent = async () => {
    if (await secure.getItem(key) !== null) throw new Error("This Android build cannot safely restore durable drafts");
  };
  const storage: StorageDriver = {
    getItem: async name => { await absent(); return volatile.getItem(name); },
    setItem: async (name, value) => { await absent(); await volatile.setItem(name, value); },
    removeItem: async name => { await encrypted.removeItem(name); await volatile.removeItem(name); },
  };
  return { storage, durable: false };
}

/** Public capability only: no account, token or private storage read. */
export function supportsDurableDrafts() {
  if (Platform.OS === "ios") return true;
  if (Platform.OS !== "android") return false;
  const module = requireOptionalNativeModule<{ pmDraftDiskCommitChecked?: number }>("ExpoSecureStore");
  return module?.pmDraftDiskCommitChecked === 1;
}

export function createDraftStorage(scope: DraftScope) {
  const service = { keychainService: "pm-dispatch-private-drafts-v1", keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  return draftStorage(scope, { platform: Platform.OS, checkedAndroidCommit: supportsDurableDrafts(), uuid: randomUUID, secure: {
    getItem: key => SecureStore.getItemAsync(key, service),
    setItem: (key, value) => SecureStore.setItemAsync(key, value, service),
    removeItem: key => SecureStore.deleteItemAsync(key, service),
  } });
}
