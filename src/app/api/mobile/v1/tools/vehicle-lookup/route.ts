import { requireMobileToolsActor } from "@/server/mobile/tools-auth";
import { readMobileJsonBody } from "@/server/mobile/body";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { lookupToolVehicle, ToolLookupError } from "@/server/mobile/tools";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    const actor = await requireMobileToolsActor(request);
    const result = await lookupToolVehicle(actor, await readMobileJsonBody(request));
    return mobileJson({ ...mobileScope(actor), organizationId: actor.organizationId, ...result });
  } catch (error) {
    const response = mobileError(error, "Dohľadávanie vozidla nie je dostupné. Skúste to neskôr.");
    const retryAfter = error instanceof ToolLookupError ? error.retryAfter : undefined;
    if (typeof retryAfter === "number" && Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 300) {
      response.headers.set("Retry-After", String(retryAfter));
    }
    return response;
  }
}
