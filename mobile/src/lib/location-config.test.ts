/// <reference types="node" />
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConfigPlugin } from "expo/config-plugins";

const require = createRequire(import.meta.url);
const locationPlugin = (require("expo-location/app.plugin.js") as { default: ConfigPlugin<Record<string, unknown>> }).default;
const { AndroidConfig, compileModsAsync } = require("expo/config-plugins") as typeof import("expo/config-plugins");
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const forbiddenPermissions = ["android.permission.ACCESS_BACKGROUND_LOCATION", "android.permission.FOREGROUND_SERVICE_LOCATION",
  "android.permission.ACTIVITY_RECOGNITION", "com.google.android.gms.permission.ACTIVITY_RECOGNITION"];

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe("resolved location permissions: foreground, and background only for a pristavovač's delivery", () => {
  it.each([
    { voice: false, go: false }, { voice: true, go: false }, { voice: false, go: true },
  ])("allows iOS background location for deliveries, keeps Android foreground-only and preserves voice/OTA ($voice, $go)", async ({ voice, go }) => {
    vi.stubEnv("APP_VARIANT", "test"); vi.stubEnv("EXPO_PUBLIC_APP_ENV", "test");
    vi.stubEnv("EXPO_PUBLIC_VOICE_PROOF", voice ? "1" : "0"); vi.stubEnv("MOBILE_EXPO_GO_PREVIEW", go ? "1" : "0");
    const config = (await import("../../app.config")).default;
    const entry = config.plugins?.find(value => Array.isArray(value) && value[0] === "expo-location");
    if (!Array.isArray(entry)) throw new Error("Missing location plugin");
    const configured = locationPlugin(structuredClone(config), entry[1]);
    const blocked = config.android?.blockedPermissions;
    if (!blocked) throw new Error("Missing explicit Android location restrictions");
    const resolved = await compileModsAsync(AndroidConfig.Permissions.withBlockedPermissions(configured, blocked), {
      projectRoot, platforms: ["ios", "android"], introspect: true, ignoreExistingNativeFiles: true,
    });
    const plist = resolved.ios?.infoPlist;
    expect(plist?.NSLocationWhenInUseUsageDescription).toContain("na váš pokyn");
    expect(plist?.NSLocationWhenInUseUsageDescription).toContain("počas pristavenia");
    // Always only for the work the field member accepted, with the reason in plain words.
    expect(plist?.NSLocationAlwaysAndWhenInUseUsageDescription).toContain("Počas pristavenia, jazdy, odvozu či presunu, ktoré ste prijali");
    expect(plist?.NSLocationAlwaysAndWhenInUseUsageDescription).toContain("Po skončení práce prestane");
    expect(plist).not.toHaveProperty("NSLocationAlwaysUsageDescription");
    // Required by App Store Connect for the linked Core Motion code; the app never asks.
    expect(plist?.NSMotionUsageDescription).toBe("Aplikácia údaje o pohybe telefónu nepoužíva a o prístup k nim nežiada.");
    expect([...plist?.UIBackgroundModes ?? []].sort()).toEqual(voice ? ["audio", "location", "voip"] : ["location"]);
    expect(plist?.LinkaNativeVoiceEnabled).toBe(voice ? true : undefined);
    const manifest = resolved._internal?.modResults?.android?.manifest as import("expo/config-plugins").AndroidConfig.Manifest.AndroidManifest;
    const permissions = manifest.manifest["uses-permission"] ?? [];
    const requested = permissions.filter(value => value.$["tools:node"] !== "remove").map(value => value.$["android:name"]);
    expect(requested).toEqual(expect.arrayContaining(["android.permission.ACCESS_COARSE_LOCATION", "android.permission.ACCESS_FINE_LOCATION"]));
    for (const permission of forbiddenPermissions) {
      expect(requested).not.toContain(permission);
      expect(permissions).toContainEqual(expect.objectContaining({ $: expect.objectContaining({ "android:name": permission, "tools:node": "remove" }) }));
    }
    expect(requested).not.toContain("android.permission.FOREGROUND_SERVICE");
    expect(resolved.updates).toEqual(go ? { url: "https://u.expo.dev/c7363382-9b12-4e12-9f62-31ec7b8c5623", checkAutomatically: "NEVER" } : { enabled: false });
  });
});
