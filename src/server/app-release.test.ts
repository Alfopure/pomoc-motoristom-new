import { afterEach, describe, expect, it, vi } from "vitest";
import { getAppRelease } from "./app-release";
import { appReleaseDate } from "@/lib/app-release";

afterEach(() => vi.unstubAllEnvs());

describe("public loaded release metadata", () => {
  it("uses the application environment for dedicated TEST even on Vercel Production", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_RELEASE_CODE", "a123456789ab");
    vi.stubEnv("NEXT_PUBLIC_APP_BUILT_AT", "2026-10-05T08:00:00Z");
    expect(getAppRelease({ MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_SHA: "test-commit", VERCEL_DEPLOYMENT_ID: "dpl_test" }))
      .toEqual({ environment: "test", code: "a123456789ab", builtAt: "2026-10-05T08:00:00Z", commit: "test-commit", deployment: "dpl_test" });
  });

  it("retains source identity while deployment identity changes", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_RELEASE_CODE", "a123456789ab");
    const first = getAppRelease({ MOTORIST_APP_ENV: "production", VERCEL_DEPLOYMENT_ID: "dpl_first" });
    const next = getAppRelease({ MOTORIST_APP_ENV: "production", VERCEL_DEPLOYMENT_ID: "dpl_next" });
    expect(first.code).toBe(next.code);
    expect(first.deployment).not.toBe(next.deployment);
  });

  it("has an honest local fallback when build metadata is absent", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_RELEASE_CODE", "");
    vi.stubEnv("NEXT_PUBLIC_APP_BUILT_AT", "");
    expect(getAppRelease({})).toEqual({ environment: "development", code: null, builtAt: null, commit: null, deployment: "development" });
  });

  it("formats dates consistently in Slovak time even across midnight", () => {
    expect(appReleaseDate("2026-10-05T23:30:00Z")).toBe("06.10.2026");
    expect(appReleaseDate(null)).toBeNull();
    expect(appReleaseDate("invalid")).toBeNull();
  });
});
