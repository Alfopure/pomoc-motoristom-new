import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireMobileActor } from "@/server/mobile/auth";
import { readMobileJsonBody } from "@/server/mobile/body";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { unregisterMobilePush } from "@/server/mobile/push";

export const runtime = "nodejs";
/** Stops push notifications to this installation, e.g. at logout. */
export async function POST(request: Request) {
  try {
    const actor = await requireMobileActor(request);
    const result = await unregisterMobilePush(createSupabaseAdminClient(), actor, await readMobileJsonBody(request));
    return mobileJson({ ...mobileScope(actor), ...result });
  } catch (error) { return mobileError(error, "Upozornenia sa nepodarilo vypnúť."); }
}
