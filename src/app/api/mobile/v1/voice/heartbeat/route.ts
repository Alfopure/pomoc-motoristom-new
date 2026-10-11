import { requireMobileActor } from "@/server/mobile/auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { NativeLeaseError, nativeVoiceDeps, requireNativeLease } from "@/server/mobile/voice";
import { touchDevice } from "@/server/telephony/operator-devices";
import { readJsonBody } from "@/server/telephony/runtime";
import { MutationError } from "@/server/mutation-error";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const actor = await requireMobileActor(request); const deps = await nativeVoiceDeps(actor);
    const body = await readJsonBody<Record<string, unknown>>(request);
    const device = await requireNativeLease(deps, actor, body.deviceSessionId);
    if (!["registered", "registering", "unregistered", "error"].includes(String(body.registrationState))) throw new MutationError("Neplatný stav telefónu.", 400);
    const result = await touchDevice({ ...deps, deviceKind: "mobile" }, {
      organizationId: actor.organizationId, profileId: actor.profileId, deviceSessionId: device.device_session_id!,
      registrationState: body.registrationState as typeof device.registration_state,
      nativeVoipRegistered: body.nativeVoipRegistered === true,
    });
    if (!result.ok) throw new NativeLeaseError("Telefón bol odpojený na inom zariadení.", 409);
    return mobileJson({ ...mobileScope(actor), registrationState: result.device.registration_state });
  } catch (error) { return mobileError(error, "Stav telefónu sa nepodarilo obnoviť."); }
}
