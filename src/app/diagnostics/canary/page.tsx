import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { BROWSER_CANARY_COOKIE, validCanaryPermit } from "@/server/diagnostics/canary-access";
import { CanaryButton } from "./CanaryButton";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const metadata = { title: "Overenie monitoringu", robots: { index: false, follow: false } };

export default async function DiagnosticCanaryPage() {
  const cookieStore = await cookies();
  if (!validCanaryPermit(cookieStore.get(BROWSER_CANARY_COOKIE)?.value)) notFound();
  return (
    <main className="mx-auto max-w-lg space-y-4 p-8">
      <h1 className="text-xl font-semibold">Overenie monitoringu v TESTe</h1>
      <p>Tlačidlo vyvolá jednu skúšobnú chybu prehliadača pre kontrolu Sentry.</p>
      <CanaryButton />
    </main>
  );
}
