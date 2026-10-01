import { assertAppEnvironment, PRODUCTION_SUPABASE_REF, resolveAppEnvironment, TEST_SUPABASE_REF, TEST_VERCEL_PROJECT_ID } from "@/lib/app-environment";

type DashboardEnvironment = Record<string, string | undefined>;

/** Dashboard destinations only; never expose DSNs, ping endpoints, or credentials. */
function dashboardUrl(value: string | undefined, hosts: readonly string[]) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port) return undefined;
    if (!hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return undefined;
    return url.href;
  } catch { return undefined; }
}

export function monitorDashboardLinks(env: DashboardEnvironment) {
  let vercel: string | undefined;
  let supabase: string | undefined;
  try {
    assertAppEnvironment(env);
    const app = resolveAppEnvironment(env);
    if (app !== "development") {
      const ref = app === "test" ? TEST_SUPABASE_REF : PRODUCTION_SUPABASE_REF;
      supabase = `https://supabase.com/dashboard/project/${ref}`;
      if (env.VERCEL_PROJECT_ID === TEST_VERCEL_PROJECT_ID && app === "test") {
        vercel = "https://vercel.com/alfopures-projects/pomoc-motoristom-test";
      } else if ((!env.VERCEL_PROJECT_ID || env.VERCEL_PROJECT_ID === "prj_DN3smSO1EbGowAmw3nHLQUYoSVJG") &&
        (env.VERCEL_ENV === "preview" || (env.VERCEL_ENV === "production" && app === "production"))) {
        vercel = "https://vercel.com/alfopures-projects/pomoc-motoristom-dispatching";
      }
    }
  } catch { /* Invalid identity must not send an operator to another project's dashboard. */ }
  return {
    vercel,
    supabase,
    sentry: dashboardUrl(env.DIAGNOSTICS_SENTRY_DASHBOARD_URL, ["sentry.io"]),
    uptime: dashboardUrl(env.DIAGNOSTICS_UPTIME_DASHBOARD_URL, ["uptime.betterstack.com", "betteruptime.com", "dashboard.uptimerobot.com", "app.uptimerobot.com"]),
  };
}
