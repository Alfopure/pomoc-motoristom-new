import type { MobileVoiceReadiness } from "@/lib/mobile-api";
import {
  canOperateTelephony,
  isTestLiveDeployment,
  nativePushTestEnabled,
  nativeVoiceTestEnabled,
  type AppEnvironmentVariables,
} from "@/lib/app-environment";

/** Pure configuration observation; never constructs provider or device dependencies. */
export function getNativeVoiceReadiness(
  env: AppEnvironmentVariables = process.env,
): Pick<MobileVoiceReadiness, "nativeCallingEnabled" | "backgroundIncomingEnabled"> {
  const nativeCallingEnabled = isTestLiveDeployment(env) && canOperateTelephony(env) && nativeVoiceTestEnabled(env);
  return {
    nativeCallingEnabled,
    backgroundIncomingEnabled: nativeCallingEnabled && nativePushTestEnabled(env),
  };
}
