import { requireMobileActor } from "@/server/mobile/auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { nativeVoiceDeps, requireNativeLease } from "@/server/mobile/voice";
import { readJsonBody } from "@/server/telephony/runtime";
import { readNativeCallStatus } from "@/server/mobile/voice-hold";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMobileActor(request); const deps = await nativeVoiceDeps(actor, { cleanup: true });
    const body = await readJsonBody(request); const { id } = await context.params;
    await requireNativeLease(deps, actor, body.deviceSessionId, { cleanup: true });
    return mobileJson({ ...mobileScope(actor), ...await readNativeCallStatus(deps, actor, id, String(body.deviceSessionId)) });
  } catch (error) { return mobileError(error, "Stav hovoru sa nepodarilo overiť."); }
}
