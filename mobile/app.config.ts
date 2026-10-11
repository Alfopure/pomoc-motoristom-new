import type { ExpoConfig } from "expo/config";

const variant = process.env.APP_VARIANT ?? "development";
if (!["development", "test", "production"].includes(variant)) throw new Error("Invalid APP_VARIANT");
const environment = process.env.EXPO_PUBLIC_APP_ENV ?? "test";
if (environment !== (variant === "production" ? "production" : "test")) throw new Error("App variant/environment mismatch");
const suffix = variant === "production" ? "" : variant === "test" ? ".test" : ".dev";
const projectId = process.env.EAS_PROJECT_ID?.trim();
if (projectId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) throw new Error("Invalid EAS_PROJECT_ID");

const config: ExpoConfig = {
  name: "Linka pomoci" + (variant === "production" ? "" : variant === "test" ? " TEST" : " DEV"),
  slug: "linka-pomoci-dispecing",
  version: "0.1.0",
  orientation: "portrait",
  userInterfaceStyle: "light",
  scheme: "linkapomoci" + (suffix ? "-" + variant : ""),
  ios: { bundleIdentifier: "sk.linkapomoci.dispecing" + suffix, supportsTablet: false },
  android: { package: "sk.linkapomoci.dispecing" + suffix, blockedPermissions: ["android.permission.SYSTEM_ALERT_WINDOW", "android.permission.READ_EXTERNAL_STORAGE", "android.permission.WRITE_EXTERNAL_STORAGE"] },
  plugins: ["expo-secure-store"],
  extra: { appVariant: variant, environment, ...(projectId ? { eas: { projectId } } : {}) },
};
export default config;
