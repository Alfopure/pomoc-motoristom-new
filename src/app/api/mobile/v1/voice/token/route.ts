import { requireMobileActor } from "@/server/mobile/auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { nativeVoiceDeps } from "@/server/mobile/voice";
import { issueWebphoneToken } from "@/server/telephony/operator-devices";
import { readJsonBody } from "@/server/telephony/runtime";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const actor = await requireMobileActor(request);
    const deps = await nativeVoiceDeps(actor);
    const body = await readJsonBody<Record<string, unknown>>(request);
    const token = await issueWebphoneToken({ ...deps, deviceKind: "mobile" }, {
      organizationId: actor.organizationId, profileId: actor.profileId,
      deviceSessionId: typeof body.deviceSessionId === "string" ? body.deviceSessionId : null,
      userAgent: request.headers.get("user-agent"), takeover: body.takeover === true,
    });
    // The SIP password and provider credential ID never reach the app.
    return mobileJson({ ...mobileScope(actor), token: token.token, expiresAt: token.expiresAt, deviceSessionId: token.deviceSessionId });
  } catch (error) { return mobileError(error, "Telefón sa nepodarilo pripojiť."); }
}
