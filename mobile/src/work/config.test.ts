import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
describe("photo config preserves the native voice and OTA boundary", () => {
  // The calling module (Telnyx, WebRTC) is linked into every iOS binary, so App Store Connect
  // wants the microphone text in each one; only the voice build turns calling on.
  it.each([false, true])("keeps the microphone text in every binary and calling only in the voice build (%s)", async voice => {
    vi.stubEnv("APP_VARIANT", "test"); vi.stubEnv("EXPO_PUBLIC_APP_ENV", "test"); vi.stubEnv("EXPO_PUBLIC_VOICE_PROOF", voice ? "1" : "0"); vi.stubEnv("MOBILE_EXPO_GO_PREVIEW", "0");
    vi.resetModules(); const config = (await import("../../app.config")).default;
    const picker = config.plugins?.find(value => Array.isArray(value) && value[0] === "expo-image-picker") as [string, Record<string, unknown>];
    expect(picker[1].microphonePermission).toBe("Aplikácia potrebuje mikrofón na telefonovanie.");
    expect(config.ios?.infoPlist?.NSMicrophoneUsageDescription).toBe("Aplikácia potrebuje mikrofón na telefonovanie.");
    expect(config.ios?.infoPlist?.LinkaNativeVoiceEnabled).toBe(voice ? true : undefined);
    expect(picker[1].cameraPermission).toContain("prípadu"); expect(config.android?.blockedPermissions).not.toContain("android.permission.CAMERA");
    expect(config.updates).toEqual({ enabled: false });
    if (voice) expect(config.ios?.infoPlist?.UIBackgroundModes).toEqual(["audio", "voip"]);
    else expect(config.ios?.infoPlist?.UIBackgroundModes).toBeUndefined();
  });
  it("declares no tracking, only exempt encryption and a separate TEST icon", async () => {
    vi.stubEnv("APP_VARIANT", "test"); vi.stubEnv("EXPO_PUBLIC_APP_ENV", "test");
    vi.resetModules(); const config = (await import("../../app.config")).default;
    expect(config.name).toBe("Dispatching TEST"); expect(config.icon).toBe("./assets/icon-test.png");
    expect(config.ios?.infoPlist?.ITSAppUsesNonExemptEncryption).toBe(false);
    const manifest = config.ios?.privacyManifests;
    expect(manifest?.NSPrivacyTracking).toBe(false);
    expect(manifest?.NSPrivacyCollectedDataTypes?.every(item => item.NSPrivacyCollectedDataTypeTracking === false && item.NSPrivacyCollectedDataTypeLinked === true)).toBe(true);
    expect(manifest?.NSPrivacyAccessedAPITypes?.map(item => item.NSPrivacyAccessedAPIType)).toEqual(["NSPrivacyAccessedAPICategoryUserDefaults",
      "NSPrivacyAccessedAPICategoryFileTimestamp", "NSPrivacyAccessedAPICategorySystemBootTime", "NSPrivacyAccessedAPICategoryDiskSpace"]);
  });
});
