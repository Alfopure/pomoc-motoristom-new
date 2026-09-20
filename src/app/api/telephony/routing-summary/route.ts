import { requireDefaultMotoristActor } from "@/server/api-auth";
import { buildRoutingSummary } from "@/lib/telephony/routing-summary";
import { getTelnyxConfig } from "@/server/telephony/telnyx/env";
import { getCoherentRoutingDocument } from "@/server/telephony/config-service";
import { CONFIG_READ_ROLES, canEditConfig, configDeps, configErrorResponse } from "@/server/telephony/config-route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const actor = await requireDefaultMotoristActor(CONFIG_READ_ROLES);
    const document = await getCoherentRoutingDocument(configDeps(), { organizationId: actor.organizationId, includeSettings: true, includeLimits: true, includeOperatorDetails: false, viewerProfileId: actor.profileId });
    const config = getTelnyxConfig();
    const liveCallsEnabled = config.configured && config.liveCallsEnabled && document.settingsConfigured === true && document.settings?.liveCallsEnabled === true;
    return Response.json(buildRoutingSummary(document, new Date(), canEditConfig(actor.role), { liveCallsEnabled }), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return configErrorResponse(error, "Pravidlá nových hovorov sa nepodarilo načítať."); }
}
