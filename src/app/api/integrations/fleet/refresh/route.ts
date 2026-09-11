import { loadFleetData } from "@/data/dispatch-repository";
import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/mutation-error";
import { refreshFleetSources } from "@/server/integrations/fleet-refresh";
import { measureRequestStep, withRequestMetrics } from "@/server/request-metrics";

export const runtime = "nodejs";
export const maxDuration = 300;
export async function POST(request: Request) {
  return withRequestMetrics("fleet.refresh", async () => {
    try {
      assertSameOriginRequest(request);
      const actor = await measureRequestStep("auth", () => requireDefaultMotoristActor(["dispatcher", "senior_dispatcher", "manager", "admin"]));
      const summary = await measureRequestStep("provider", () => refreshFleetSources());
      const fleetData = await measureRequestStep("read", () => loadFleetData(actor.organizationId, request.signal));
      return Response.json({ fleetData, summary }, { headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
    } catch (error) {
      return Response.json({ error: error instanceof MutationError ? error.message : "Flotilu sa nepodarilo obnoviť. Posledné uložené údaje zostávajú zachované." }, { status: error instanceof MutationError ? error.status : 503 });
    }
  });
}
