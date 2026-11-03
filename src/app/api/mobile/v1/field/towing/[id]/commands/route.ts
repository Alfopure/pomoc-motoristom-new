import type { MobileTowingReceipt } from "@/lib/mobile-api";
import { readMobileJsonBody } from "@/server/mobile/body";
import { fieldScope, requireMobileMember } from "@/server/mobile/field-auth";
import { asMobileError, commandFieldTowing } from "@/server/mobile/field-work";
import { mobileError, mobileJson } from "@/server/mobile/http";

export const runtime = "nodejs";
/** Začať prácu, the driver's own fields, or Odovzdať na kontrolu; pricing and billing stay on the web. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileMember(request);
    const payload: MobileTowingReceipt = { ...fieldScope(actor), ...await commandFieldTowing(actor, (await context.params).id, await readMobileJsonBody(request)) };
    return mobileJson(payload);
  } catch (error) { return mobileError(asMobileError(error), "Krok zákazky sa nepodarilo potvrdiť. Zopakujte ho."); }
}
