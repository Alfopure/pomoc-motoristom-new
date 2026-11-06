import { fieldScope, requireMobileMember } from "@/server/mobile/field-auth";
import { asMobileError, loadFieldCash } from "@/server/mobile/field-work";
import { mobileError, mobileJson } from "@/server/mobile/http";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { const actor = await requireMobileMember(request); return mobileJson({ ...fieldScope(actor), cash: await loadFieldCash(actor) }); }
  catch (error) { return mobileError(asMobileError(error), "Vašu pokladňu sa nepodarilo načítať."); }
}
