import { parseLineWorkspaceChanges, saveLineWorkspace } from "@/server/telephony/line-workspace-service";
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
      const workspace = Array.isArray(body.lines) && body.lines.some(raw => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
        const line = raw as Record<string, unknown>;
        const flow = line.flow as { steps?: unknown } | null;
        return "patch" in line || Boolean(flow && Array.isArray(flow.steps) && flow.steps.some(step => step && typeof step === "object" && "type" in step && step.type === "line"));
      });
      const result = workspace ? await saveLineWorkspace(deps, {
        organizationId, actor: configActor, changes: parseLineWorkspaceChanges(body.lines),
        expectedVersion: readExpectedVersion(body), expectedSnapshotId: body.snapshotId,
      }) : await saveIncomingFlows(deps, {
        organizationId, actor: configActor, changes: parseIncomingFlowChanges(body.lines),
        expectedVersion: readExpectedVersion(body), expectedSnapshotId: body.snapshotId,
      });
      return documentResponse(actor, result.document, result.warning);
    },
  });
}
