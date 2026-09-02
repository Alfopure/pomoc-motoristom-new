import type { PartnerDirectoryInput } from "@/data/case-inputs";
import { loadDispatchData } from "@/data/dispatch-repository";
import { motoristAccessGuard, requireMotoristOrgMember } from "@/server/api-auth";
import { deletePartnerDirectoryEntry, MutationError, updatePartnerDirectoryEntry } from "@/server/motorist-mutations";

export const runtime = "nodejs";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await motoristAccessGuard({ roles: ["manager", "admin"], request });
  if (denied) return denied;

  try {
    const { id } = await params;
    const input = (await request.json()) as Partial<PartnerDirectoryInput>;
    await updatePartnerDirectoryEntry(id, input, (organizationId) => requireMotoristOrgMember(organizationId, ["manager", "admin"]));
    const dispatchData = await loadDispatchData();

    return Response.json({ dispatchData });
  } catch (error) {
    return mutationErrorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await motoristAccessGuard({ roles: ["manager", "admin"], request });
  if (denied) return denied;

  try {
    const { id } = await params;
    await deletePartnerDirectoryEntry(id, (organizationId) => requireMotoristOrgMember(organizationId, ["manager", "admin"]));
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
  return Response.json({ error: "Adresár sa nepodarilo upraviť." }, { status: 500 });
}
