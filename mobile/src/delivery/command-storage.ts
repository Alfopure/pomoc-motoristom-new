import { randomUUID } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { supportsDurableDrafts } from "../drafts/storage";
import { createSessionStorage, memoryStorage, type StorageDriver } from "../lib/session-storage";

const service = { keychainService: "pm-delivery-commands-v1", keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
// One queue also across sign-out/sign-in, so a late old write finishes before the
// next account instance reads. Web keeps only a clearly labeled in-memory copy.
const encrypted = createSessionStorage({
  getItem: key => SecureStore.getItemAsync(key, service),
  setItem: (key, value) => SecureStore.setItemAsync(key, value, service),
  removeItem: key => SecureStore.deleteItemAsync(key, service),
}, randomUUID);
const volatile = memoryStorage();
export function createDeliveryCommandStorage(): StorageDriver {
  if (Platform.OS === "web") return volatile;
  if (supportsDurableDrafts()) return encrypted;
  // Older Android binaries cannot promise a durable barrier; do not send a step
  // after a merely queued disk write or overwrite a protected pending intent.
  const unsupported = async (): Promise<never> => { throw new Error("Update the application to protect delivery commands"); };
  return { getItem: unsupported, setItem: unsupported, removeItem: unsupported };
}
