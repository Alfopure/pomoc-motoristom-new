import { fieldScope, requireMobileMember } from "@/server/mobile/field-auth";
import { asMobileError, loadFieldTowingOptions } from "@/server/mobile/field-work";
import { mobileError, mobileJson } from "@/server/mobile/http";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try { const actor = await requireMobileMember(request); return mobileJson({ ...fieldScope(actor), ...await loadFieldTowingOptions(actor) }); }
  catch (error) { return mobileError(asMobileError(error), "Výbery odťahovej služby sa nepodarilo načítať."); }
}
