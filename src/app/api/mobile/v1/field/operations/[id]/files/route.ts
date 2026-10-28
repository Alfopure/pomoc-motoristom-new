import type { MobileOperationFile } from "@/lib/mobile-api";
import { fieldScope, requireMobileMember } from "@/server/mobile/field-auth";
import { asMobileError, uploadFieldOperationFile } from "@/server/mobile/field-work";
import { mobileError, mobileJson } from "@/server/mobile/http";

export const runtime = "nodejs";
/** A photo or scan for an own open operation's doklad, as the raw body with its Content-Type. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileMember(request);
    const payload: MobileOperationFile = { ...fieldScope(actor), ...await uploadFieldOperationFile(actor, (await context.params).id, request) };
    return mobileJson(payload, 201);
  } catch (error) { return mobileError(asMobileError(error), "Fotografiu sa nepodarilo nahrať. Skúste znova."); }
}
