import { after } from "next/server";
import { requireMobileActor } from "@/server/mobile/auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { nativeVoiceDeps, requireNativeLease, requireNativeSession } from "@/server/mobile/voice";
import { continueAcceptedHangup, hangupCall } from "@/server/telephony/call-actions";
import { readJsonBody, toCallActor } from "@/server/telephony/runtime";
import { withBackgroundRequestMetrics } from "@/server/request-metrics";
import { sessionOwnership } from "@/server/telephony/ownership";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const deadline = Date.now() + 55_000;
  try {
    const actor = await requireMobileActor(request); const deps = await nativeVoiceDeps(actor, { cleanup: true });
    const body = await readJsonBody(request); const { id } = await context.params;
    await requireNativeLease(deps, actor, body.deviceSessionId, { cleanup: true });
    await requireNativeSession(deps, actor, id);
    const result = await hangupCall(deps, toCallActor(actor), id);
    if (result.terminationPending) {
      after(withBackgroundRequestMetrics(() => sessionOwnership.exit(async () => {
        try { await continueAcceptedHangup(deps, id, deadline); } catch { /* Existing webhook/cron recovery retains the durable pending effects. */ }
      })));
    }
    return mobileJson({ ...mobileScope(actor), sessionId: id, terminationPending: result.terminationPending === true }, result.terminationPending ? 202 : 200);
  } catch (error) { return mobileError(error, "Hovor sa nepodarilo ukončiť."); }
}
