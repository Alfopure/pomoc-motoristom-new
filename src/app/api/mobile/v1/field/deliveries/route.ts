import type { MobileDeliveries } from "@/lib/mobile-api";
import { loadDeliveries } from "@/server/mobile/delivery";
import { fieldScope, requireMobileFieldActor } from "@/server/mobile/field-auth";
import { mobileError, mobileJson } from "@/server/mobile/http";

export const runtime = "nodejs";
/** Deliveries sent to this pristavovač: open ones first, finished ones for a day. */
export async function GET(request: Request) {
  try {
    const actor = await requireMobileFieldActor(request);
    const payload: MobileDeliveries = { ...fieldScope(actor), deliveries: await loadDeliveries(actor) };
    return mobileJson(payload);
  } catch (error) { return mobileError(error, "Pristavenia sa nepodarilo načítať."); }
}
