import { createClient } from "@supabase/supabase-js";
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { randomUUID } from "expo-crypto";
import type { MobileConfig } from "./config";
import { createSessionStorage, memoryStorage } from "./session-storage";

export function createMobileSupabase(config: MobileConfig) {
  const storage = Platform.OS === "web" ? memoryStorage() : createSessionStorage({
    getItem: key => SecureStore.getItemAsync(key),
    setItem: (key, value) => SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }),
    removeItem: key => SecureStore.deleteItemAsync(key),
  }, randomUUID);
  const storageKey = "pm-dispatch-" + config.environment + "-auth";
  const client = createClient(config.supabaseUrl, config.publishableKey, {
    auth: {
      storage, storageKey,
      autoRefreshToken: true, persistSession: true, detectSessionInUrl: false,
    },
  });
  return { client, clearStoredSession: () => storage.removeItem(storageKey) };
}
