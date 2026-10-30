import { requireMobileActor } from "@/server/mobile/auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { nativeVoiceDeps, requireNativeCallCase, requireNativeLease } from "@/server/mobile/voice";
import { nativeOutboundInput } from "@/server/mobile/voice-input";
import { startOutboundCall } from "@/server/telephony/call-actions";
import { readJsonBody, toCallActor } from "@/server/telephony/runtime";
import { isUuid } from "@/lib/telephony/uuid";
import { MutationError } from "@/server/mutation-error";
import { measureRequestStep, withRequestMetrics } from "@/server/request-metrics";

export const runtime = "nodejs";
export const maxDuration = 60;
/** Measured like the web call start, so the phone's setup time gets the same per-step log line. */
export async function POST(request: Request) {
  return withRequestMetrics("call.start", () => start(request), { operation: "call.outbound" });
}
async function start(request: Request) {
  try {
    const actor = await measureRequestStep("auth", () => requireMobileActor(request)); const deps = await nativeVoiceDeps(actor);
    const body = await readJsonBody<Record<string, unknown>>(request);
    await requireNativeLease(deps, actor, body.deviceSessionId);
    if (typeof body.requestId !== "string" || !isUuid(body.requestId)) throw new MutationError("Chýba identita pokusu o volanie.", 400);
    if (body.verificationId !== undefined && (typeof body.verificationId !== "string" || !isUuid(body.verificationId))) throw new MutationError("Neplatné potvrdenie overeného čísla.", 400);
    if (body.caseId !== undefined && (typeof body.caseId !== "string" || !isUuid(body.caseId))) throw new MutationError("Neplatný prípad hovoru.", 400);
    const caseId = typeof body.caseId === "string" ? body.caseId.toLowerCase() : undefined;
    if (caseId) await requireNativeCallCase(deps, actor, caseId);
    const result = await startOutboundCall(deps, toCallActor(actor),
      nativeOutboundInput(body.requestId, typeof body.to === "string" ? body.to : "", body.verificationId as string | undefined, caseId));
    return mobileJson({ ...mobileScope(actor), sessionId: result.sessionId, operatorLegCallControlId: result.operatorLegCallControlId, to: result.to });
  } catch (error) { return mobileError(error, "Hovor sa nepodarilo vytočiť."); }
}
