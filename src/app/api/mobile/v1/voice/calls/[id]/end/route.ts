import { requireMobileActor } from "@/server/mobile/auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { nativeVoiceDeps, requireNativeLease, requireNativeSession } from "@/server/mobile/voice";
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
    const session = await requireNativeSession(deps, actor, id);
    const result = await finishNativeHangup(deps, actor, session, deadline);
    return mobileJson({ ...mobileScope(actor), ...result }, result.terminationPending ? 202 : 200);
  } catch (error) { return mobileError(error, "Hovor sa nepodarilo ukončiť."); }
}
