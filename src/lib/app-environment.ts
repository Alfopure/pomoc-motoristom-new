/** Application data boundary; Vercel's target is not the application's environment. */
export type AppEnvironment = "production" | "test" | "development";
export type AppEnvironmentVariables = Record<string, string | undefined>;
export const PRODUCTION_SUPABASE_REF = "ifpaeegaesdmljfkdvcn";
export const TEST_SUPABASE_REF = "nzpnqdstvkfncflgqlny";
export const TEST_VERCEL_PROJECT_ID = "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk";
export const TEST_APP_ORIGIN = "https://test.dispecing.linkapomoci.sk";
export const PRODUCTION_VERCEL_PROJECT_ID = "prj_DN3smSO1EbGowAmw3nHLQUYoSVJG";
export const PRODUCTION_APP_ORIGIN = "https://dispecing.linkapomoci.sk";

export function resolveAppEnvironment(env: AppEnvironmentVariables = process.env): AppEnvironment {
  const explicit = env.MOTORIST_APP_ENV?.trim();
  if (explicit) {
    if (explicit === "production" || explicit === "test" || explicit === "development") return explicit;
    throw new Error("Invalid MOTORIST_APP_ENV");
  }
  if (env.VERCEL_ENV === "production") return "production";
  if (env.VERCEL_ENV === "preview") return "test";
  return "development";
}

/** Checks configured identifiers without including credentials in errors. */
export function assertAppEnvironment(env: AppEnvironmentVariables = process.env): void {
  const app = resolveAppEnvironment(env);
  const expected = app === "production" ? PRODUCTION_SUPABASE_REF : TEST_SUPABASE_REF;
  const strict = Boolean(env.MOTORIST_APP_ENV?.trim() || env.VERCEL_ENV);
  for (const key of ["SUPABASE_PROJECT_REF", "EXPECTED_SUPABASE_PROJECT_REF"] as const) {
    const value = env[key]?.trim();
    if (value === "sjcsrygkkmersoczpunh" || (strict && value && value !== expected)) {
      throw new Error(`${key} does not match application environment`);
    }
  }
  for (const key of ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"] as const) {
    const value = env[key]?.trim();
    if (!value) continue;
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(`${key} is invalid`); }
    if (url.hostname === "sjcsrygkkmersoczpunh.supabase.co" || (strict &&
      (url.protocol !== "https:" || url.hostname !== `${expected}.supabase.co` || url.username || url.password))) {
      throw new Error(`${key} does not match application environment`);
    }
  }
  for (const key of ["APP_BASE_URL", "NEXT_PUBLIC_APP_URL", "PUBLIC_APP_URL"] as const) {
    const value = env[key]?.trim();
    if (!value) continue;
    let host: string;
    try { host = new URL(value).hostname; } catch { throw new Error(`${key} is invalid`); }
    if (host === "dev.dispecing.linkapomoci.sk" ||
      (app !== "production" && strict && ["dispecing.linkapomoci.sk", "dispecing-test.vercel.app"].includes(host)) ||
      (app === "production" && host === "test.dispecing.linkapomoci.sk")) {
      throw new Error(`${key} does not match application environment`);
    }
  }
  if (env.MOTORIST_APP_ENV && env.VERCEL_GIT_COMMIT_REF === "main" && app !== "production") {
    throw new Error("main must use the production application environment");
  }
}

/** Only the dedicated TEST project's dev production target may operate live test integrations. */
export function isTestLiveDeployment(env: AppEnvironmentVariables = process.env): boolean {
  try {
    assertAppEnvironment(env);
    if (env.MOTORIST_APP_ENV?.trim() !== "test" || env.VERCEL_ENV !== "production" ||
      env.VERCEL_GIT_COMMIT_REF !== "dev" || env.VERCEL_PROJECT_ID !== TEST_VERCEL_PROJECT_ID || env.APP_BASE_URL !== TEST_APP_ORIGIN) return false;
    return [env.SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_URL]
      .some(value => value === `https://${TEST_SUPABASE_REF}.supabase.co`);
  } catch { return false; }
}

/** Only the production project's main production target, bound to the production database. */
export function isProductionLiveDeployment(env: AppEnvironmentVariables = process.env): boolean {
  try {
    assertAppEnvironment(env);
    if (env.MOTORIST_APP_ENV?.trim() !== "production" || env.VERCEL_ENV !== "production" || env.VERCEL_GIT_COMMIT_REF !== "main" ||
      env.VERCEL_PROJECT_ID !== PRODUCTION_VERCEL_PROJECT_ID || env.APP_BASE_URL !== PRODUCTION_APP_ORIGIN) return false;
    return [env.SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_URL]
      .some(value => value === `https://${PRODUCTION_SUPABASE_REF}.supabase.co`);
  } catch { return false; }
}

/** Preview branches must not claim or sweep devices shared with the stable TEST application. */
export function canOperateTelephony(env: AppEnvironmentVariables = process.env): boolean {
  try {
    assertAppEnvironment(env);
    if (env.VERCEL_ENV === "preview") return false;
    if (resolveAppEnvironment(env) === "test") return isTestLiveDeployment(env);
    return true;
  } catch { return false; }
}

/** Maps use live provider quota too; working-branch Preview must not inherit it. */
export function canUseMapsIntegration(env: AppEnvironmentVariables = process.env): boolean {
  try {
    assertAppEnvironment(env);
    if (env.VERCEL_ENV === "preview") return false;
    if (resolveAppEnvironment(env) === "test") {
      return isTestLiveDeployment(env) && env.MOTORIST_TEST_LIVE_INTEGRATIONS === "true";
    }
    return true;
  } catch { return false; }
}

/** Separate opt-ins: compiling CallKit does not establish APNs readiness.
 * The flags are read before the deployment identity, which is the costlier check. */
export function nativeVoiceTestEnabled(env: AppEnvironmentVariables = process.env): boolean {
  return env.MOTORIST_NATIVE_VOICE_TEST_ENABLED === "true" && isTestLiveDeployment(env);
}
export function nativePushTestEnabled(env: AppEnvironmentVariables = process.env): boolean {
  return env.MOTORIST_NATIVE_VOIP_PUSH_TEST_ENABLED === "true" && nativeVoiceTestEnabled(env);
}
/** The dedicated TEST as above, or production with its own flags; a TEST flag never enables production. */
export function nativeVoiceEnabled(env: AppEnvironmentVariables = process.env): boolean {
  return nativeVoiceTestEnabled(env) || (env.MOTORIST_NATIVE_VOICE_ENABLED === "true" && isProductionLiveDeployment(env));
}
/** TEST and production identities exclude each other, so production push needs only its own two flags. */
export function nativePushEnabled(env: AppEnvironmentVariables = process.env): boolean {
  return nativePushTestEnabled(env) || (env.MOTORIST_NATIVE_VOIP_PUSH_ENABLED === "true"
    && env.MOTORIST_NATIVE_VOICE_ENABLED === "true" && isProductionLiveDeployment(env));
}
