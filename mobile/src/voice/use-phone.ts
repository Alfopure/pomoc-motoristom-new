import { useEffect, useMemo, useSyncExternalStore } from "react";
import { randomUUID } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MobileApiError } from "../lib/api";
import type { MobileConfig } from "../lib/config";
import { createVoiceApi } from "./api";
import { nativePhone } from "./native";
import { DispatchPhone, type PhoneState } from "./phone";

const idle: PhoneState = { supported: false, registration: "unregistered", takeoverRequired: false, call: null, termination: null,
  dialing: false, cancelingAttempt: false, audioActive: false, muted: false, speaker: false, error: null,
  microphonePermission: "unknown", pushRegistered: null, lastHeartbeatAt: null, heartbeatError: null, diagnosticsError: null, checkingDiagnostics: false, retryTarget: null };
const noSubscribe = () => () => {};
const idleSnapshot = () => idle;

export function useDispatchPhone(config: MobileConfig, client: SupabaseClient, userId: string, profileId: string | null, active: boolean) {
  const phone = useMemo(() => {
    if (!profileId) return null;
    const native = nativePhone();
    if (!native) return null;
    const api = createVoiceApi(config, profileId, async () => {
      const { data, error } = await client.auth.getSession();
      if (error || data.session?.user.id !== userId) throw new MobileApiError("Prihláste sa do aplikácie.", 401);
      return data.session.access_token;
    });
    const key = "pm-voice-" + config.environment + "-" + profileId;
    return new DispatchPhone(api, native, randomUUID, {
      load: () => SecureStore.getItemAsync(key),
      save: id => SecureStore.setItemAsync(key, id, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }),
      clear: () => SecureStore.deleteItemAsync(key),
    });
  }, [config, client, userId, profileId]);
  useEffect(() => {
    if (!phone) return;
    void phone.initialise().catch(() => {});
    return () => {
      // Auth/role changes stop the old native client before the next account
      // can connect. Device revocation also runs before explicit Auth logout.
      void phone.disconnect().catch(() => {});
      phone.dispose();
    };
  }, [phone]);
  useEffect(() => { phone?.setForeground(active); }, [phone, active]);
  const state = useSyncExternalStore(phone?.subscribe ?? noSubscribe, phone?.snapshot ?? idleSnapshot, idleSnapshot);
  return { phone, state };
}
