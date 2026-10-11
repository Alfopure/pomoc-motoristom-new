import { requireMobileActor } from "@/server/mobile/auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { authorizeNativeOffer, nativeVoiceDeps } from "@/server/mobile/voice";
import { readJsonBody } from "@/server/telephony/runtime";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const actor = await requireMobileActor(request); const deps = await nativeVoiceDeps(actor);
    const result = await authorizeNativeOffer(deps, actor, await readJsonBody(request));
    return mobileJson({ ...mobileScope(actor), ...result });
  } catch (error) { return mobileError(error, "Ponuku hovoru sa nepodarilo overiť."); }
}
