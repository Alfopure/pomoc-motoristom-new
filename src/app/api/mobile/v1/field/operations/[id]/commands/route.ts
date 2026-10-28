import type { MobileOperationReceipt } from "@/lib/mobile-api";
import { readMobileJsonBody } from "@/server/mobile/body";
import { fieldScope, requireMobileMember } from "@/server/mobile/field-auth";
import { asMobileError, commandFieldOperation } from "@/server/mobile/field-work";
import { mobileError, mobileJson } from "@/server/mobile/http";

export const runtime = "nodejs";
/** Prijať, Začať, Som na mieste, Vozidlo prevzaté, Dokončiť or a doklad; the same command id replays its receipt. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileMember(request);
    const payload: MobileOperationReceipt = { ...fieldScope(actor), ...await commandFieldOperation(actor, (await context.params).id, await readMobileJsonBody(request)) };
    return mobileJson(payload);
  } catch (error) { return mobileError(asMobileError(error), "Krok jazdy sa nepodarilo potvrdiť. Zopakujte ho."); }
}
