import type { MobileVoiceInternalStarted } from "@/lib/mobile-api";
import { requireMobileActor } from "@/server/mobile/auth";
import { readMobileJsonBody } from "@/server/mobile/body";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { nativeVoiceDeps, startNativeInternalCall } from "@/server/mobile/voice";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    const actor = await requireMobileActor(request);
    const deps = await nativeVoiceDeps(actor);
    const input = await readMobileJsonBody(request);
    const body: MobileVoiceInternalStarted = { ...mobileScope(actor), ...await startNativeInternalCall(deps, actor, input) };
    return mobileJson(body);
  } catch (error) {
    return mobileError(error, "Hovor kolegovi sa nepodarilo vytočiť.");
  }
}
