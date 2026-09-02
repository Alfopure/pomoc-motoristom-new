import type { UpdateFleetAssetInput } from "@/data/case-inputs";
import { loadDispatchData } from "@/data/dispatch-repository";
import { MutationError, updateFleetAsset } from "@/server/motorist-mutations";
import { assertSameOriginRequest, requireDefaultMotoristOrgRole } from "@/server/api-auth";

export const runtime = "nodejs";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginRequest(request);
    await requireDefaultMotoristOrgRole(["manager", "admin"]);
    const { id } = await params;
    const input = (await request.json()) as UpdateFleetAssetInput;
    const asset = await updateFleetAsset(id, input);
    const dispatchData = await loadDispatchData();

    return Response.json({ assetId: asset.id, dispatchData });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Fleet asset update failed:", error);
    return Response.json({ error: "Techniku sa nepodarilo upraviť." }, { status: 500 });
  }
}
