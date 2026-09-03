import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { auditOperatorDeviceAction } from "@/server/telephony/config-service";
import { CONFIG_WRITE_ROLES, configErrorResponse, toConfigActor } from "@/server/telephony/config-route";
import { disconnectDevice, ensureOperatorCredential } from "@/server/telephony/operator-devices";
import { createTelephonyDeps, readJsonBody, telephonyConfiguredOrResponse } from "@/server/telephony/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Provisions (or regenerates with `{ "rotate": true }`) the operator's Telnyx
 * SIP credential. Regenerating also revokes the live browser session, because
 * the token minted from the old credential stops working.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(CONFIG_WRITE_ROLES);
    const notConfigured = telephonyConfiguredOrResponse();
    if (notConfigured) return notConfigured;

    const { id } = await context.params;
    const body = await readJsonBody<{ rotate?: unknown }>(request);
    const rotate = body.rotate === true;

    const deps = await createTelephonyDeps({ organizationId: actor.organizationId });
    const device = await ensureOperatorCredential(
      { admin: deps.admin, telnyx: deps.telnyx, environment: deps.environment },
      { organizationId: actor.organizationId, profileId: id, force: rotate },
    );
    if (rotate) {
      await disconnectDevice({ admin: deps.admin, telnyx: deps.telnyx, environment: deps.environment }, { organizationId: actor.organizationId, profileId: id });
    }
    await auditOperatorDeviceAction({ admin: deps.admin }, {
      organizationId: actor.organizationId,
      actor: toConfigActor(actor),
      profileId: id,
      action: "credential.rotate",
      details: { rotate, environment: deps.environment, credentialId: device.telnyx_credential_id },
    });

    return Response.json({
      ok: true,
      profileId: id,
      device: { environment: device.environment, credentialId: device.telnyx_credential_id, sipUsername: device.sip_username, registrationState: rotate ? "unregistered" : device.registration_state },
    });
  } catch (error) {
    return configErrorResponse(error, "Prihlasovacie údaje telefónu sa nepodarilo vytvoriť.");
  }
}
