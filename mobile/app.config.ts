import type { ExpoConfig } from "expo/config";

const variant = process.env.APP_VARIANT ?? "development";
if (!["development", "test", "production"].includes(variant)) throw new Error("Invalid APP_VARIANT");
const environment = process.env.EXPO_PUBLIC_APP_ENV ?? "test";
if (environment !== (variant === "production" ? "production" : "test")) throw new Error("App variant/environment mismatch");
const suffix = variant === "production" ? "" : variant === "test" ? ".test" : ".dev";
const projectId = "c7363382-9b12-4e12-9f62-31ec7b8c5623";
const configuredProjectId = process.env.EAS_PROJECT_ID?.trim();
if (configuredProjectId && configuredProjectId !== projectId) throw new Error("EAS_PROJECT_ID must match the dispatch Expo project");
const expoGoPreview = process.env.MOBILE_EXPO_GO_PREVIEW === "1";
const voiceProof = process.env.EXPO_PUBLIC_VOICE_PROOF === "1";
if ((expoGoPreview || voiceProof) && variant !== "test") throw new Error("Mobile previews require the TEST variant");
if (expoGoPreview && voiceProof) throw new Error("Native voice proof cannot run in Expo Go");

const config: ExpoConfig = {
  name: "Linka pomoci" + (variant === "production" ? "" : variant === "test" ? " TEST" : " DEV"),
  slug: "linka-pomoci-dispecing",
  owner: "linkapomoci",
  version: "0.1.0",
  orientation: "portrait",
  userInterfaceStyle: "light",
  scheme: "linkapomoci" + (suffix ? "-" + variant : ""),
  ios: {
    bundleIdentifier: "sk.linkapomoci.dispecing" + suffix, supportsTablet: false,
    ...(voiceProof ? {
      entitlements: { "aps-environment": "production" },
      infoPlist: {
        LinkaNativeVoiceEnabled: true,
        UIBackgroundModes: ["audio", "voip"],
        NSMicrophoneUsageDescription: "Linka pomoci potrebuje mikrofón na telefonovanie.",
      },
    } : {}),
  },
  android: { package: "sk.linkapomoci.dispecing" + suffix, blockedPermissions: ["android.permission.SYSTEM_ALERT_WINDOW", "android.permission.READ_EXTERNAL_STORAGE", "android.permission.WRITE_EXTERNAL_STORAGE"] },
  plugins: ["expo-secure-store", "./plugins/with-draft-secure-store.cjs", ["expo-image-picker", {
    photosPermission: "Linka pomoci potrebuje prístup k vybranej fotografii na priloženie k prípadu.",
    cameraPermission: "Linka pomoci potrebuje fotoaparát na odfotografovanie prílohy prípadu.",
    microphonePermission: voiceProof ? "Linka pomoci potrebuje mikrofón na telefonovanie." : false,
  }]],
  // Only the explicit Expo Go TEST preview is published. Native binaries do
  // not fetch OTA updates, and production cannot select this preview mode.
  updates: expoGoPreview ? { url: "https://u.expo.dev/" + projectId, checkAutomatically: "NEVER" } : { enabled: false },
  ...(expoGoPreview ? { runtimeVersion: { policy: "appVersion" as const } } : {}),
  extra: { appVariant: variant, environment, eas: { projectId } },
};
export default config;
