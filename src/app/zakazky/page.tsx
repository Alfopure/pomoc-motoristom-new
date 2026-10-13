import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTowingAuthState, towingEnabled } from "@/server/towing/auth";
import { TowingWorkspace } from "@/components/towing/TowingWorkspace";
import { TowingUnavailable } from "@/components/towing/TowingUnavailable";
import { MotoristLogin } from "@/components/auth/MotoristLogin";
import { getAppRelease } from "@/server/app-release";

export const metadata: Metadata = { title: "Zákazky odťahovej služby" };
export const dynamic = "force-dynamic";

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ orderId?: string; sourceCaseId?: string }> }) {
  if (!towingEnabled()) notFound();
  const auth = await getTowingAuthState();
  if (!auth.authorized) {
    if (auth.reason === "unauthenticated") return <MotoristLogin message={auth.message} returnTo="/zakazky" appRelease={getAppRelease()} />;
    return <TowingUnavailable message={auth.message} />;
  }
  if (!auth.actor.capabilities.some(capability => capability !== "drive")) redirect("/vodic");
  const params = await searchParams;
  return <TowingWorkspace view="office" initialOrderId={params.orderId} sourceCaseId={params.sourceCaseId} />;
}
