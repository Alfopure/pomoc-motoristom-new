import { requireMobileActor } from "@/server/mobile/auth";
import { readMobileJsonBody } from "@/server/mobile/body";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { nativeVoiceDeps } from "@/server/mobile/voice";
import { resolveNativeHold } from "@/server/mobile/voice-hold";
import { measureRequestStep, withRequestMetrics } from "@/server/request-metrics";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return withRequestMetrics("call.action", () => resolve(request, context), { operation: "mobile.hold-status" });
}
async function resolve(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await measureRequestStep("auth", () => requireMobileActor(request));
    const deps = await nativeVoiceDeps(actor, { cleanup: true });
    const body = await readMobileJsonBody(request);
    const { id } = await context.params;
    const result = await resolveNativeHold(deps, actor, id, body);
    return mobileJson({ ...mobileScope(actor), ...result });
  } catch (error) {
    return mobileError(error, "Výsledok podržania sa nepodarilo overiť.");
  }
}
