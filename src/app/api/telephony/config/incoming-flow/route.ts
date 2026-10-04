import { ConfigServiceError } from "@/server/telephony/config-service";
import { documentResponse, handleConfigWrite, readExpectedVersion } from "@/server/telephony/config-route";
import { parseIncomingFlowChanges, saveIncomingFlows } from "@/server/telephony/incoming-flow-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
  return handleConfigWrite(request, {
    fallback: "Postup hovoru sa nepodarilo uložiť.",
    run: async ({ deps, actor, configActor, body, organizationId }) => {
      if (Object.keys(body).some(key => !["version", "snapshotId", "lines"].includes(key))) throw new ConfigServiceError("Neznáme pole konfigurácie.");
      if (typeof body.snapshotId !== "string" || !/^[a-f0-9]{32}$/.test(body.snapshotId)) throw new ConfigServiceError("Chýba snímka nastavení. Načítaj ich znova.");
      const result = await saveIncomingFlows(deps, {
        organizationId, actor: configActor, changes: parseIncomingFlowChanges(body.lines),
        expectedVersion: readExpectedVersion(body), expectedSnapshotId: body.snapshotId,
      });
      return documentResponse(actor, result.document, result.warning);
    },
  });
}
