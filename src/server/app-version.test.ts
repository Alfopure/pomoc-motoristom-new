import { afterEach, describe, expect, it, vi } from "vitest";
import { getAppVersion } from "./app-version";

describe("getAppVersion", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers the deployment identifier, including for redeploys of the same commit", () => {
    const env = { DEPLOYMENT_VERSION: "release-1", VERCEL_GIT_COMMIT_SHA: "commit-1" };

    expect(getAppVersion({ ...env, VERCEL_DEPLOYMENT_ID: " dpl_first " })).toBe("dpl_first");
    expect(getAppVersion({ ...env, VERCEL_DEPLOYMENT_ID: "dpl_second" })).toBe("dpl_second");
  });

  it("uses the explicit deployment version before falling back to the commit", () => {
    expect(getAppVersion({
      VERCEL_DEPLOYMENT_ID: "  ",
      DEPLOYMENT_VERSION: " release-2 ",
      VERCEL_GIT_COMMIT_SHA: "commit-1",
    })).toBe("release-2");
  });

  it("uses the full commit when deployment identifiers are unavailable", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";

    expect(getAppVersion({
      DEPLOYMENT_VERSION: "  ",
      VERCEL_GIT_COMMIT_SHA: ` ${commit} `,
    })).toBe(commit);
  });

  it.each([
    {},
    { VERCEL_DEPLOYMENT_ID: "", DEPLOYMENT_VERSION: " \t ", VERCEL_GIT_COMMIT_SHA: "\n" },
  ])("returns a stable development fallback for missing identifiers: %j", (env) => {
    expect(getAppVersion(env)).toBe("development");
    expect(getAppVersion(env)).toBe("development");
  });

  it("reads the server environment by default", () => {
    vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_runtime");

    expect(getAppVersion()).toBe("dpl_runtime");
  });
});
