import { useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { randomUUID } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MobileApiError } from "../lib/api";
import type { MobileConfig } from "../lib/config";
import { appVersion } from "../lib/app-version";
import { createVoiceApi } from "./api";
import { createDiagnosticsUploader, voiceDiagnosticsSender } from "./diagnostics-upload";
import { nativePhone } from "./native";
import { DispatchPhone, type PhoneState } from "./phone";
import { ErrorReporterContext } from "../ui/error-boundary";

const idle: PhoneState = { supported: false, registration: "unregistered", takeoverRequired: false, call: null, termination: null,
  dialing: false, cancelingAttempt: false, audioActive: false, muted: false, speaker: false, error: null,
  microphonePermission: "unknown", pushRegistered: null, lastHeartbeatAt: null, heartbeatError: null, diagnosticsError: null, checkingDiagnostics: false, retryTarget: null, holdPhase: "idle", nativeSyncPending: false, transferPending: null };
const noSubscribe = () => () => {};
const idleSnapshot = () => idle;

export function useDispatchPhone(config: MobileConfig, client: SupabaseClient, userId: string, profileId: string | null, active: boolean) {
  const reporter = useContext(ErrorReporterContext);
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
    }, error => reporter?.report("error", error, "voice-push"));
  }, [config, client, userId, profileId, reporter]);
  // Device log: whether a cleanup below is an unmount or a replaced phone, and
  // which input replaced it. Every cleanup turns native voice off.
  const lifecycle = useRef({ unmounting: false });
  useEffect(() => { const life = lifecycle.current; life.unmounting = false; return () => { life.unmounting = true; }; }, []);
  const inputs = useRef<unknown[] | null>(null);
  useEffect(() => {
    const previous = inputs.current, next = [config, client, userId, profileId, reporter]; inputs.current = next;
    if (previous) nativePhone()?.debug?.("phone.inputs", { config: previous[0] !== next[0], client: previous[1] !== next[1], user: previous[2] !== next[2],
      profile: previous[3] !== next[3], reporter: previous[4] !== next[4], has_profile: Boolean(profileId) });
  }, [config, client, userId, profileId, reporter]);
  useEffect(() => {
    if (!phone) return;
    const life = lifecycle.current;
    void phone.initialise().catch(() => {});
    return () => {
      // Auth/role changes stop the old native client before the next account
      // can connect. Device revocation also runs before explicit Auth logout.
      void phone.disconnect(life.unmounting ? "unmount" : "replaced").catch(() => {});
      phone.dispose();
    };
  }, [phone]);
  useEffect(() => { phone?.setForeground(active); }, [phone, active]);
  // The device-log ring reaches the server without a USB cable, for the signed-in operator only.
  const diagnostics = useMemo(() => {
    const native = phone && profileId ? nativePhone() : null;
    if (!profileId || !native?.diagnosticEvents || !native.clearDiagnosticEvents) return null;
    const key = "pm-voice-" + config.environment + "-" + profileId, ownerKey = "pm-voice-diagnostics-owner-" + config.environment;
    const token = async () => {
      const { data, error } = await client.auth.getSession();
      return !error && data.session?.user.id === userId ? data.session.access_token : null;
    };
    return { native, uploader: createDiagnosticsUploader({ events: native.diagnosticEvents, clear: native.clearDiagnosticEvents,
      send: voiceDiagnosticsSender(config, token, () => SecureStore.getItemAsync(key), appVersion().build),
      owner: { id: profileId, load: () => SecureStore.getItemAsync(ownerKey),
        save: id => SecureStore.setItemAsync(ownerKey, id, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }) } }) };
  }, [phone, config, client, userId, profileId]);
  useEffect(() => {
    if (!diagnostics) return;
    // A launch or sign-in also sends what a refused cold-launch push or an earlier session left.
    diagnostics.uploader.request();
    const off = diagnostics.native.subscribe(event => { if (event.type === "ended" || event.type === "pushRejected") diagnostics.uploader.request(); });
    return () => { off(); diagnostics.uploader.dispose(); };
  }, [diagnostics]);
  useEffect(() => { if (active) diagnostics?.uploader.request(); }, [diagnostics, active]);
  const state = useSyncExternalStore(phone?.subscribe ?? noSubscribe, phone?.snapshot ?? idleSnapshot, idleSnapshot);
  /** Before logout: this operator's pending device-log events go out if they can, then the ring is emptied. */
  const finishDiagnostics = diagnostics?.uploader.finish;
  return { phone, state, finishDiagnostics };
}
