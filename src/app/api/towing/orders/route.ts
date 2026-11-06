import { requireTowingRequestActor } from "@/server/towing/auth";
import { createTowingOrder } from "@/server/towing/creation";
import { assertTowingOrigin, boundedJson, towingErrorResponse, towingJson } from "@/server/towing/http";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    assertTowingOrigin(request);
    const actor = await requireTowingRequestActor(request);
    return towingJson(await createTowingOrder(actor, await boundedJson(request)));
  } catch (error) { return towingErrorResponse(error); }
}
