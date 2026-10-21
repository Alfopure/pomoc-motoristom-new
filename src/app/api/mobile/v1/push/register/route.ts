import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireMobileActor } from "@/server/mobile/auth";
import { readMobileJsonBody } from "@/server/mobile/body";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { registerMobilePush } from "@/server/mobile/push";

export const runtime = "nodejs";
/** Registers this installation for push notifications or changes its switches. */
export async function POST(request: Request) {
  try {
    const actor = await requireMobileActor(request);
    const result = await registerMobilePush(createSupabaseAdminClient(), actor, await readMobileJsonBody(request));
    return mobileJson({ ...mobileScope(actor), ...result });
  } catch (error) { return mobileError(error, "Upozornenia sa nepodarilo uložiť."); }
}
