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
  return {
    vercel: env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview" ? "https://vercel.com/alfopures-projects/pomoc-motoristom-dispatching" : undefined,
    supabase: env.VERCEL_ENV === "production" ? "https://supabase.com/dashboard/project/ifpaeegaesdmljfkdvcn" : env.VERCEL_ENV === "preview" ? "https://supabase.com/dashboard/project/nzpnqdstvkfncflgqlny" : undefined,
    sentry: dashboardUrl(env.DIAGNOSTICS_SENTRY_DASHBOARD_URL, ["sentry.io"]),
    uptime: dashboardUrl(env.DIAGNOSTICS_UPTIME_DASHBOARD_URL, ["uptime.betterstack.com", "betteruptime.com", "dashboard.uptimerobot.com", "app.uptimerobot.com"]),
  };
}
