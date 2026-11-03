import type { MobileCallWrapUp } from "@/lib/mobile-call-wrap-up";
import { requireMobileActor } from "@/server/mobile/auth";
import { getMobileCallWrapUp } from "@/server/mobile/call-wrap-up";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { MutationError } from "@/server/mutation-error";

export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileActor(request);
    if (!request.headers.has("X-PM-Expected-Organization")) throw new MutationError("Obnovte organizáciu účtu.", 409, "expected_organization_mismatch");
    if ([...new URL(request.url).searchParams.keys()].length) throw new MutationError("Neplatný odkaz na hovor.", 400);
    const payload: MobileCallWrapUp = { ...mobileScope(actor), organizationId: actor.organizationId, ...await getMobileCallWrapUp(actor, (await context.params).id) };
    return mobileJson(payload);
  } catch (error) { return mobileError(error, "Údaje po hovore sa nepodarilo načítať."); }
}
