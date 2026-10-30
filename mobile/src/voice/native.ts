import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
import { sanitizeDiagnostic } from "./diagnostics";
import type { NativePhone, VoiceEvent } from "./phone";

type Bridge = Omit<NativePhone, "debug"> & { isAvailable(): boolean; addListener(name: string, callback: (event: VoiceEvent) => void): { remove(): void };
  debug?(event: string, fields: Record<string, string>): void };

/** Expo Go/Android return null. No native SDK is imported into Expo Go. */
export function nativePhone(): NativePhone | null {
  if (Platform.OS !== "ios") return null;
  const module = requireOptionalNativeModule<Bridge>("LinkaVoice");
  if (!module?.isAvailable()) return null;
  return {
    snapshot: () => module.snapshot(), clearPushRejection: id => module.clearPushRejection(id), requestMicrophone: () => module.requestMicrophone(),
    connect: token => module.connect(token), disconnect: reason => module.disconnect(reason),
    authorize: (callId, sessionId, controlId) => module.authorize(callId, sessionId, controlId), reject: callId => module.reject(callId),
    expectOutgoing: (controlId, sessionId, number, genericHandle = false) => module.expectOutgoing(controlId, sessionId, number, genericHandle),
    answer: callId => module.answer(callId), confirmConnected: callId => module.confirmConnected(callId), end: () => module.end(), mute: muted => module.mute(muted),
    speaker: enabled => module.speaker(enabled), dtmf: digits => module.dtmf(digits),
    requestHold: (callId, held) => module.requestHold(callId, held), claimHold: (callId, actionId) => module.claimHold(callId, actionId),
    syncMedia: (callId, sessionId, controlId, state, version, canHold) => module.syncMedia(callId, sessionId, controlId, state, version, canHold),
    resolveHold: (callId, sessionId, controlId, actionId, outcome, state, version, canHold) => module.resolveHold(callId, sessionId, controlId, actionId, outcome, state, version, canHold),
    // Only sanitized codes cross the bridge; a device log never affects calling.
    debug: (event, fields) => {
      try { const line = sanitizeDiagnostic(event, fields); if (line && typeof module.debug === "function") module.debug(line.event, line.fields); } catch { /* ignored */ }
    },
    ...(typeof module.diagnosticEvents === "function" && typeof module.clearDiagnosticEvents === "function" ? {
      diagnosticEvents: () => module.diagnosticEvents!(), clearDiagnosticEvents: (upToId: number) => module.clearDiagnosticEvents!(upToId),
    } : {}),
    subscribe: callback => { const subscription = module.addListener("onVoiceEvent", callback); return () => subscription.remove(); },
  };
}
