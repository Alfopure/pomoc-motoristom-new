import type { CreateFleetAssetInput } from "@/data/case-inputs";
import { loadDispatchData } from "@/data/dispatch-repository";
import { createFleetAsset, MutationError } from "@/server/motorist-mutations";
import { assertSameOriginRequest, requireDefaultMotoristOrgRole } from "@/server/api-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    await requireDefaultMotoristOrgRole(["manager", "admin"]);
    const input = (await request.json()) as CreateFleetAssetInput;
    const asset = await createFleetAsset(input);
    const dispatchData = await loadDispatchData();

    return Response.json({ assetId: asset.id, dispatchData });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Fleet asset mutation failed:", error);
    return Response.json({ error: "Techniku sa nepodarilo uložiť." }, { status: 500 });
  }
}
