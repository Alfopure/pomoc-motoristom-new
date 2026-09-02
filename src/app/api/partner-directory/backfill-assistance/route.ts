import { loadDispatchData } from "@/data/dispatch-repository";
import { motoristAccessGuard, requireMotoristOrgMember } from "@/server/api-auth";
import { backfillAssistanceDirectoryFromCases, MutationError } from "@/server/motorist-mutations";

export const runtime = "nodejs";

/**
 * Prevezme do adresára asistenčné služby, ktoré sa už používajú v prípadoch,
 * ale v adresári chýbajú (P-08). Manažérska operácia zo Nastavení.
 */
export async function POST(request: Request) {
  const denied = await motoristAccessGuard({ roles: ["manager", "admin"], request });
  if (denied) return denied;

  try {
    const { created } = await backfillAssistanceDirectoryFromCases((organizationId) =>
      requireMotoristOrgMember(organizationId, ["manager", "admin"]),
    );
    const dispatchData = await loadDispatchData();

    return Response.json({ created, dispatchData });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Assistance backfill failed:", error);
    return Response.json({ error: "Asistenčné služby sa nepodarilo prevziať z prípadov." }, { status: 500 });
  }
}
