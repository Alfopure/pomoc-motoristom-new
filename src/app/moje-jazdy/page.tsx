import { getPartnerAuthState } from '@/server/partners/auth';
import { connection } from "next/server";
import { OperationsModule } from "@/components/operations/OperationsModule";
import { MotoristLogin } from "@/components/auth/MotoristLogin";
import { Shell } from "@/components/towing/primitives";
import { getAppRelease } from "@/server/app-release";
import { getDefaultMotoristAuthState } from "@/server/api-auth";
import { requireOperationsActor } from "@/server/operations";
import { getTowingAuthState, towingEnabled } from "@/server/towing/auth";
import { TowingError } from "@/server/towing/http";

export const metadata = { title: "Moje jazdy · Pomoc motoristom" };

export default async function MyOperationsPage() {
  await connection();
  let actor;
  let failure;
  try {
    actor = await requireOperationsActor();
  } catch (error) {
    failure = error instanceof TowingError ? error.message : "Jazdy momentálne nie sú dostupné.";
  }
  if (!actor) return <MotoristLogin message={failure ?? "Jazdy momentálne nie sú dostupné."} returnTo="/moje-jazdy" appRelease={getAppRelease()} />;
  const dispatch = await getDefaultMotoristAuthState();
  const towing = towingEnabled() ? await getTowingAuthState() : null;
  const canDispatch = dispatch.authorized && Boolean(dispatch.profile) && dispatch.profile?.userId === actor.userId && dispatch.profile?.organizationId === actor.organizationId;
  const partner = await getPartnerAuthState();
  const canPartner = partner.authorized && partner.actor.userId === actor.userId && partner.actor.organizationId === actor.organizationId;
  const capabilities = towing?.authorized ? towing.actor.capabilities : [];
  return <Shell view="operations" canDispatch={canDispatch} canPartner={canPartner} canOffice={capabilities.some(capability => !["drive", "deliver"].includes(capability))} canDriver={capabilities.includes("drive")} canDeliver={capabilities.includes("deliver")}><OperationsModule mine={!actor.canDispatch} /></Shell>;
}
