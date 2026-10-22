import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { readMobileJsonBody } from "@/server/mobile/body";
import { fieldScope, requireMobilePerson } from "@/server/mobile/field-auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { unregisterMobilePush } from "@/server/mobile/push";

export const runtime = "nodejs";
/** Stops push notifications to this installation, e.g. at logout. */
export async function POST(request: Request) {
  try {
    const { dispatcher, field } = await requireMobilePerson(request);
    const result = await unregisterMobilePush(createSupabaseAdminClient(), await readMobileJsonBody(request));
    return mobileJson({ ...(dispatcher ? mobileScope(dispatcher) : fieldScope(field!)), ...result });
  } catch (error) { return mobileError(error, "Upozornenia sa nepodarilo vypnúť."); }
}
