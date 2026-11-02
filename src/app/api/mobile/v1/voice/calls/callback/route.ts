import type { MobileVoiceCallbackStarted } from "@/lib/mobile-api";
import { requireMobileActor } from "@/server/mobile/auth";
import { readMobileJsonBody } from "@/server/mobile/body";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { nativeVoiceDeps, startNativeCallback, type NativeCallbackStarted } from "@/server/mobile/voice";
import { respondWhenDialled } from "@/server/telephony/early-start";

export const runtime = "nodejs";
/** Also covers the bookkeeping that may follow an early response (`respondWhenDialled`). */
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    const actor = await requireMobileActor(request);
    const deps = await nativeVoiceDeps(actor);
    const input = await readMobileJsonBody(request);
    const body: MobileVoiceCallbackStarted = { ...mobileScope(actor), ...await respondWhenDialled<NativeCallbackStarted>(deps, (...early) => startNativeCallback(deps, actor, input, ...early)) };
    return mobileJson(body);
  } catch (error) {
    return mobileError(error, "Spätné volanie sa nepodarilo vytočiť.");
  }
}
