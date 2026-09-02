import { loadDispatchData } from "@/data/dispatch-repository";
import {
  confirmCommanderVehicleLink,
  importCommanderVehicle,
  MutationError,
  rejectCommanderVehicle,
  unlinkCommanderVehicle,
} from "@/server/motorist-mutations";
import { motoristAccessGuard } from "@/server/api-auth";

export const runtime = "nodejs";

type CommanderVehicleActionInput =
  | { action: "link"; fleetAssetId: string }
  | { action: "import"; branchId: string }
  | { action: "reject" }
  | { action: "unlink"; linkId: string };

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await motoristAccessGuard({ request });
  if (denied) return denied;

  try {
    const { id } = await params;
    const input = await readCommanderVehicleActionInput(request);
    const resultId = await runCommanderVehicleAction(id, input);
    const dispatchData = await loadDispatchData();

    return Response.json({ dispatchData, id: resultId });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Commander vehicle action failed:", error);
    return Response.json({ error: "Commander napojenie sa nepodarilo upraviť." }, { status: 500 });
  }
}

async function readCommanderVehicleActionInput(request: Request): Promise<CommanderVehicleActionInput> {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    throw new MutationError("Neplatný JSON payload.", 400);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload) || typeof (payload as { action?: unknown }).action !== "string") {
    throw new MutationError("Chýba Commander akcia.", 400);
  }

  return payload as CommanderVehicleActionInput;
}

async function runCommanderVehicleAction(id: string, input: CommanderVehicleActionInput) {
  if (input.action === "link") {
    const link = await confirmCommanderVehicleLink({ externalVehicleRecordId: id, fleetAssetId: input.fleetAssetId });
    return link.id;
  }

  if (input.action === "import") {
    const asset = await importCommanderVehicle({ externalVehicleRecordId: id, branchId: input.branchId });
    return asset.id;
  }

  if (input.action === "reject") {
    const link = await rejectCommanderVehicle({ externalVehicleRecordId: id });
    return link.id;
  }

  if (input.action === "unlink") {
    const link = await unlinkCommanderVehicle({ linkId: input.linkId });
    return link.id;
  }

  throw new MutationError("Neznáma Commander akcia.", 400);
}
