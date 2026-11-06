import { readMobileJsonBody } from "@/server/mobile/body";
import { fieldScope, requireMobileMember } from "@/server/mobile/field-auth";
import { asMobileError, commandFieldCash } from "@/server/mobile/field-work";
import { mobileError, mobileJson } from "@/server/mobile/http";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try { const actor = await requireMobileMember(request); return mobileJson({ ...fieldScope(actor), ...await commandFieldCash(actor, await readMobileJsonBody(request)) }); }
  catch (error) { return mobileError(asMobileError(error), "Odovzdanie hotovosti sa nepodarilo potvrdiť. Overte rovnaký krok."); }
}
