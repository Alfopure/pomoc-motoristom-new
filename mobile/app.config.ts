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

// Data the app sends to the dispatch service, all for running dispatch work and
// linked to the signed-in operator; nothing is used for tracking or advertising.
const collected = ["Name", "EmailAddress", "PhoneNumber", "PhysicalAddress", "PreciseLocation", "PhotosorVideos", "AudioData",
  "OtherUserContent", "CrashData", "UserID", "DeviceID"].map(kind => ({
  NSPrivacyCollectedDataType: "NSPrivacyCollectedDataType" + kind, NSPrivacyCollectedDataTypeLinked: true,
  NSPrivacyCollectedDataTypeTracking: false, NSPrivacyCollectedDataTypePurposes: ["NSPrivacyCollectedDataTypePurposeAppFunctionality"],
}));
// Reasons React Native and Expo modules read these APIs (see Apple "required reason APIs").
const accessed = [["UserDefaults", "CA92.1"], ["FileTimestamp", "C617.1"], ["SystemBootTime", "35F9.1"], ["DiskSpace", "E174.1"]].map(([kind, reason]) => ({
  NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategory" + kind, NSPrivacyAccessedAPITypeReasons: [reason],
}));

const config: ExpoConfig = {
  name: "Dispatching" + (variant === "production" ? "" : variant === "test" ? " TEST" : " DEV"),
  slug: "linka-pomoci-dispecing",
  owner: "linkapomoci",
  version: "0.1.0",
  icon: variant === "production" ? "./assets/icon.png" : "./assets/icon-" + variant + ".png",
  orientation: "portrait",
  userInterfaceStyle: "light",
  scheme: "linkapomoci" + (suffix ? "-" + variant : ""),
  ios: {
    bundleIdentifier: "sk.linkapomoci.dispecing" + suffix, supportsTablet: false,
    privacyManifests: { NSPrivacyTracking: false, NSPrivacyTrackingDomains: [], NSPrivacyCollectedDataTypes: collected, NSPrivacyAccessedAPITypes: accessed },
    // Only HTTPS and standard WebRTC call encryption (DTLS-SRTP in the Telnyx library) are used.
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      ...(voiceProof ? {
        LinkaNativeVoiceEnabled: true,
        UIBackgroundModes: ["audio", "voip"],
        NSMicrophoneUsageDescription: "Aplikácia potrebuje mikrofón na telefonovanie.",
      } : {}),
    },
    ...(voiceProof ? { entitlements: { "aps-environment": "production" } } : {}),
  },
  android: { package: "sk.linkapomoci.dispecing" + suffix, blockedPermissions: ["android.permission.SYSTEM_ALERT_WINDOW", "android.permission.READ_EXTERNAL_STORAGE", "android.permission.WRITE_EXTERNAL_STORAGE",
    "android.permission.ACCESS_BACKGROUND_LOCATION", "android.permission.FOREGROUND_SERVICE_LOCATION", "android.permission.ACTIVITY_RECOGNITION", "com.google.android.gms.permission.ACTIVITY_RECOGNITION"] },
  // Work notices (tasks, cases, overdue callbacks) through the Expo push service; the
  // voice build keeps its own production APNs entitlement, which the plugin respects.
  // No Face ID text: the app never asks for biometrics. Background fetch is unused.
  plugins: [["expo-secure-store", { faceIDPermission: false }], "./plugins/with-no-background-fetch.cjs", ["expo-splash-screen", { image: "./assets/splash-icon.png", imageWidth: 180, resizeMode: "contain", backgroundColor: "#F2F2F7" }],
    ["expo-notifications", { defaultChannel: "default" }],
    "./plugins/with-draft-secure-store.cjs", ...(voiceProof ? ["./plugins/with-telnyx-reconnect-guard.cjs"] : []), ["expo-image-picker", {
    photosPermission: "Aplikácia potrebuje prístup k vybranej fotografii na priloženie k prípadu.",
    cameraPermission: "Aplikácia potrebuje fotoaparát na odfotografovanie prílohy prípadu.",
    microphonePermission: voiceProof ? "Aplikácia potrebuje mikrofón na telefonovanie." : false,
  }], ["expo-location", {
    locationWhenInUsePermission: "Aplikácia použije polohu telefónu na váš pokyn pri výbere miesta zásahu a počas pristavenia, ktoré ste prijali, aby dispečer videl, kde ste.",
    locationAlwaysPermission: false,
    // A pristavovač's position goes on with the app in the background or closed, only while
    // their accepted delivery is open; iOS shows the blue location indicator meanwhile.
    locationAlwaysAndWhenInUsePermission: "Počas pristavenia, ktoré ste prijali, posiela aplikácia dispečingu vašu polohu aj na pozadí a pri zamknutom telefóne, aby dispečer videl, kde ste. Po skončení pristavenia prestane.",
    motionUsagePermission: false,
    isIosBackgroundLocationEnabled: true,
    isAndroidBackgroundLocationEnabled: false,
    isAndroidForegroundServiceEnabled: false,
    isAndroidMotionActivityEnabled: false,
  }]],
  // Only the explicit Expo Go TEST preview is published. Native binaries do
  // not fetch OTA updates, and production cannot select this preview mode.
  updates: expoGoPreview ? { url: "https://u.expo.dev/" + projectId, checkAutomatically: "NEVER" } : { enabled: false },
  ...(expoGoPreview ? { runtimeVersion: { policy: "appVersion" as const } } : {}),
  extra: { appVariant: variant, environment, eas: { projectId } },
};
export default config;
