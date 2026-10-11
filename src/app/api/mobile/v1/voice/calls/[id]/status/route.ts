import { requireMobileActor } from "@/server/mobile/auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { nativeVoiceDeps, requireNativeLease, requireNativeSession } from "@/server/mobile/voice";
import { readJsonBody } from "@/server/telephony/runtime";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileActor(request); const deps = await nativeVoiceDeps(actor, { cleanup: true });
    const body = await readJsonBody(request); const { id } = await context.params;
    await requireNativeLease(deps, actor, body.deviceSessionId, { cleanup: true });
    const session = await requireNativeSession(deps, actor, id, { readOffer: true });
    const ownConnected = session.answered_by_profile_id === actor.profileId || session.direction === "internal";
    return mobileJson({ ...mobileScope(actor), sessionId: id, state: session.state,
      connected: ownConnected && Boolean(session.answered_at) && session.state === "talking" && !session.ended_at && !session.termination_requested_at,
      ended: Boolean(session.ended_at), terminationPending: Boolean(session.termination_requested_at && !session.ended_at) });
  } catch (error) { return mobileError(error, "Stav hovoru sa nepodarilo overiť."); }
}
