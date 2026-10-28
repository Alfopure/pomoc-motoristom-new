import { connection } from "next/server";
import { BranchWorkspace } from "@/components/branches/BranchWorkspace";
import { MotoristLogin } from "@/components/auth/MotoristLogin";
import { Shell } from "@/components/towing/primitives";
import { getAppRelease } from "@/server/app-release";
import { getDefaultMotoristAuthState } from "@/server/api-auth";
import { getBranchAccess } from "@/server/branches/service";
import { getTowingAuthState, towingEnabled } from "@/server/towing/auth";

export const metadata = { title: "Pobočka · Pomoc motoristom" };

/** Local branch workspace: same login and data as the dispatch app, scoped to the lead's groups. */
export default async function BranchPage() {
  await connection();
  const actor = await getBranchAccess().catch(() => null);
  if (!actor) return <MotoristLogin message="Prihláste sa účtom pobočky. Ak sa prihlásiť nedá, požiadajte centrálu o pridelenie pobočky." returnTo="/pobocka" appRelease={getAppRelease()} />;
  const dispatch = await getDefaultMotoristAuthState();
  const towing = towingEnabled() ? await getTowingAuthState() : null;
  const capabilities = towing?.authorized && towing.actor.userId === actor.userId ? towing.actor.capabilities : [];
  const canDispatch = dispatch.authorized && dispatch.profile?.userId === actor.userId;
  return <Shell view="branch" canDispatch={canDispatch} canBranch canOffice={capabilities.some(capability => !["drive", "deliver"].includes(capability))} canDriver={capabilities.includes("drive")} canDeliver={capabilities.includes("deliver")}><BranchWorkspace standalone /></Shell>;
}
