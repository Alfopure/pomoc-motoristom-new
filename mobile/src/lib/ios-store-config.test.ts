/// <reference types="node" />
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExpoConfig } from "expo/config";

const require = createRequire(import.meta.url);
const { compileModsAsync } = require("expo/config-plugins") as typeof import("expo/config-plugins");
// What `expo prebuild` resolves, including the plugins Expo adds for installed packages.
const { getPrebuildConfigAsync } = createRequire(require.resolve("expo/package.json"))("@expo/prebuild-config") as {
  getPrebuildConfigAsync: (projectRoot: string, options: { platforms: string[] }) => Promise<{ exp: ExpoConfig }>;
};
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const appConfig = fileURLToPath(new URL("../../app.config.ts", import.meta.url));

afterEach(() => { vi.unstubAllEnvs(); });

async function resolvedIos(variant: "test" | "production", voice: boolean) {
  vi.stubEnv("APP_VARIANT", variant); vi.stubEnv("EXPO_PUBLIC_APP_ENV", variant);
  vi.stubEnv("EXPO_PUBLIC_VOICE_PROOF", voice ? "1" : "0"); vi.stubEnv("MOBILE_EXPO_GO_PREVIEW", "0");
  // Expo keeps the evaluated config in the module cache; read it again for these variables.
  delete require.cache[appConfig];
  const { exp } = await getPrebuildConfigAsync(projectRoot, { platforms: ["ios"] });
  const resolved = await compileModsAsync(exp, { projectRoot, platforms: ["ios"], introspect: true, ignoreExistingNativeFiles: true, assertMissingModProviders: false });
  return resolved.ios ?? {};
}

// App Store Connect rejects a binary whose linked code can reach these without a text
// (ITMS-90683), even when the app never asks; the first TestFlight upload failed on motion.
function purposeTexts(plist: Record<string, unknown> | undefined) {
  for (const key of ["NSCameraUsageDescription", "NSPhotoLibraryUsageDescription", "NSMicrophoneUsageDescription", "NSMotionUsageDescription", "NSFaceIDUsageDescription",
    "NSLocationWhenInUseUsageDescription", "NSLocationAlwaysAndWhenInUseUsageDescription"]) expect(plist?.[key], key).toMatch(/^Aplikácia|^Počas/);
}

describe("the iOS app as App Store Connect receives it", () => {
  it("TestFlight TEST build: calls, the delivery location and push, no unused background mode", async () => {
    const ios = await resolvedIos("test", true);
    expect(ios.bundleIdentifier).toBe("sk.linkapomoci.dispecing.test");
    expect([...ios.infoPlist?.UIBackgroundModes ?? []].sort()).toEqual(["audio", "location", "voip"]);
    // The TEST app's App Store provisioning profile carries production push.
    expect(ios.entitlements).toEqual({ "aps-environment": "production" });
    expect(ios.infoPlist).toMatchObject({ CFBundleDisplayName: "Dispatching TEST", ITSAppUsesNonExemptEncryption: false });
    purposeTexts(ios.infoPlist);
  }, 30_000);

  it.each(["test", "production"] as const)("%s build without calls keeps only the delivery location in the background", async variant => {
    const ios = await resolvedIos(variant, false);
    expect(ios.infoPlist?.UIBackgroundModes).toEqual(["location"]);
    expect(ios.infoPlist).not.toHaveProperty("LinkaNativeVoiceEnabled");
    purposeTexts(ios.infoPlist);
  }, 30_000);
});
