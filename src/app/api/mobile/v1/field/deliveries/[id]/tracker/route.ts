import type { MobileDeliveryTracker } from "@/lib/mobile-api";
import { issueDeliveryTracker, revokeDeliveryTracker } from "@/server/mobile/delivery";
import { fieldScope, requireMobileFieldActor } from "@/server/mobile/field-auth";
import { mobileError, mobileJson } from "@/server/mobile/http";

export const runtime = "nodejs";
/** A secret for sending this delivery's position in the background. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileFieldActor(request);
    const tracker = await issueDeliveryTracker(actor, (await context.params).id);
    const payload: MobileDeliveryTracker = { ...fieldScope(actor), ...tracker };
    return mobileJson(payload);
  } catch (error) { return mobileError(error, "Zdieľanie polohy sa nepodarilo zapnúť."); }
}
/** Stops background sending for this delivery, e.g. at logout. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileFieldActor(request);
    return mobileJson({ ...fieldScope(actor), ...await revokeDeliveryTracker(actor, (await context.params).id) });
  } catch (error) { return mobileError(error, "Zdieľanie polohy sa nepodarilo vypnúť."); }
}
