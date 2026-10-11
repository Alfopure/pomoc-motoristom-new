import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
describe("photo config preserves the native voice and OTA boundary", () => {
  it.each([false, true])("retains microphone only in the existing voice proof binary (%s)", async voice => {
    vi.stubEnv("APP_VARIANT", "test"); vi.stubEnv("EXPO_PUBLIC_APP_ENV", "test"); vi.stubEnv("EXPO_PUBLIC_VOICE_PROOF", voice ? "1" : "0"); vi.stubEnv("MOBILE_EXPO_GO_PREVIEW", "0");
    vi.resetModules(); const config = (await import("../../app.config")).default;
    const picker = config.plugins?.find(value => Array.isArray(value) && value[0] === "expo-image-picker") as [string, Record<string, unknown>];
    expect(picker[1].microphonePermission).toBe(voice ? "Linka pomoci potrebuje mikrofón na telefonovanie." : false);
    expect(picker[1].cameraPermission).toContain("prípadu"); expect(config.android?.blockedPermissions).not.toContain("android.permission.CAMERA");
    expect(config.updates).toEqual({ enabled: false });
    if (voice) { expect(config.ios?.infoPlist?.UIBackgroundModes).toEqual(["audio", "voip"]); expect(config.ios?.infoPlist?.NSMicrophoneUsageDescription).toContain("telefonovanie"); }
  });
});
