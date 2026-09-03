import { parseRingPlans, replaceRingPlans } from "@/server/telephony/config-service";
import { documentResponse, handleConfigRead, handleConfigWrite } from "@/server/telephony/config-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return handleConfigRead({ fallback: "Plány zvonenia sa nepodarilo načítať." });
}

/**
 * Replaces every ring plan and its steps in one transaction. A call already in
 * progress keeps the plan frozen at its start (`materialiseRingPlan`).
 */
export async function PUT(request: Request) {
  return handleConfigWrite(request, {
    fallback: "Plány zvonenia sa nepodarilo uložiť.",
    run: async ({ deps, actor, configActor, body, organizationId }) => {
      const plans = parseRingPlans(body.plans);
      const { document } = await replaceRingPlans(deps, { organizationId, actor: configActor, plans });
      return documentResponse(actor, document);
    },
  });
}
