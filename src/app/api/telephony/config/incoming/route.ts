import { requireDefaultMotoristActor } from "@/server/api-auth";
import { ConfigServiceError, getCoherentRoutingDocument, parseRingGroups, parseRingPlans, replaceIncomingRouting } from "@/server/telephony/config-service";
import { CONFIG_READ_ROLES, canEditConfig, configDeps, configErrorResponse, documentResponse, handleConfigWrite, readExpectedVersion } from "@/server/telephony/config-route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const actor = await requireDefaultMotoristActor(CONFIG_READ_ROLES);
    const document = await getCoherentRoutingDocument(configDeps(), { organizationId: actor.organizationId, includeSettings: actor.role === "admin", includeLimits: canEditConfig(actor.role), includeOperatorDetails: canEditConfig(actor.role), viewerProfileId: actor.profileId });
    return documentResponse(actor, document);
  } catch (error) { return configErrorResponse(error, "Prichádzajúce hovory sa nepodarilo načítať."); }
}
export async function PUT(request: Request) {
  return handleConfigWrite(request, { fallback: "Prichádzajúce hovory sa nepodarilo uložiť.", run: async ({ deps, actor, configActor, body, organizationId }) => {
    if (Object.keys(body).some(key => !["groups", "plans", "version"].includes(key))) throw new ConfigServiceError("Neznáme pole konfigurácie.", 400, "config_invalid");
    const groups = parseRingGroups(body.groups); const plans = parseRingPlans(body.plans);
    if (groups.some(group => !group.id || group.members.some(member => !member.id)) || plans.some(plan => !plan.id || plan.steps.some(step => !step.id))) throw new ConfigServiceError("Každá skupina, člen, plán a krok potrebuje platný stabilný identifikátor. Návrh nebol uložený.", 400, "id_required");
    const result = await replaceIncomingRouting(deps, { organizationId, actor: configActor, groups, plans, expectedVersion: readExpectedVersion(body) });
    return documentResponse(actor, result.document, result.warning);
  } });
}
