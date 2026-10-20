import * as Application from "expo-application";
import Constants, { ExecutionEnvironment } from "expo-constants";

/** The installed app: the binary's own version and build, or the project version in Expo Go. */
export type AppVersion = { version: string; build: string | null; preview: boolean };
export function appVersion(): AppVersion {
  const configured = Constants.expoConfig?.version ?? "0.0.0";
  const preview = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
  if (preview) return { version: configured, build: null, preview };
  return { version: Application.nativeApplicationVersion ?? configured, build: Application.nativeBuildVersion ?? null, preview };
}
export function versionLabel(value: AppVersion): string {
  return value.version + (value.build ? " (" + value.build + ")" : "") + (value.preview ? " · náhľad v Expo Go" : "");
}
/** Dotted numeric comparison; anything unparsable counts as supported, so a typo never locks dispatchers out. */
export function olderThan(current: string, minimum: string): boolean {
  const parse = (value: string) => /^\d{1,4}(?:\.\d{1,4}){0,2}$/.test(value) ? value.split(".").map(Number) : null;
  const a = parse(current), b = parse(minimum);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index++) {
    const left = a[index] ?? 0, right = b[index] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}
