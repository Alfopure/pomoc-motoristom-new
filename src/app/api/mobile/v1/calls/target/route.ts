import type { MobileCallTarget } from "@/lib/mobile-callbacks";
import { requireMobileActor } from "@/server/mobile/auth";
import { parseCallTargetQuery, resolveMobileCallTarget } from "@/server/mobile/callbacks";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const actor = await requireMobileActor(request);
    const number = parseCallTargetQuery(new URL(request.url).searchParams);
    const payload: MobileCallTarget = { ...mobileScope(actor), target: await resolveMobileCallTarget(actor, number) };
    return mobileJson(payload);
  } catch (error) { return mobileError(error, "Číslo na volanie sa nepodarilo overiť."); }
}
