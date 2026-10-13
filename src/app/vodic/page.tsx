import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTowingAuthState, towingEnabled } from "@/server/towing/auth";
import { TowingWorkspace } from "@/components/towing/TowingWorkspace";
import { TowingUnavailable } from "@/components/towing/TowingUnavailable";
import { MotoristLogin } from "@/components/auth/MotoristLogin";
import { getAppRelease } from "@/server/app-release";

export const metadata: Metadata = { title: "Moje zákazky", manifest: "/vodic.webmanifest" };
export const dynamic = "force-dynamic";

export default async function DriverPage({ searchParams }: { searchParams: Promise<{ orderId?: string }> }) {
  if (!towingEnabled()) notFound();
  const auth = await getTowingAuthState();
  if (!auth.authorized) {
    if (auth.reason === "unauthenticated") return <MotoristLogin message={auth.message} returnTo="/vodic" appRelease={getAppRelease()} />;
    return <TowingUnavailable message={auth.message} />;
  }
  if (!auth.actor.capabilities.includes("drive")) redirect("/zakazky");
  const params = await searchParams;
  return <TowingWorkspace view="driver" initialOrderId={params.orderId} />;
}
