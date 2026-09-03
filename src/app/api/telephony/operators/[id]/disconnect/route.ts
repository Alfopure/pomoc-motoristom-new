import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { assertOperatorNotOnCall, auditOperatorDeviceAction, requireOperatorOfOrganization } from "@/server/telephony/config-service";
import { CONFIG_WRITE_ROLES, configDeps, configErrorResponse, toConfigActor } from "@/server/telephony/config-route";
import { disconnectDevice } from "@/server/telephony/operator-devices";
import { createTelephonyDeps, readJsonBody } from "@/server/telephony/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Forces the operator's browser phone off (its next heartbeat gets 409).
 *
 * The tab reacts by disconnecting the WebRTC client, so a call in progress ends
 * with it: an operator who is `on_call`/`ringing` is refused with 409 unless
 * the body carries `{ "takeover": true }`.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(CONFIG_WRITE_ROLES);
    const { id } = await context.params;
    const body = await readJsonBody<{ takeover?: unknown }>(request);

    const operator = await requireOperatorOfOrganization(configDeps(), { organizationId: actor.organizationId, profileId: id });
    await assertOperatorNotOnCall(configDeps(), { organizationId: actor.organizationId, profileId: operator.profileId, takeover: body.takeover === true });

    const deps = await createTelephonyDeps({ organizationId: actor.organizationId });
    const device = await disconnectDevice({ admin: deps.admin, telnyx: deps.telnyx, environment: deps.environment }, { organizationId: actor.organizationId, profileId: operator.profileId });
    if (!device) return Response.json({ error: "Operátor nemá zaregistrované zariadenie." }, { status: 404 });

    await auditOperatorDeviceAction({ admin: deps.admin }, {
      organizationId: actor.organizationId,
      actor: toConfigActor(actor),
      profileId: operator.profileId,
      action: "device.disconnect",
      details: { environment: device.environment, takeover: body.takeover === true },
    });

    return Response.json({ ok: true, profileId: operator.profileId, registrationState: device.registration_state });
  } catch (error) {
    return configErrorResponse(error, "Telefón sa nepodarilo odpojiť.");
  }
}
