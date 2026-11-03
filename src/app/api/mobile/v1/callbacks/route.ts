import type { MobileCallbacks } from "@/lib/mobile-callbacks";
import { requireMobileActor } from "@/server/mobile/auth";
import { loadMobileCallbacks, parseCallbackListQuery } from "@/server/mobile/callbacks";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { MutationError } from "@/server/mutation-error";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const actor = await requireMobileActor(request);
    if (!request.headers.has("X-PM-Expected-Organization")) throw new MutationError("Obnovte organizáciu účtu.", 409, "expected_organization_mismatch");
    const { cursor } = parseCallbackListQuery(new URL(request.url).searchParams);
    const payload: MobileCallbacks = { ...mobileScope(actor), organizationId: actor.organizationId, ...await loadMobileCallbacks(actor, cursor) };
    return mobileJson(payload);
  } catch (error) { return mobileError(error, "Spätné volania sa nepodarilo načítať."); }
}
