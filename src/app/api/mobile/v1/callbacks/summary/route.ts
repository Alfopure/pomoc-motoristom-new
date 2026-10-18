import type { MobileCallbackSummary } from "@/lib/mobile-callbacks";
import { requireMobileActor } from "@/server/mobile/auth";
import { loadMobileCallbackSummary } from "@/server/mobile/callbacks";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { MutationError } from "@/server/mutation-error";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const actor = await requireMobileActor(request);
    if ([...new URL(request.url).searchParams.keys()].length) throw new MutationError("Neplatný výber spätných volaní.", 400);
    const payload: MobileCallbackSummary = { ...mobileScope(actor), counts: await loadMobileCallbackSummary(actor) };
    return mobileJson(payload);
  } catch (error) { return mobileError(error, "Počty spätných volaní sa nepodarilo načítať."); }
}
