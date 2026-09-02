import { loadDispatchData } from "@/data/dispatch-repository";
import { assertSameOriginRequest, requireDefaultMotoristOrgRole } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import { updateWebdispecinkProviderVehicle } from "@/server/webdispecink-sync";

export const runtime = "nodejs";

type VehicleActionBody = {
  action?: unknown;
  branchId?: unknown;
  fleetAssetId?: unknown;
  kind?: unknown;
};

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginRequest(request);
    await requireDefaultMotoristOrgRole(["manager", "admin"]);
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as VehicleActionBody;
    const action = normalizeVehicleAction(body);
    const result = await updateWebdispecinkProviderVehicle(id, action);
    const dispatchData = await loadDispatchData();

    return Response.json({ ok: true, ...result, dispatchData });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ ok: false, error: error.message }, { status: error.status });
    }

    console.error("WebDispecink vehicle action failed:", error);
    return Response.json({ ok: false, error: "WebDispečink vozidlo sa nepodarilo upraviť." }, { status: 500 });
  }
}

function normalizeVehicleAction(body: VehicleActionBody) {
  if (body.action === "link" && typeof body.fleetAssetId === "string" && body.fleetAssetId.trim()) {
    return {
      action: "link" as const,
      fleetAssetId: body.fleetAssetId.trim(),
    };
  }

  if (body.action === "import" && typeof body.branchId === "string" && body.branchId.trim()) {
    return {
      action: "import" as const,
      branchId: body.branchId.trim(),
      kind: body.kind === "replacement_car" ? ("replacement_car" as const) : ("tow_truck" as const),
    };
  }

  throw new MutationError("Neplatná akcia pre WebDispečink vozidlo.", 400);
}
