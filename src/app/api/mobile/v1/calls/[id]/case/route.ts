import type { MobileCallCaseLinked } from "@/lib/mobile-call-wrap-up";
import { requireMobileActor } from "@/server/mobile/auth";
import { readMobileJsonBody } from "@/server/mobile/body";
import { linkMobileCallCase, parseCallCase, parseCallId } from "@/server/mobile/call-wrap-up";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { MutationError } from "@/server/mutation-error";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileActor(request);
    if (!request.headers.has("X-PM-Expected-Organization")) throw new MutationError("Obnovte organizáciu účtu.", 409, "expected_organization_mismatch");
    const id = parseCallId((await context.params).id);
    const input = parseCallCase(await readMobileJsonBody(request));
    const payload: MobileCallCaseLinked = { ...mobileScope(actor), organizationId: actor.organizationId, ...await linkMobileCallCase(actor, id, input) };
    return mobileJson(payload);
  } catch (error) { return mobileError(error, "Hovor sa nepodarilo priradiť k prípadu."); }
}
