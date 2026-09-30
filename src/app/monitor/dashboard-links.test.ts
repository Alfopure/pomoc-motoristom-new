import { describe, expect, it } from "vitest";
import { monitorDashboardLinks } from "./dashboard-links";

describe("monitor platform links", () => {
  it("links only this application's production and test projects", () => {
    expect(monitorDashboardLinks({ VERCEL_ENV: "production" }).supabase).toBe("https://supabase.com/dashboard/project/ifpaeegaesdmljfkdvcn");
    expect(monitorDashboardLinks({ VERCEL_ENV: "preview" }).supabase).toBe("https://supabase.com/dashboard/project/nzpnqdstvkfncflgqlny");
    expect(monitorDashboardLinks({ VERCEL_ENV: "development" }).supabase).toBeUndefined();
    expect(monitorDashboardLinks({}).vercel).toBeUndefined();
  });
  it("keeps the dedicated TEST production target on TEST platform dashboards", () => {
    expect(monitorDashboardLinks({
      MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "dev",
      VERCEL_PROJECT_ID: "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk",
      NEXT_PUBLIC_SUPABASE_URL: "https://nzpnqdstvkfncflgqlny.supabase.co",
    })).toMatchObject({
      vercel: "https://vercel.com/alfopures-projects/pomoc-motoristom-test",
      supabase: "https://supabase.com/dashboard/project/nzpnqdstvkfncflgqlny",
    });
  });
  it("omits platform links when the declared environment contradicts the database", () => {
    expect(monitorDashboardLinks({ MOTORIST_APP_ENV: "test", VERCEL_ENV: "production", SUPABASE_PROJECT_REF: "ifpaeegaesdmljfkdvcn" }))
      .toMatchObject({ vercel: undefined, supabase: undefined });
  });
  it("accepts clean dashboard URLs and rejects secrets, non-dashboard hosts and unsafe schemes", () => {
    expect(monitorDashboardLinks({ DIAGNOSTICS_SENTRY_DASHBOARD_URL: "https://team.sentry.io/issues/", DIAGNOSTICS_UPTIME_DASHBOARD_URL: "https://uptime.betterstack.com/team/123/monitors" })).toMatchObject({ sentry: "https://team.sentry.io/issues/", uptime: "https://uptime.betterstack.com/team/123/monitors" });
    for (const url of ["https://key@sentry.io/123", "https://sentry.io/issues/?auth=secret", "https://sentry.io/#secret", "http://sentry.io/", "javascript:alert(1)", "https://sentry.io.evil.test/", "https://hc-ping.com/secret", "not a url"]) {
      expect(monitorDashboardLinks({ DIAGNOSTICS_SENTRY_DASHBOARD_URL: url, DIAGNOSTICS_UPTIME_DASHBOARD_URL: url })).toMatchObject({ sentry: undefined, uptime: undefined });
    }
  });
});
