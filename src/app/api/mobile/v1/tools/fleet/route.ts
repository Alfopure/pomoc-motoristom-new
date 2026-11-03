import { requireMobileToolsActor } from "@/server/mobile/tools-auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { fleetTool, parseToolFleetFilter } from "@/server/mobile/tools";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const actor = await requireMobileToolsActor(request);
    const selection = parseToolFleetFilter(new URL(request.url).searchParams);
    const result = await fleetTool(actor, selection, request.signal);
    return mobileJson({ ...mobileScope(actor), organizationId: actor.organizationId, ...result });
  } catch (error) { return mobileError(error, "Uložený prehľad flotily nie je dostupný."); }
}
