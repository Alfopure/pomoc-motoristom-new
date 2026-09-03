import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { buildPresenceSnapshot } from "@/server/telephony/active-calls";
import { listOperatorDevices } from "@/server/telephony/operator-devices";
import { getPresence, isManualPresenceStatus, listPresence, PresenceServiceError, setPresence } from "@/server/telephony/presence-service";
import {
  createTelephonyDeps,
  readJsonBody,
  readString,
  TELEPHONY_ROUTE_ROLES,
  telephonyConfiguredOrResponse,
  telephonyErrorResponse,
  type TelephonyRuntimeDeps,
} from "@/server/telephony/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function snapshotFor(deps: TelephonyRuntimeDeps, actor: { profileId: string; role: string }) {
  const now = (deps.now ?? (() => new Date()))();
  const [presence, devices, pauseReasons, own] = await Promise.all([
    listPresence({ admin: deps.admin }, deps.organizationId),
    listOperatorDevices({ admin: deps.admin, telnyx: deps.telnyx, environment: deps.environment }, deps.organizationId),
    deps.admin.from("motorist_pause_reasons").select("id, code, label, max_minutes, sort_order").eq("organization_id", deps.organizationId).eq("active", true).order("sort_order", { ascending: true }),
    getPresence({ admin: deps.admin }, { organizationId: deps.organizationId, profileId: actor.profileId }),
  ]);

  return {
    snapshot: buildPresenceSnapshot({
      actor: { profileId: actor.profileId, canManageAssignments: actor.role === "manager" || actor.role === "admin" || actor.role === "senior_dispatcher" },
      now,
      presence,
      devices,
    }),
    own: own
      ? {
          profileId: own.profile_id,
          status: own.status,
          pauseReasonId: own.pause_reason_id,
          currentSessionId: own.current_session_id,
          wrapUpUntil: own.wrap_up_until,
          statusSince: own.status_since,
        }
      : null,
    pauseReasons: pauseReasons.data ?? [],
  };
}

/** Operator presence snapshot for the console (provider-neutral shape, `src/lib/telephony/presence.ts`). */
export async function GET() {
  try {
    const actor = await requireDefaultMotoristActor(TELEPHONY_ROUTE_ROLES);
    const notConfigured = telephonyConfiguredOrResponse();
    if (notConfigured) return notConfigured;

    const deps = await createTelephonyDeps({ organizationId: actor.organizationId });
    return Response.json(await snapshotFor(deps, actor), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return telephonyErrorResponse(error, "Prezenciu sa nepodarilo načítať.");
  }
}

/** Manual presence change (`available` | `paused` | `offline`); refused during a call. */
export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(TELEPHONY_ROUTE_ROLES);
    const notConfigured = telephonyConfiguredOrResponse();
    if (notConfigured) return notConfigured;

    const body = await readJsonBody<{ status?: unknown; pauseReasonId?: unknown; reason?: unknown }>(request);
    const status = readString(body.status);
    if (!isManualPresenceStatus(status)) {
      throw new PresenceServiceError("Neplatný stav prezencie.", 400);
    }

    const deps = await createTelephonyDeps({ organizationId: actor.organizationId });
    await setPresence(
      { admin: deps.admin },
      {
        organizationId: deps.organizationId,
        profileId: actor.profileId,
        status,
        pauseReasonId: readString(body.pauseReasonId),
        reason: readString(body.reason),
        source: "dispatch_console",
      },
    );

    return Response.json({ ok: true, ...(await snapshotFor(deps, actor)) });
  } catch (error) {
    return telephonyErrorResponse(error, "Stav sa nepodarilo uložiť.");
  }
}
