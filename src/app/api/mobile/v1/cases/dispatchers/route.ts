import type { MobileCaseDispatchers } from "@/lib/mobile-api";
import { requireMobileActor } from "@/server/mobile/auth";
import { listMobileCaseDispatchers } from "@/server/mobile/cases";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const actor = await requireMobileActor(request);
    const dispatchers = await listMobileCaseDispatchers(actor, request.signal);
    const body: MobileCaseDispatchers = { ...mobileScope(actor), dispatchers };
    return mobileJson(body);
  } catch (error) { return mobileError(error, "Dispečerov sa nepodarilo načítať."); }
}
