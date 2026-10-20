import { requireMobileActor } from "@/server/mobile/auth";
import { readMobileJsonBody } from "@/server/mobile/body";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { nativeVoiceDeps } from "@/server/mobile/voice";
import { listNativeTransferTargets } from "@/server/mobile/voice-call-actions";

export const runtime = "nodejs";
export const maxDuration = 30;
/** POST like every native call read: the exact device lease is part of the request. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileActor(request);
    const deps = await nativeVoiceDeps(actor);
    const body = await readMobileJsonBody(request);
    const { id } = await context.params;
    return mobileJson({ ...mobileScope(actor), ...await listNativeTransferTargets(deps, actor, id, body) });
  } catch (error) {
    return mobileError(error, "Kolegov na prepojenie sa nepodarilo načítať.");
  }
}
