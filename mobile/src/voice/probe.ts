import { Platform } from "react-native";
import { nativePhone } from "./native";

/** Import/bridge proof only: no client, credentials, socket or provider call. */
export function probeNativeVoiceBindings(): void {
  if (Platform.OS === "ios") {
    if (!nativePhone()) throw new Error("Native CallKit phone is unavailable");
    return;
  }
  throw new Error("This voice pilot requires an iPhone build");
}
