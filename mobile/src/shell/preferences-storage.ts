import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { memoryStorage, type StorageDriver } from "../lib/session-storage";

const volatile = memoryStorage();

/** A separate Keychain/Keystore service; the browser preview keeps the bar in memory. */
export function createShellPreferencesStorage(): StorageDriver {
  if (Platform.OS === "web") return volatile;
  const options = { keychainService: "pm-dispatch-shell-v1", keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
  return {
    getItem: key => SecureStore.getItemAsync(key, options),
    setItem: (key, value) => SecureStore.setItemAsync(key, value, options),
    removeItem: key => SecureStore.deleteItemAsync(key, options),
  };
}
