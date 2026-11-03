import type { MobileCallbackChanged } from "@/lib/mobile-callbacks";
import { requireMobileActor } from "@/server/mobile/auth";
import { claimMobileCallback, parseCallbackId } from "@/server/mobile/callbacks";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { MutationError } from "@/server/mutation-error";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileActor(request);
    if (!request.headers.has("X-PM-Expected-Organization")) throw new MutationError("Obnovte organizáciu účtu.", 409, "expected_organization_mismatch");
    const id = parseCallbackId((await context.params).id);
    const payload: MobileCallbackChanged = { ...mobileScope(actor), organizationId: actor.organizationId, request: await claimMobileCallback(actor, id) };
    return mobileJson(payload);
  } catch (error) { return mobileError(error, "Prevzatie požiadavky zlyhalo."); }
}
