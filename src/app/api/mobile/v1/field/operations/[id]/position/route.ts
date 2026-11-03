import type { MobileOperationPositionReceipt } from "@/lib/mobile-api";
import { readMobileJsonBody } from "@/server/mobile/body";
import { fieldScope, requireMobileMember } from "@/server/mobile/field-auth";
import { asMobileError, recordOperationPosition } from "@/server/mobile/field-work";
import { mobileError, mobileJson } from "@/server/mobile/http";

export const runtime = "nodejs";
/** Where the executor is during their own accepted operation; `active` false tells the phone to stop. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileMember(request);
    const payload: MobileOperationPositionReceipt = { ...fieldScope(actor), ...await recordOperationPosition(actor, (await context.params).id, await readMobileJsonBody(request)) };
    return mobileJson(payload);
  } catch (error) { return mobileError(asMobileError(error), "Polohu sa nepodarilo odoslať."); }
}
