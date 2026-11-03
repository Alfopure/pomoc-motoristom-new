import { requireMobileActor } from "@/server/mobile/auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { nativeVoiceDeps, requireNativeLease } from "@/server/mobile/voice";
import { disconnectDevice } from "@/server/telephony/operator-devices";
import { readJsonBody } from "@/server/telephony/runtime";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const actor = await requireMobileActor(request); const deps = await nativeVoiceDeps(actor, { cleanup: true });
    const body = await readJsonBody(request);
    const device = await requireNativeLease(deps, actor, body.deviceSessionId, { cleanup: true });
    await disconnectDevice({ ...deps, deviceKind: "mobile" }, { organizationId: actor.organizationId, profileId: actor.profileId, deviceSessionId: device.device_session_id! });
    return mobileJson(mobileScope(actor));
  } catch (error) { return mobileError(error, "Prístup telefónu sa nepodarilo zrušiť."); }
}
