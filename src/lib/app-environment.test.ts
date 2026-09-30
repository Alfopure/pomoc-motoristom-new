import { describe, expect, it } from "vitest";
import { assertAppEnvironment, canOperateTelephony, isTestLiveDeployment, resolveAppEnvironment } from "./app-environment";

const stableTest = {
  MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
  VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk",
  APP_BASE_URL: "https://test.dispecing.linkapomoci.sk",
  SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co",
};

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
  it("fails mismatches without reflecting credential-bearing input", () => {
    expect(() => assertAppEnvironment({ ...stableTest, SUPABASE_URL: "https://secret@example.org" }))
      .toThrow("SUPABASE_URL does not match application environment");
    expect(() => resolveAppEnvironment({ MOTORIST_APP_ENV: "typo" })).toThrow("Invalid MOTORIST_APP_ENV");
  });
});
