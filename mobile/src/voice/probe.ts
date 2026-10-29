import { Platform } from "react-native";
import { nativePhone } from "./native";

let unreported: Error | null = null;

/** Import/bridge proof only: no client, credentials, socket or provider call.
 * A strict (TEST) proof fails at boot; otherwise the failure is kept for the
 * error report and the app runs with native calling unavailable. */
export function probeNativeVoiceBindings(strict = true): boolean {
  try {
    if (Platform.OS !== "ios") throw new Error("This voice pilot requires an iPhone build");
    if (!nativePhone()) throw new Error("Native CallKit phone is unavailable");
    return true;
  } catch (error) {
    if (strict) throw error;
    unreported = error instanceof Error ? error : new Error(String(error));
    return false;
  }
}

/** The kept probe failure, once, for the signed-in operator's error report. */
export function takeNativeVoiceProbeFailure(): Error | null {
  const failure = unreported;
  unreported = null;
  return failure;
}
