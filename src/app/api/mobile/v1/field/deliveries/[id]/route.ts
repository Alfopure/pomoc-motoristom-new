import type { MobileDeliveryDetail } from "@/lib/mobile-api";
import { readDelivery } from "@/server/mobile/delivery";
import { fieldScope, requireMobileFieldActor } from "@/server/mobile/field-auth";
import { mobileError, mobileJson } from "@/server/mobile/http";

export const runtime = "nodejs";
/** One delivery; opening it tells the dispatcher it was seen. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileFieldActor(request);
    const payload: MobileDeliveryDetail = { ...fieldScope(actor), delivery: await readDelivery(actor, (await context.params).id) };
    return mobileJson(payload);
  } catch (error) { return mobileError(error, "Pristavenie sa nepodarilo načítať."); }
}
