import { requireMobileActor } from "@/server/mobile/auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { nativeVoiceDeps } from "@/server/mobile/voice";
import { assertRateLimit, rateLimitKey } from "@/server/rate-limit";
import { measureRequestStep, withRequestMetrics } from "@/server/request-metrics";
import { latencyFlagsOf, mobileVoiceTuning } from "@/server/telephony/latency-flags";
import { issueWebphoneToken, refuseIfAccessLost } from "@/server/telephony/operator-devices";
import { readJsonBody } from "@/server/telephony/runtime";

export const runtime = "nodejs";
const TOKEN_RATE_MESSAGE = "Telefón sa pripája príliš často. Skúste to o chvíľu.";
/** On the push-wake path: measured so the phone's connect time has a server half. */
export async function POST(request: Request) {
  return withRequestMetrics("call.token", () => issue(request), { operation: "mobile.voice-token" });
}
async function issue(request: Request) {
  try {
    const actor = await measureRequestStep("auth", () => requireMobileActor(request));
    const body = await readJsonBody<Record<string, unknown>>(request);
    // Every request mints a JWT; TEST shares its Telnyx account with production. Credential
    // rotations have their own, tighter limit inside issueWebphoneToken, whatever the route.
    assertRateLimit(rateLimitKey("mobile-voice-token", actor.profileId), { limit: 30, windowMs: 5 * 60_000, message: TOKEN_RATE_MESSAGE });
    const deps = await nativeVoiceDeps(actor);
    const flags = latencyFlagsOf(deps);
    // Every connect carries the phone's switches (S8): a push wake uses the last ones it saw.
    const voiceTuning = mobileVoiceTuning(flags);
    const device = { ...deps, deviceKind: "mobile" as const }, identity = { organizationId: actor.organizationId, profileId: actor.profileId };
    const token = await issueWebphoneToken(device, { ...identity,
      deviceSessionId: typeof body.deviceSessionId === "string" ? body.deviceSessionId : null,
      userAgent: request.headers.get("user-agent"), takeover: body.takeover === true,
      rotateCredential: flags.mobile_rotate_on_takeover, tokenCache: voiceTuning.mobileTokenCache,
    });
    // A deactivation or removal that landed during the mint revokes this enrollment instead.
    await refuseIfAccessLost(device, identity, token);
    // The SIP password and provider credential ID never reach the app.
    return mobileJson({ ...mobileScope(actor), token: token.token, expiresAt: token.expiresAt, deviceSessionId: token.deviceSessionId, voiceTuning,
      // Only a refetch signal is read from this private topic, never its payload (S8.5).
      ...(voiceTuning.mobileRealtimeStatus ? { realtimeTopic: `org:${actor.organizationId}:telephony` } : {}) });
  } catch (error) { return mobileError(error, "Telefón sa nepodarilo pripojiť."); }
}
