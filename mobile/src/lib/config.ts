import type { MobileEnvironment } from "../../../src/lib/mobile-api";

export type MobileConfig = {
  environment: MobileEnvironment;
  apiOrigin: string;
  supabaseUrl: string;
  publishableKey: string;
};
export type PublicMobileEnv = {
  environment?: string;
  apiUrl?: string;
  supabaseUrl?: string;
  publishableKey?: string;
};

const targets = {
  test: { origin: "https://test.dispecing.linkapomoci.sk", ref: "nzpnqdstvkfncflgqlny" },
  production: { origin: "https://dispecing.linkapomoci.sk", ref: "ifpaeegaesdmljfkdvcn" },
} as const;

/** Fail closed: no environment picker, URL override or production fallback. */
export function parseMobileConfig(env: PublicMobileEnv): MobileConfig {
  if (env.environment !== "test" && env.environment !== "production") throw new Error("Missing app environment");
  const target = targets[env.environment];
  const api = new URL(env.apiUrl ?? "");
  const supabase = new URL(env.supabaseUrl ?? "");
  if (api.href !== target.origin + "/" || supabase.href !== "https://" + target.ref + ".supabase.co/") throw new Error("Mobile environment mismatch");
  const key = env.publishableKey?.trim() ?? "";
  if (!key || key.startsWith("sb_secret_")) throw new Error("Missing public key");
  if (!key.startsWith("sb_publishable_")) {
    try {
      const claims = JSON.parse(atob(key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      if (claims.role !== "anon" || claims.ref !== target.ref) throw new Error();
    } catch { throw new Error("Only a publishable or matching legacy anon key is allowed"); }
  }
  return { environment: env.environment, apiOrigin: api.origin, supabaseUrl: supabase.origin, publishableKey: key };
}

export function readMobileConfig(): MobileConfig {
  // Expo substitutes only direct EXPO_PUBLIC_* references in client bundles.
  return parseMobileConfig({
    environment: process.env.EXPO_PUBLIC_APP_ENV,
    apiUrl: process.env.EXPO_PUBLIC_API_URL,
    supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
    publishableKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
}
