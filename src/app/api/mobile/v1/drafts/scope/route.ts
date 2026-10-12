import type { MobileDraftScope } from "@/lib/mobile-api";
import { requireMobileActor } from "@/server/mobile/auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const actor = await requireMobileActor(request);
    const body: MobileDraftScope = { ...mobileScope(actor), organizationId: actor.organizationId };
    return mobileJson(body);
  } catch (error) {
    return mobileError(error, "Rozsah rozpracovaných údajov sa nepodarilo overiť.");
  }
}
