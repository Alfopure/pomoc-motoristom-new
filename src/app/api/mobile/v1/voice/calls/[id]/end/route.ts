import { requireMobileActor } from "@/server/mobile/auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { nativeHandedAway, nativeVoiceDeps, requireNativeLease, requireNativeSession } from "@/server/mobile/voice";
import { MutationError } from "@/server/mutation-error";
import { finishNativeHangup } from "@/server/mobile/voice-hangup";
import { readJsonBody } from "@/server/telephony/runtime";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const deadline = Date.now() + 55_000;
  try {
    const actor = await requireMobileActor(request); const deps = await nativeVoiceDeps(actor, { cleanup: true });
    const body = await readJsonBody(request); const { id } = await context.params;
    await requireNativeLease(deps, actor, body.deviceSessionId, { cleanup: true });
    let session: Awaited<ReturnType<typeof requireNativeSession>>;
    try { session = await requireNativeSession(deps, actor, id); }
    catch (error) {
      // After a transfer the phone's own leg is already gone; there is nothing to end here.
      if (error instanceof MutationError && error.status === 403 && await nativeHandedAway(deps, actor, id)) {
        return mobileJson({ ...mobileScope(actor), sessionId: id, terminationPending: false });
      }
      throw error;
    }
    const result = await finishNativeHangup(deps, actor, session, deadline);
    return mobileJson({ ...mobileScope(actor), ...result }, result.terminationPending ? 202 : 200);
  } catch (error) { return mobileError(error, "Hovor sa nepodarilo ukončiť."); }
}
