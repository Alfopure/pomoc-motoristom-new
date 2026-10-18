import type { MobileVoiceCallbackStarted } from "@/lib/mobile-api";
import { requireMobileActor } from "@/server/mobile/auth";
import { readMobileJsonBody } from "@/server/mobile/body";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { nativeVoiceDeps, startNativeCallback } from "@/server/mobile/voice";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    const actor = await requireMobileActor(request);
    const deps = await nativeVoiceDeps(actor);
    const input = await readMobileJsonBody(request);
    const body: MobileVoiceCallbackStarted = { ...mobileScope(actor), ...await startNativeCallback(deps, actor, input) };
    return mobileJson(body);
  } catch (error) {
    return mobileError(error, "Spätné volanie sa nepodarilo vytočiť.");
  }
}
