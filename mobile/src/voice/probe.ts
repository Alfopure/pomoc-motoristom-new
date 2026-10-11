import { NativeModules, Platform } from "react-native";

/** Import/bridge proof only: no client, credentials, socket or provider call. */
export function probeNativeVoiceBindings(): void {
  if (Platform.OS !== "ios" && Platform.OS !== "android") throw new Error("Native voice requires a native build");
  if (!NativeModules.WebRTCModule) throw new Error("WebRTC native module is unavailable");
  // Keep these imports lazy: the M1 Expo Go preview has no WebRTC module.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sdk = require("@telnyx/react-native-voice-sdk") as { TelnyxRTC?: unknown };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const media = require("react-native-webrtc") as { RTCPeerConnection?: unknown };
  if (typeof sdk.TelnyxRTC !== "function" || typeof media.RTCPeerConnection !== "function") {
    throw new Error("Native voice engine is unavailable");
  }
}
