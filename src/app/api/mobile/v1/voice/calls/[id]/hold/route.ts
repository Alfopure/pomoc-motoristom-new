import { requireMobileActor } from "@/server/mobile/auth";
import { readMobileJsonBody } from "@/server/mobile/body";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { nativeVoiceDeps } from "@/server/mobile/voice";
import { changeNativeHold } from "@/server/mobile/voice-hold";
import { measureRequestStep, withRequestMetrics } from "@/server/request-metrics";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return withRequestMetrics("call.action", () => hold(request, context), { operation: "mobile.hold" });
}
async function hold(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await measureRequestStep("auth", () => requireMobileActor(request));
    const deps = await nativeVoiceDeps(actor);
    const body = await readMobileJsonBody(request);
    const { id } = await context.params;
    const result = await changeNativeHold(deps, actor, id, body);
    return mobileJson({ ...mobileScope(actor), ...result });
  } catch (error) {
    return mobileError(error, "Podržanie hovoru sa nepodarilo potvrdiť.");
  }
}
