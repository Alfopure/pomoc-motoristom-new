import { randomUUID } from "node:crypto";
import { requireMobileActor } from "@/server/mobile/auth";
import { mobileError, mobileJson, mobileScope } from "@/server/mobile/http";
import { nativeVoiceDeps, requireNativeLease } from "@/server/mobile/voice";
import { isManualPresenceStatus, PresenceServiceError, setPresence } from "@/server/telephony/presence-service";
import { runSessionEvent } from "@/server/telephony/session-runner";
import { readJsonBody } from "@/server/telephony/runtime";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const actor = await requireMobileActor(request); const deps = await nativeVoiceDeps(actor);
    const body = await readJsonBody(request);
    await requireNativeLease(deps, actor, body.deviceSessionId);
    if (!isManualPresenceStatus(body.status)) throw new PresenceServiceError("Neplatný stav prezencie.", 400);
    const presence = await setPresence({ admin: deps.admin, now: deps.now, onOfferCancelled: async sessionId => {
      await runSessionEvent(deps, sessionId, { kind: "app", type: "sweep", id: randomUUID(), actorProfileId: actor.profileId,
        occurredAt: (deps.now?.() ?? new Date()).toISOString() });
    } }, { organizationId: actor.organizationId, profileId: actor.profileId, status: body.status, source: "native_mobile" });
    return mobileJson({ ...mobileScope(actor), status: presence.status });
  } catch (error) { return mobileError(error, "Stav v ústredni sa nepodarilo zmeniť."); }
}
