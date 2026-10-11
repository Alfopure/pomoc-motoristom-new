import type { ExpoConfig } from "expo/config";

const variant = process.env.APP_VARIANT ?? "development";
if (!["development", "test", "production"].includes(variant)) throw new Error("Invalid APP_VARIANT");
const environment = process.env.EXPO_PUBLIC_APP_ENV ?? "test";
if (environment !== (variant === "production" ? "production" : "test")) throw new Error("App variant/environment mismatch");
const suffix = variant === "production" ? "" : variant === "test" ? ".test" : ".dev";
const projectId = "c7363382-9b12-4e12-9f62-31ec7b8c5623";
const configuredProjectId = process.env.EAS_PROJECT_ID?.trim();
if (configuredProjectId && configuredProjectId !== projectId) throw new Error("EAS_PROJECT_ID must match the dispatch Expo project");

const config: ExpoConfig = {
  name: "Linka pomoci" + (variant === "production" ? "" : variant === "test" ? " TEST" : " DEV"),
  slug: "linka-pomoci-dispecing",
  owner: "linkapomoci",
  version: "0.1.0",
  orientation: "portrait",
  userInterfaceStyle: "light",
  scheme: "linkapomoci" + (suffix ? "-" + variant : ""),
  ios: { bundleIdentifier: "sk.linkapomoci.dispecing" + suffix, supportsTablet: false },
  android: { package: "sk.linkapomoci.dispecing" + suffix, blockedPermissions: ["android.permission.SYSTEM_ALERT_WINDOW", "android.permission.READ_EXTERNAL_STORAGE", "android.permission.WRITE_EXTERNAL_STORAGE"] },
  plugins: ["expo-secure-store"],
  extra: { appVariant: variant, environment, eas: { projectId } },
};
export default config;
