import type { MobileCaseOverview } from "@/lib/mobile-api";
import { requireMobileActor } from "@/server/mobile/auth";
import { getMobileCaseOverview } from "@/server/mobile/case-overview";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { MutationError } from "@/server/mutation-error";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const actor = await requireMobileActor(request);
    if (new URL(request.url).searchParams.size !== 0) {
      throw new MutationError("Prehľad prípadov neprijíma filtre.", 400);
    }
    const counts = await getMobileCaseOverview(actor, request.signal);
    const body: MobileCaseOverview = { ...mobileScope(actor), counts };
    return mobileJson(body);
  } catch (error) {
    return mobileError(error, "Prehľad prípadov sa nepodarilo načítať.");
  }
}
