import { requireMobileActor } from "@/server/mobile/auth";
import { readMobileJsonBody } from "@/server/mobile/body";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { nativeVoiceDeps } from "@/server/mobile/voice";
import { stopNativeRecording } from "@/server/mobile/voice-call-actions";

export const runtime = "nodejs";
export const maxDuration = 30;
/** Stops recording of the phone's own call, as promised to callers on request. A provider
 * failure keeps its details on the server; the dispatcher learns only that the stop is unconfirmed. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileActor(request);
    const deps = await nativeVoiceDeps(actor);
    const body = await readMobileJsonBody(request);
    const { id } = await context.params;
    return mobileJson({ ...mobileScope(actor), ...await stopNativeRecording(deps, actor, id, body) });
  } catch (error) {
    return mobileError(error, "Zastavenie nahrávania nie je potvrdené. Volajúcemu zatiaľ nehovorte, že sa nenahráva.");
  }
}
