import { getPartnerAuthState } from '@/server/partners/auth';
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTowingAuthState, towingEnabled, towingLoginDestination } from "@/server/towing/auth";
import { TowingWorkspace } from "@/components/towing/TowingWorkspace";
import { TowingUnavailable } from "@/components/towing/TowingUnavailable";
import { MotoristLogin } from "@/components/auth/MotoristLogin";
import { getDefaultMotoristAuthState } from "@/server/api-auth";
import { getAppRelease } from "@/server/app-release";
import { isUuid } from "@/lib/telephony/uuid";

export const metadata: Metadata = { title: "Kniha odťahov" };
export const dynamic = "force-dynamic";

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ orderId?: string; sourceCaseId?: string }> }) {
  if (!towingEnabled()) notFound();
  const params = await searchParams;
  const returnParams = new URLSearchParams();
  if (isUuid(params.orderId ?? "")) returnParams.set("orderId", params.orderId!);
  if (isUuid(params.sourceCaseId ?? "")) returnParams.set("sourceCaseId", params.sourceCaseId!);
  const returnTo = `/zakazky${returnParams.size ? `?${returnParams}` : ""}`;
  const auth = await getTowingAuthState();
  if (!auth.authorized) {
    if (auth.reason === "unauthenticated") return <MotoristLogin message={auth.message} returnTo={returnTo} appRelease={getAppRelease()} />;
    return <TowingUnavailable message={auth.message} />;
  }
  if (!auth.actor.capabilities.some(capability => capability !== "drive" && capability !== "deliver")) redirect(towingLoginDestination(auth.actor) ?? "/");
  const dispatch = await getDefaultMotoristAuthState();
  const canDispatch = dispatch.authorized && Boolean(dispatch.profile && dispatch.profile.userId === auth.actor.userId && dispatch.profile.organizationId === auth.actor.organizationId);
  const partner = await getPartnerAuthState();
  const canPartner = partner.authorized && partner.actor.userId === auth.actor.userId && partner.actor.organizationId === auth.actor.organizationId;
  return <TowingWorkspace canDispatch={canDispatch} canPartner={canPartner} view="office" initialOrderId={params.orderId} sourceCaseId={params.sourceCaseId} />;
}
