import { requireMobileActor } from "@/server/mobile/auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { nativeVoiceDeps, requireNativeLease } from "@/server/mobile/voice";
import { startOutboundCall } from "@/server/telephony/call-actions";
import { readJsonBody, toCallActor } from "@/server/telephony/runtime";
import { isUuid } from "@/lib/telephony/uuid";
import { MutationError } from "@/server/mutation-error";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    const actor = await requireMobileActor(request); const deps = await nativeVoiceDeps(actor);
    const body = await readJsonBody<Record<string, unknown>>(request);
    await requireNativeLease(deps, actor, body.deviceSessionId);
    if (typeof body.requestId !== "string" || !isUuid(body.requestId)) throw new MutationError("Chýba identita pokusu o volanie.", 400);
    const result = await startOutboundCall(deps, toCallActor(actor), {
      requestId: body.requestId as string, to: typeof body.to === "string" ? body.to : "",
    });
    return mobileJson({ ...mobileScope(actor), sessionId: result.sessionId, operatorLegCallControlId: result.operatorLegCallControlId, to: result.to });
  } catch (error) { return mobileError(error, "Hovor sa nepodarilo vytočiť."); }
}
