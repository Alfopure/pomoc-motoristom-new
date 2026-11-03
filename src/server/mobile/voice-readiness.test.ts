import { describe, expect, it } from "vitest";
import { getNativeVoiceReadiness } from "./voice-readiness";

const enabled = {
  MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
  VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk", APP_BASE_URL: "https://test.dispecing.linkapomoci.sk",
  SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co",
  MOTORIST_NATIVE_VOICE_TEST_ENABLED: "true", MOTORIST_NATIVE_VOIP_PUSH_TEST_ENABLED: "true",
};
const disabled = { nativeCallingEnabled: false, backgroundIncomingEnabled: false };

describe("native calling configuration readiness", () => {
  it("defaults to disabled without provider configuration or side effects", () => {
    expect(getNativeVoiceReadiness({})).toEqual(disabled);
  });
  it("reports only explicit configuration opt-ins for the dedicated TEST", () => {
    const env = { ...enabled };
    expect(getNativeVoiceReadiness(env)).toEqual({ nativeCallingEnabled: true, backgroundIncomingEnabled: true });
    expect(env).toEqual(enabled);
  });
  it.each([undefined, "false", "1", "TRUE", " true"])("keeps disabled native flag %s authoritative even when push is true", flag => {
    expect(getNativeVoiceReadiness({ ...enabled, MOTORIST_NATIVE_VOICE_TEST_ENABLED: flag })).toEqual(disabled);
  });
  it.each([undefined, "false", "1", "TRUE", " true"])("distinguishes foreground opt-in from push flag %s", flag => {
    expect(getNativeVoiceReadiness({ ...enabled, MOTORIST_NATIVE_VOIP_PUSH_TEST_ENABLED: flag }))
      .toEqual({ nativeCallingEnabled: true, backgroundIncomingEnabled: false });
  });
  it.each([
    { VERCEL_ENV: "preview" }, { VERCEL_ENV: "development" }, { VERCEL_GIT_COMMIT_REF: "feature/voice" },
    { VERCEL_PROJECT_ID: "prj_other" }, { APP_BASE_URL: "https://dispecing-test.vercel.app" },
    { APP_BASE_URL: "https://dispecing.linkapomoci.sk" }, { APP_BASE_URL: undefined },
    { MOTORIST_APP_ENV: "development" }, { MOTORIST_APP_ENV: "invalid" },
    { SUPABASE_URL: undefined }, { SUPABASE_URL: "https://ifpaeegaesdmljfkdvcn.supabase.co" },
    { SUPABASE_URL: "https://sjcsrygkkmersoczpunh.supabase.co" },
    { NEXT_PUBLIC_SUPABASE_URL: "https://ifpaeegaesdmljfkdvcn.supabase.co" },
    { SUPABASE_PROJECT_REF: "ifpaeegaesdmljfkdvcn" }, { EXPECTED_SUPABASE_PROJECT_REF: "wrong" },
    { SUPABASE_URL: "http://nzpnqdstvkfncflgqlny.supabase.co" },
  ])("fails closed for unsafe/ineligible deployment %j", changes => {
    expect(getNativeVoiceReadiness({ ...enabled, ...changes })).toEqual(disabled);
  });
  it("cannot activate on otherwise valid production in the TEST project", () => {
    expect(getNativeVoiceReadiness({ ...enabled, MOTORIST_APP_ENV: "production", VERCEL_GIT_COMMIT_REF: "main",
      APP_BASE_URL: "https://dispecing.linkapomoci.sk", SUPABASE_URL: "https://ifpaeegaesdmljfkdvcn.supabase.co" })).toEqual(disabled);
  });
  describe("production", () => {
    const production = { MOTORIST_APP_ENV: "production", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main",
      VERCEL_PROJECT_ID: "prj_DN3smSO1EbGowAmw3nHLQUYoSVJG", APP_BASE_URL: "https://dispecing.linkapomoci.sk",
      SUPABASE_URL: "https://ifpaeegaesdmljfkdvcn.supabase.co" };
    const flags = { MOTORIST_NATIVE_VOICE_ENABLED: "true", MOTORIST_NATIVE_VOIP_PUSH_ENABLED: "true" };
    it("stays disabled without its own flags, even with the TEST flags", () => {
      expect(getNativeVoiceReadiness(production)).toEqual(disabled);
      expect(getNativeVoiceReadiness({ ...production, MOTORIST_NATIVE_VOICE_TEST_ENABLED: "true", MOTORIST_NATIVE_VOIP_PUSH_TEST_ENABLED: "true" })).toEqual(disabled);
    });
    it("reports its own explicit opt-ins separately", () => {
      expect(getNativeVoiceReadiness({ ...production, ...flags })).toEqual({ nativeCallingEnabled: true, backgroundIncomingEnabled: true });
      expect(getNativeVoiceReadiness({ ...production, MOTORIST_NATIVE_VOICE_ENABLED: "true" })).toEqual({ nativeCallingEnabled: true, backgroundIncomingEnabled: false });
      expect(getNativeVoiceReadiness({ ...production, MOTORIST_NATIVE_VOIP_PUSH_ENABLED: "true" })).toEqual(disabled);
    });
    it.each([{ VERCEL_ENV: "preview" }, { VERCEL_PROJECT_ID: "prj_other" }, { VERCEL_GIT_COMMIT_REF: "dev" },
      { APP_BASE_URL: "https://dispecing-test.vercel.app" }, { SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co" }])("fails closed for %j", changes => {
      expect(getNativeVoiceReadiness({ ...production, ...flags, ...changes })).toEqual(disabled);
    });
  });
});
