import type { MobileDeliveryReceipt } from "@/lib/mobile-api";
import { readMobileJsonBody } from "@/server/mobile/body";
import { commandDelivery } from "@/server/mobile/delivery";
import { fieldScope, requireMobileFieldActor } from "@/server/mobile/field-auth";
import { mobileError, mobileJson } from "@/server/mobile/http";

export const runtime = "nodejs";
/** Prijať, Odmietnuť, Na ceste, Na mieste, Dokončiť, čas príchodu alebo problém. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileFieldActor(request);
    const result = await commandDelivery(actor, (await context.params).id, await readMobileJsonBody(request));
    const payload: MobileDeliveryReceipt = { ...fieldScope(actor), ...result };
    return mobileJson(payload);
  } catch (error) { return mobileError(error, "Krok pristavenia sa nepodarilo potvrdiť. Zopakujte ho."); }
}
