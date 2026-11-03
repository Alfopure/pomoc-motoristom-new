import type { MobileVoiceAttemptEnded } from "@/lib/mobile-api";
import { requireMobileActor } from "@/server/mobile/auth";
import { readMobileJsonBody } from "@/server/mobile/body";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { nativeVoiceDeps, resolveNativeAttempt } from "@/server/mobile/voice";
import { finishNativeHangup } from "@/server/mobile/voice-hangup";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  const deadline = Date.now() + 55_000;
  try {
    const actor = await requireMobileActor(request);
    const deps = await nativeVoiceDeps(actor, { cleanup: true });
    const session = await resolveNativeAttempt(deps, actor, await readMobileJsonBody(request));
    if (!session) {
      const body: MobileVoiceAttemptEnded = { ...mobileScope(actor), resolved: false, sessionId: null, terminationPending: false };
      return mobileJson(body, 202);
    }
    const result = await finishNativeHangup(deps, actor, session, deadline);
    const body: MobileVoiceAttemptEnded = { ...mobileScope(actor), resolved: true, ...result };
    return mobileJson(body, result.terminationPending ? 202 : 200);
  } catch (error) {
    return mobileError(error, "Pôvodný pokus o volanie sa nepodarilo ukončiť.");
  }
}
