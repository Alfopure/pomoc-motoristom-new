import type { MobileTowingAttachmentReceipt } from "@/lib/mobile-api";
import { fieldScope, requireMobileMember } from "@/server/mobile/field-auth";
import { asMobileError, uploadFieldTowingAttachment } from "@/server/mobile/field-work";
import { mobileError, mobileJson } from "@/server/mobile/http";

export const runtime = "nodejs";
/** A work or handover photo or a paper scan for an own towing order (multipart, replay-safe ids). */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileMember(request);
    const payload: MobileTowingAttachmentReceipt = { ...fieldScope(actor), ...await uploadFieldTowingAttachment(actor, (await context.params).id, request) };
    return mobileJson(payload);
  } catch (error) { return mobileError(asMobileError(error), "Prílohu sa nepodarilo nahrať. Skúste znova."); }
}
