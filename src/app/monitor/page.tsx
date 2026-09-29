import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { MotoristLogin } from "@/components/auth/MotoristLogin";
import { MonitorScreen } from "@/components/monitor/MonitorScreen";
import { getDefaultMotoristAuthState } from "@/server/api-auth";
import { getAppVersion } from "@/server/app-version";
import { monitorDashboardLinks } from "./dashboard-links";

export const metadata: Metadata = { title: "Monitor prevádzky" };

/** Separate route: opening diagnostics never acquires or disposes a webphone. */
export default async function MonitorPage() {
  await connection();
  const auth = await getDefaultMotoristAuthState(["manager", "admin"]);
  if (!auth.authorized) return <MotoristLogin message={auth.message} returnTo="/monitor" />;
  if (process.env.DIAGNOSTICS_PANEL_ENABLED === "false") return <main className="min-h-screen bg-zinc-100 p-8 text-zinc-900"><h1 className="text-lg font-semibold">Monitor prevádzky je vypnutý</h1><p className="mt-3 text-sm text-zinc-600">Zobrazenie monitora bolo dočasne vypnuté. Tento stav nevypovedá o dostupnosti aplikácie ani o zbere diagnostiky.</p><Link href="/" className="mt-5 inline-block text-sm font-semibold underline">Späť do dispečingu</Link></main>;
  const identity = auth.profile ? { profileId: auth.profile.profileId, organizationId: auth.profile.organizationId } : undefined;
  return <MonitorScreen appVersion={getAppVersion()} identity={identity} externalLinks={monitorDashboardLinks({ VERCEL_ENV: process.env.VERCEL_ENV, DIAGNOSTICS_SENTRY_DASHBOARD_URL: process.env.DIAGNOSTICS_SENTRY_DASHBOARD_URL, DIAGNOSTICS_UPTIME_DASHBOARD_URL: process.env.DIAGNOSTICS_UPTIME_DASHBOARD_URL })} />;
}
