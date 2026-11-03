import { getPartnerAuthState } from '@/server/partners/auth';
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTowingAuthState, towingEnabled, towingLoginDestination } from "@/server/towing/auth";
import { TowingWorkspace } from "@/components/towing/TowingWorkspace";
import { TowingUnavailable } from "@/components/towing/TowingUnavailable";
import { MotoristLogin } from "@/components/auth/MotoristLogin";
import { getDefaultMotoristAuthState } from "@/server/api-auth";
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
  if (!auth.actor.capabilities.some(capability => capability !== "drive" && capability !== "deliver")) redirect(towingLoginDestination(auth.actor) ?? "/");
  const dispatch = await getDefaultMotoristAuthState();
  const canDispatch = dispatch.authorized && Boolean(dispatch.profile && dispatch.profile.userId === auth.actor.userId && dispatch.profile.organizationId === auth.actor.organizationId);
  const partner = await getPartnerAuthState();
  const canPartner = partner.authorized && partner.actor.userId === auth.actor.userId && partner.actor.organizationId === auth.actor.organizationId;
  const params = await searchParams;
  return <TowingWorkspace canDispatch={canDispatch} canPartner={canPartner} view="office" initialOrderId={params.orderId} sourceCaseId={params.sourceCaseId} />;
}
