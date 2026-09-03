import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { touchDevice } from "@/server/telephony/operator-devices";
import {
  createTelephonyDeps,
  readJsonBody,
  readString,
  TELEPHONY_ROUTE_ROLES,
  telephonyConfiguredOrResponse,
  telephonyErrorResponse,
} from "@/server/telephony/runtime";
import type { DeviceRow } from "@/server/telephony/state/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REGISTRATION_STATES = new Set<DeviceRow["registration_state"]>(["registered", "registering", "unregistered", "error"]);

/**
 * Browser-phone heartbeat (also sent via `navigator.sendBeacon` on
 * `visibilitychange`). A heartbeat from a superseded tab gets 409 so that tab
 * can disconnect itself: only the newest `device_session_id` is live.
 */
export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(TELEPHONY_ROUTE_ROLES);
    const notConfigured = telephonyConfiguredOrResponse();
    if (notConfigured) return notConfigured;

    const body = await readJsonBody<{ deviceSessionId?: unknown; registrationState?: unknown }>(request);
    const deviceSessionId = readString(body.deviceSessionId);
    if (!deviceSessionId) {
      return Response.json({ error: "Chýba identifikátor relácie zariadenia." }, { status: 400 });
    }
    const registrationState = readString(body.registrationState) as DeviceRow["registration_state"] | null;

    const deps = await createTelephonyDeps({ organizationId: actor.organizationId });
    const result = await touchDevice(
      { admin: deps.admin, telnyx: deps.telnyx, environment: deps.environment },
      {
        organizationId: deps.organizationId,
        profileId: actor.profileId,
        deviceSessionId,
        registrationState: registrationState && REGISTRATION_STATES.has(registrationState) ? registrationState : undefined,
        userAgent: request.headers.get("user-agent"),
      },
    );

    if (!result.ok) {
      return Response.json(
        {
          error: result.reason === "stale_session" ? "Telefón bol prihlásený v inom okne." : "Zariadenie nie je zaregistrované.",
          reason: result.reason,
        },
        { status: 409 },
      );
    }

    return Response.json({ ok: true, seenAt: result.device.device_seen_at, registrationState: result.device.registration_state });
  } catch (error) {
    return telephonyErrorResponse(error, "Heartbeat sa nepodarilo uložiť.");
  }
}
