import { describe, expect, it } from "vitest";
import {
  assertAppEnvironment, canOperateTelephony, canUseMapsIntegration, isProductionLiveDeployment, isTestLiveDeployment,
  nativePushEnabled, nativePushTestEnabled, nativeVoiceEnabled, nativeVoiceTestEnabled, resolveAppEnvironment,
} from "./app-environment";

const stableTest = {
  MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
  VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk",
  APP_BASE_URL: "https://test.dispecing.linkapomoci.sk",
  SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co",
};
const production = {
  MOTORIST_APP_ENV: "production", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main",
  VERCEL_PROJECT_ID: "prj_DN3smSO1EbGowAmw3nHLQUYoSVJG",
  APP_BASE_URL: "https://dispecing.linkapomoci.sk",
  SUPABASE_URL: "https://ifpaeegaesdmljfkdvcn.supabase.co",
};
const testFlags = { MOTORIST_NATIVE_VOICE_TEST_ENABLED: "true", MOTORIST_NATIVE_VOIP_PUSH_TEST_ENABLED: "true" };
const productionFlags = { MOTORIST_NATIVE_VOICE_ENABLED: "true", MOTORIST_NATIVE_VOIP_PUSH_ENABLED: "true" };

describe("application deployment boundary", () => {
  it("separates application TEST from the Vercel production build target", () => {
    expect(resolveAppEnvironment(stableTest)).toBe("test");
    expect(isTestLiveDeployment(stableTest)).toBe(true);
    expect(canOperateTelephony(stableTest)).toBe(true);
    expect(resolveAppEnvironment({ VERCEL_ENV: "production" })).toBe("production");
    expect(resolveAppEnvironment({ VERCEL_ENV: "preview" })).toBe("test");
    expect(resolveAppEnvironment({})).toBe("development");
  });
  it.each([
    { VERCEL_PROJECT_ID: undefined }, { VERCEL_PROJECT_ID: "prj_foreign" },
    { VERCEL_ENV: "preview" }, { VERCEL_GIT_COMMIT_REF: "feature/test" },
    { VERCEL_GIT_COMMIT_REF: "main" }, { MOTORIST_APP_ENV: undefined },
    { APP_BASE_URL: "https://dispecing-test.vercel.app" }, { APP_BASE_URL: undefined },
    { SUPABASE_URL: "https://ifpaeegaesdmljfkdvcn.supabase.co" },
    { NEXT_PUBLIC_SUPABASE_URL: "https://ifpaeegaesdmljfkdvcn.supabase.co" },
    { SUPABASE_PROJECT_REF: "sjcsrygkkmersoczpunh" },
  ])("rejects live TEST with a mismatched binding %j", override => {
    expect(isTestLiveDeployment({ ...stableTest, ...override })).toBe(false);
  });
  it("blocks Preview device operations even without live flags", () => {
    expect(canOperateTelephony({ VERCEL_ENV: "preview" })).toBe(false);
    expect(canOperateTelephony({ MOTORIST_APP_ENV: "test" })).toBe(false);
  });
  it("allows Maps only in production, local development or explicitly enabled dedicated TEST", () => {
    expect(canUseMapsIntegration({ VERCEL_ENV: "production", MOTORIST_APP_ENV: "production" })).toBe(true);
    expect(canUseMapsIntegration({})).toBe(true);
    expect(canUseMapsIntegration(stableTest)).toBe(false);
    expect(canUseMapsIntegration({ ...stableTest, MOTORIST_TEST_LIVE_INTEGRATIONS: "true" })).toBe(true);
  });
  it.each([
    { VERCEL_ENV: "preview" }, { VERCEL_PROJECT_ID: "prj_foreign" },
    { VERCEL_GIT_COMMIT_REF: "feature/maps" }, { MOTORIST_TEST_LIVE_INTEGRATIONS: "false" },
    { SUPABASE_URL: "https://ifpaeegaesdmljfkdvcn.supabase.co" },
    { APP_BASE_URL: "https://dispecing.linkapomoci.sk" },
  ])("blocks Maps in mismatched TEST deployment %j", override => {
    expect(canUseMapsIntegration({ ...stableTest, MOTORIST_TEST_LIVE_INTEGRATIONS: "true", ...override })).toBe(false);
  });
  it("fails mismatches without reflecting credential-bearing input", () => {
    expect(() => assertAppEnvironment({ ...stableTest, SUPABASE_URL: "https://secret@example.org" }))
      .toThrow("SUPABASE_URL does not match application environment");
    expect(() => resolveAppEnvironment({ MOTORIST_APP_ENV: "typo" })).toThrow("Invalid MOTORIST_APP_ENV");
  });
});

const productionMismatches = [
  { VERCEL_ENV: "preview" }, { VERCEL_ENV: "development" }, { VERCEL_ENV: undefined },
  { VERCEL_PROJECT_ID: undefined }, { VERCEL_PROJECT_ID: "prj_foreign" }, { VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk" },
  { VERCEL_GIT_COMMIT_REF: "dev" }, { VERCEL_GIT_COMMIT_REF: "feature/voice" }, { VERCEL_GIT_COMMIT_REF: undefined },
  { APP_BASE_URL: "https://test.dispecing.linkapomoci.sk" }, { APP_BASE_URL: "https://dispecing-test.vercel.app" },
  { APP_BASE_URL: "https://dispecing.linkapomoci.sk/" }, { APP_BASE_URL: undefined },
  { MOTORIST_APP_ENV: "test" }, { MOTORIST_APP_ENV: "development" }, { MOTORIST_APP_ENV: "invalid" },
  { SUPABASE_URL: undefined }, { SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co" },
  { NEXT_PUBLIC_SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co" }, { SUPABASE_PROJECT_REF: "sjcsrygkkmersoczpunh" },
];

describe("production live deployment and native calling opt-ins", () => {
  it("recognizes only the production project's main target on production data", () => {
    expect(isProductionLiveDeployment(production)).toBe(true);
    expect(isProductionLiveDeployment(stableTest)).toBe(false);
    expect(isProductionLiveDeployment({})).toBe(false);
    expect(canOperateTelephony(production)).toBe(true);
  });
  it.each(productionMismatches)("rejects production with a mismatched binding %j", override => {
    expect(isProductionLiveDeployment({ ...production, ...override })).toBe(false);
    expect(nativeVoiceEnabled({ ...production, ...productionFlags, ...override })).toBe(false);
    expect(nativePushEnabled({ ...production, ...productionFlags, ...override })).toBe(false);
  });
  it("keeps the dedicated TEST exactly on its own flags", () => {
    expect(nativeVoiceEnabled({ ...stableTest, ...testFlags })).toBe(true);
    expect(nativePushEnabled({ ...stableTest, ...testFlags })).toBe(true);
    expect(nativePushEnabled({ ...stableTest, MOTORIST_NATIVE_VOICE_TEST_ENABLED: "true" })).toBe(false);
    expect(nativePushEnabled({ ...stableTest, MOTORIST_NATIVE_VOIP_PUSH_TEST_ENABLED: "true" })).toBe(false);
    expect(nativeVoiceEnabled({ ...stableTest, ...productionFlags })).toBe(false);
    expect(nativePushEnabled({ ...stableTest, ...productionFlags })).toBe(false);
  });
  it.each([
    stableTest, { ...stableTest, VERCEL_ENV: "preview" }, { ...stableTest, VERCEL_PROJECT_ID: "prj_foreign" }, { VERCEL_ENV: "preview" }, {},
  ].flatMap(base => [{}, testFlags, productionFlags, { ...testFlags, ...productionFlags },
    { MOTORIST_NATIVE_VOICE_TEST_ENABLED: "true" }, { MOTORIST_NATIVE_VOICE_TEST_ENABLED: "1", MOTORIST_NATIVE_VOIP_PUSH_TEST_ENABLED: "true" },
  ].map(flags => ({ ...base, ...flags }))))("matches the TEST-only helpers outside production %j", env => {
    expect(nativeVoiceEnabled(env)).toBe(nativeVoiceTestEnabled(env));
    expect(nativePushEnabled(env)).toBe(nativePushTestEnabled(env));
  });
  it("enables production only with its own explicit flags", () => {
    expect(nativeVoiceEnabled(production)).toBe(false);
    expect(nativeVoiceEnabled({ ...production, MOTORIST_NATIVE_VOICE_ENABLED: "true" })).toBe(true);
    expect(nativePushEnabled({ ...production, MOTORIST_NATIVE_VOICE_ENABLED: "true" })).toBe(false);
    expect(nativePushEnabled({ ...production, ...productionFlags })).toBe(true);
    expect(nativePushEnabled({ ...production, MOTORIST_NATIVE_VOIP_PUSH_ENABLED: "true" })).toBe(false);
    expect(nativeVoiceEnabled({ ...production, ...testFlags })).toBe(false);
    expect(nativePushEnabled({ ...production, ...testFlags })).toBe(false);
    expect(nativePushEnabled({ ...production, MOTORIST_NATIVE_VOICE_ENABLED: "true", MOTORIST_NATIVE_VOIP_PUSH_TEST_ENABLED: "true" })).toBe(false);
  });
  it.each([undefined, "false", "1", "TRUE", " true"])("treats production flag value %s as off", flag => {
    expect(nativeVoiceEnabled({ ...production, ...productionFlags, MOTORIST_NATIVE_VOICE_ENABLED: flag })).toBe(false);
    expect(nativePushEnabled({ ...production, ...productionFlags, MOTORIST_NATIVE_VOICE_ENABLED: flag })).toBe(false);
    expect(nativePushEnabled({ ...production, ...productionFlags, MOTORIST_NATIVE_VOIP_PUSH_ENABLED: flag })).toBe(false);
  });
});
