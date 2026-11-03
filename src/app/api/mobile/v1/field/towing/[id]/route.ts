import type { MobileTowingDetail } from "@/lib/mobile-api";
import { fieldScope, requireMobileMember } from "@/server/mobile/field-auth";
import { asMobileError, readFieldTowing } from "@/server/mobile/field-work";
import { mobileError, mobileJson } from "@/server/mobile/http";

export const runtime = "nodejs";
/** One own towing order in the driver projection. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileMember(request);
    const payload: MobileTowingDetail = { ...fieldScope(actor), order: await readFieldTowing(actor, (await context.params).id) };
    return mobileJson(payload);
  } catch (error) { return mobileError(asMobileError(error), "Zákazku sa nepodarilo načítať."); }
}
