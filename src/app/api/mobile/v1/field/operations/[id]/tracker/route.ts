import type { MobileDeliveryTracker } from "@/lib/mobile-api";
import { fieldScope, requireMobileMember } from "@/server/mobile/field-auth";
import { asMobileError, issueOperationTracker, revokeOperationTracker } from "@/server/mobile/field-work";
import { mobileError, mobileJson } from "@/server/mobile/http";

export const runtime = "nodejs";
/** A secret for sending the position of the own accepted operation in the background. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileMember(request);
    const payload: MobileDeliveryTracker = { ...fieldScope(actor), ...await issueOperationTracker(actor, (await context.params).id) };
    return mobileJson(payload);
  } catch (error) { return mobileError(asMobileError(error), "Zdieľanie polohy sa nepodarilo zapnúť."); }
}
/** Stops background sending for this operation, e.g. at logout. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileMember(request);
    return mobileJson({ ...fieldScope(actor), ...await revokeOperationTracker(actor, (await context.params).id) });
  } catch (error) { return mobileError(asMobileError(error), "Zdieľanie polohy sa nepodarilo vypnúť."); }
}
