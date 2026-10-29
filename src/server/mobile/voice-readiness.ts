import type { MobileVoiceReadiness } from "@/lib/mobile-api";
import {
  canOperateTelephony,
  nativePushEnabled,
  nativeVoiceEnabled,
  type AppEnvironmentVariables,
} from "@/lib/app-environment";

/** Pure configuration observation; never constructs provider or device dependencies. */
export function getNativeVoiceReadiness(
  env: AppEnvironmentVariables = process.env,
): Pick<MobileVoiceReadiness, "nativeCallingEnabled" | "backgroundIncomingEnabled"> {
  // Each flag already requires the exact dedicated TEST or production deployment.
  const nativeCallingEnabled = canOperateTelephony(env) && nativeVoiceEnabled(env);
  return {
    nativeCallingEnabled,
    backgroundIncomingEnabled: nativeCallingEnabled && nativePushEnabled(env),
  };
}
