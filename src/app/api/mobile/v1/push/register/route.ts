import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { readMobileJsonBody } from "@/server/mobile/body";
import { fieldScope, requireMobilePerson } from "@/server/mobile/field-auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { registerMobilePush } from "@/server/mobile/push";

export const runtime = "nodejs";
/** Registers this installation for push notifications or changes its switches;
 * for a dispatcher, a pristavovač or someone who is both. */
export async function POST(request: Request) {
  try {
    const { dispatcher, field } = await requireMobilePerson(request);
    const owner = { organizationId: (dispatcher ?? field)!.organizationId, profileId: dispatcher?.profileId ?? null, memberId: field?.memberId ?? null };
    const result = await registerMobilePush(createSupabaseAdminClient(), owner, await readMobileJsonBody(request));
    return mobileJson({ ...(dispatcher ? mobileScope(dispatcher) : fieldScope(field!)), ...result });
  } catch (error) { return mobileError(error, "Upozornenia sa nepodarilo uložiť."); }
}
