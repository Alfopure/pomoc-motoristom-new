/// <reference types="node" />
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExportedConfig } from "expo/config-plugins";

const require = createRequire(import.meta.url);
const { compileModsAsync } = require("expo/config-plugins") as typeof import("expo/config-plugins");
// What `expo prebuild` resolves, including the plugins Expo adds for installed packages.
const { getPrebuildConfigAsync } = createRequire(require.resolve("expo/package.json"))("@expo/prebuild-config") as {
  getPrebuildConfigAsync: (projectRoot: string, options: { platforms: string[] }) => Promise<{ exp: ExportedConfig }>;
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

function sceneLifecycle(plist: Record<string, unknown> | undefined) {
  expect(plist?.UIApplicationSceneManifest).toMatchObject({
    UIApplicationSupportsMultipleScenes: false,
    UISceneConfigurations: {
      UIWindowSceneSessionRoleApplication: [{ UISceneDelegateClassName: "EXExpoAppSceneDelegate" }],
    },
  });
}

describe("the iOS app as App Store Connect receives it", () => {
  it("starts React Native from Expo's scene delegate and retains app-wide launch subscribers", async () => {
    vi.stubEnv("APP_VARIANT", "test"); vi.stubEnv("EXPO_PUBLIC_APP_ENV", "test");
    vi.stubEnv("EXPO_PUBLIC_VOICE_PROOF", "1"); vi.stubEnv("MOBILE_EXPO_GO_PREVIEW", "0");
    delete require.cache[appConfig];
    const { exp } = await getPrebuildConfigAsync(projectRoot, { platforms: ["ios"] });
    const template = join(dirname(require.resolve("expo/package.json")), "template.tgz");
    const contents = execFileSync("tar", ["-xOf", template, "package/ios/HelloWorld/AppDelegate.swift"], { encoding: "utf8" });
    const appDelegateMod = exp.mods?.ios?.appDelegate;
    expect(appDelegateMod).toBeTypeOf("function");
    const result = await appDelegateMod!({ ...exp, modResults: { path: join(projectRoot, "ios/AppDelegate.swift"), language: "swift", contents }, modRawConfig: exp,
      modRequest: { projectRoot, platformProjectRoot: join(projectRoot, "ios"), platform: "ios", modName: "appDelegate", introspect: false } });
    const generated = result.modResults.contents;
    expect(generated).toContain("class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider");
    expect(generated).toContain("reactNativeFactory = factory");
    expect(generated).not.toContain("UIWindow(frame:");
    expect(generated).not.toContain("factory.startReactNative(");
    expect(generated).toContain("return super.application(application, didFinishLaunchingWithOptions: launchOptions)");
  }, 30_000);

  it("TestFlight TEST build: calls, the delivery location and push, no unused background mode", async () => {
    const ios = await resolvedIos("test", true);
    expect(ios.bundleIdentifier).toBe("sk.linkapomoci.dispecing.test");
    expect([...ios.infoPlist?.UIBackgroundModes ?? []].sort()).toEqual(["audio", "location", "voip"]);
    // The TEST app's App Store provisioning profile carries production push.
    expect(ios.entitlements).toEqual({ "aps-environment": "production" });
    expect(ios.infoPlist).toMatchObject({ CFBundleDisplayName: "Dispatching TEST", ITSAppUsesNonExemptEncryption: false });
    purposeTexts(ios.infoPlist);
    sceneLifecycle(ios.infoPlist);
  }, 30_000);

  it.each(["test", "production"] as const)("%s build without calls keeps only the delivery location in the background", async variant => {
    const ios = await resolvedIos(variant, false);
    expect(ios.infoPlist?.UIBackgroundModes).toEqual(["location"]);
    expect(ios.infoPlist).not.toHaveProperty("LinkaNativeVoiceEnabled");
    purposeTexts(ios.infoPlist);
    sceneLifecycle(ios.infoPlist);
  }, 30_000);
});
