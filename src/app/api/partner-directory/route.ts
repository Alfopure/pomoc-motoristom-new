import type { PartnerDirectoryInput } from "@/data/case-inputs";
import { loadDispatchData } from "@/data/dispatch-repository";
import { motoristAccessGuard, requireMotoristOrgMember } from "@/server/api-auth";
import { createPartnerDirectoryEntry, MutationError } from "@/server/motorist-mutations";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const denied = await motoristAccessGuard({ roles: ["manager", "admin"], request });
  if (denied) return denied;

  try {
    const input = (await request.json()) as PartnerDirectoryInput;
    await createPartnerDirectoryEntry(input, (organizationId) => requireMotoristOrgMember(organizationId, ["manager", "admin"]));
    const dispatchData = await loadDispatchData();

    return Response.json({ dispatchData });
  } catch (error) {
    return mutationErrorResponse(error);
  }
}

function mutationErrorResponse(error: unknown) {
  if (error instanceof MutationError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  console.error("Partner directory mutation failed:", error);
  return Response.json({ error: "Adresár sa nepodarilo uložiť." }, { status: 500 });
}
