import { requireMobileActor } from "@/server/mobile/auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { getMobileCallContext, parseCallContextTarget } from "@/server/mobile/call-context";
import { MutationError } from "@/server/mutation-error";
import type { MobileCallContext } from "@/lib/mobile-call-context";

export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileActor(request);
    if (!request.headers.has("X-PM-Expected-Organization")) throw new MutationError("Obnovte organizáciu účtu.", 409, "expected_organization_mismatch");
    const target = parseCallContextTarget((await context.params).id, new URL(request.url).searchParams);
    const result: MobileCallContext = { ...mobileScope(actor), organizationId: actor.organizationId, ...await getMobileCallContext(actor, target, request.signal) };
    return mobileJson(result);
  } catch (error) { return mobileError(error, "Detail hovoru sa nepodarilo načítať."); }
}
