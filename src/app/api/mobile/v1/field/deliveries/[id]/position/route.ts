import type { MobileDeliveryPositionReceipt } from "@/lib/mobile-api";
import { readMobileJsonBody } from "@/server/mobile/body";
import { recordDeliveryPosition } from "@/server/mobile/delivery";
import { fieldScope, requireMobileFieldActor } from "@/server/mobile/field-auth";
import { mobileError, mobileJson } from "@/server/mobile/http";

export const runtime = "nodejs";
/** Where the pristavovač is during an accepted delivery, for the dispatcher. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileFieldActor(request);
    const result = await recordDeliveryPosition(actor, (await context.params).id, await readMobileJsonBody(request));
    const payload: MobileDeliveryPositionReceipt = { ...fieldScope(actor), ...result };
    return mobileJson(payload);
  } catch (error) { return mobileError(error, "Polohu sa nepodarilo odoslať."); }
}
