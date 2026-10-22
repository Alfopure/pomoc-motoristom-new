import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { readMobileJsonBody } from "@/server/mobile/body";
import { fieldScope, requireMobilePerson } from "@/server/mobile/field-auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { registerMobilePush } from "@/server/mobile/push";

export const runtime = "nodejs";
/** Registers this installation for push notifications or changes its switches;
 * for a dispatcher or a pristavovač. */
export async function POST(request: Request) {
  try {
    const person = await requireMobilePerson(request);
    const owner = person.kind === "field" ? { organizationId: person.actor.organizationId, memberId: person.actor.memberId } : person.actor;
    const result = await registerMobilePush(createSupabaseAdminClient(), owner, await readMobileJsonBody(request));
    return mobileJson({ ...(person.kind === "field" ? fieldScope(person.actor) : mobileScope(person.actor)), ...result });
  } catch (error) { return mobileError(error, "Upozornenia sa nepodarilo uložiť."); }
}
