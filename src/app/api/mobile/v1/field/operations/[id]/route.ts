import type { MobileOperationDetail } from "@/lib/mobile-api";
import { fieldScope, requireMobileMember } from "@/server/mobile/field-auth";
import { asMobileError, readFieldOperation } from "@/server/mobile/field-work";
import { mobileError, mobileJson } from "@/server/mobile/http";

export const runtime = "nodejs";
/** One own logistics operation with its evidence. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileMember(request);
    const payload: MobileOperationDetail = { ...fieldScope(actor), operation: await readFieldOperation(actor, (await context.params).id) };
    return mobileJson(payload);
  } catch (error) { return mobileError(asMobileError(error), "Jazdu sa nepodarilo načítať."); }
}
