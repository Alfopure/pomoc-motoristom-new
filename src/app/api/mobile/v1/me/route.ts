import type { MobileMe } from "@/lib/mobile-api";
import { requireMobileActor } from "@/server/mobile/auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const actor = await requireMobileActor(request);
    const payload: MobileMe = {
      ...mobileScope(actor),
      profile: { id: actor.profileId, displayName: actor.displayName, email: actor.email ?? null, role: actor.role },
      capabilities: { voice: false, presenceWrite: false },
    };
    return mobileJson(payload);
  } catch (error) { return mobileError(error, "Účet sa nepodarilo načítať."); }
}
