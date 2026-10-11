import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
import type { NativePhone, VoiceEvent } from "./phone";

type Bridge = NativePhone & { isAvailable(): boolean; addListener(name: string, callback: (event: VoiceEvent) => void): { remove(): void } };

/** Expo Go/Android return null. No native SDK is imported into Expo Go. */
export function nativePhone(): NativePhone | null {
  if (Platform.OS !== "ios") return null;
  const module = requireOptionalNativeModule<Bridge>("LinkaVoice");
  if (!module?.isAvailable()) return null;
  return {
    snapshot: () => module.snapshot(), requestMicrophone: () => module.requestMicrophone(),
    connect: token => module.connect(token), disconnect: () => module.disconnect(),
    authorize: (callId, sessionId) => module.authorize(callId, sessionId), reject: callId => module.reject(callId),
    expectOutgoing: (controlId, sessionId, number) => module.expectOutgoing(controlId, sessionId, number),
    answer: callId => module.answer(callId), end: () => module.end(), mute: muted => module.mute(muted),
    speaker: enabled => module.speaker(enabled), dtmf: digits => module.dtmf(digits),
    subscribe: callback => { const subscription = module.addListener("onVoiceEvent", callback); return () => subscription.remove(); },
  };
}
