import type { MobileFieldMe } from "@/lib/mobile-api";
import { fieldScope, requireMobileFieldActor } from "@/server/mobile/field-auth";
import { mobileError, mobileJson } from "@/server/mobile/http";

export const runtime = "nodejs";
/** The pristavovač signed in on this phone; a field member, not a dispatcher. */
export async function GET(request: Request) {
  try {
    const actor = await requireMobileFieldActor(request);
    const payload: MobileFieldMe = { ...fieldScope(actor), member: { id: actor.memberId, displayName: actor.displayName, email: actor.email } };
    return mobileJson(payload);
  } catch (error) { return mobileError(error, "Účet sa nepodarilo načítať."); }
}
