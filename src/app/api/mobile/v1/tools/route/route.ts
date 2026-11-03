import { requireMobileToolsActor } from "@/server/mobile/tools-auth";
import { readMobileJsonBody } from "@/server/mobile/body";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { routeTool } from "@/server/mobile/tools";
export const runtime = "nodejs";
export const maxDuration = 30;
export async function POST(request: Request) {
  try {
    const actor = await requireMobileToolsActor(request);
    const result = await routeTool(await readMobileJsonBody(request), request.signal);
    return mobileJson({ ...mobileScope(actor), organizationId: actor.organizationId, ...result });
  } catch (error) { return mobileError(error, "Výpočet trasy nie je dostupný. Skúste to neskôr."); }
}
