import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { auditOperatorDeviceAction } from "@/server/telephony/config-service";
import { CONFIG_WRITE_ROLES, configErrorResponse, toConfigActor } from "@/server/telephony/config-route";
import { disconnectDevice } from "@/server/telephony/operator-devices";
import { createTelephonyDeps } from "@/server/telephony/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Forces the operator's browser phone off (its next heartbeat gets 409).
 * A call in progress is not touched — only the device session is revoked.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(CONFIG_WRITE_ROLES);
    const { id } = await context.params;

    const deps = await createTelephonyDeps({ organizationId: actor.organizationId });
    const device = await disconnectDevice({ admin: deps.admin, telnyx: deps.telnyx, environment: deps.environment }, { organizationId: actor.organizationId, profileId: id });
    if (!device) return Response.json({ error: "Operátor nemá zaregistrované zariadenie." }, { status: 404 });

    await auditOperatorDeviceAction({ admin: deps.admin }, {
      organizationId: actor.organizationId,
      actor: toConfigActor(actor),
      profileId: id,
      action: "device.disconnect",
      details: { environment: device.environment },
    });

    return Response.json({ ok: true, profileId: id, registrationState: device.registration_state });
  } catch (error) {
    return configErrorResponse(error, "Telefón sa nepodarilo odpojiť.");
  }
}
