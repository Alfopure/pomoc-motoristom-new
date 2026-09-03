import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { assertOperatorNotOnCall, auditOperatorDeviceAction, requireOperatorOfOrganization } from "@/server/telephony/config-service";
import { CONFIG_WRITE_ROLES, configDeps, configErrorResponse, toConfigActor } from "@/server/telephony/config-route";
import { disconnectDevice, ensureOperatorCredential, getOperatorDevice } from "@/server/telephony/operator-devices";
import { createTelephonyDeps, readJsonBody, telephonyConfiguredOrResponse } from "@/server/telephony/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Provisions (or regenerates with `{ "rotate": true }`) the operator's Telnyx
 * SIP credential.
 *
 * Regenerating revokes the live browser session **and deletes the old
 * credential at Telnyx**, so the token minted from it can no longer register;
 * the tab's next heartbeat gets 409 and it tears the WebRTC socket down — which
 * ends a call in progress. That is why an operator
 * who is `on_call`/`ringing` is refused with 409 unless the body carries
 * `{ "takeover": true }`, exactly like `issueWebphoneToken`.
 *
 * `[id]` is checked against the caller's own organisation first: an unknown or
 * foreign profile id would otherwise create a real Telnyx credential before
 * failing, or upsert over another organisation's device row.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(CONFIG_WRITE_ROLES);
    const notConfigured = telephonyConfiguredOrResponse();
    if (notConfigured) return notConfigured;

    const { id } = await context.params;
    const body = await readJsonBody<{ rotate?: unknown; takeover?: unknown }>(request);
    const rotate = body.rotate === true;
    const takeover = body.takeover === true;

    const operator = await requireOperatorOfOrganization(configDeps(), { organizationId: actor.organizationId, profileId: id });
    if (rotate) await assertOperatorNotOnCall(configDeps(), { organizationId: actor.organizationId, profileId: operator.profileId, takeover });

    const deps = await createTelephonyDeps({ organizationId: actor.organizationId });
    const deviceDeps = { admin: deps.admin, telnyx: deps.telnyx, environment: deps.environment };
    // Read the row first: `ensureOperatorCredential` deletes the superseded
    // credential at Telnyx, and the audit row has to name the id that was
    // revoked, not only the one that replaced it.
    const previous = rotate ? await getOperatorDevice(deviceDeps, { organizationId: actor.organizationId, profileId: operator.profileId }) : null;
    const device = await ensureOperatorCredential(deviceDeps, { organizationId: actor.organizationId, profileId: operator.profileId, force: rotate });
    if (rotate) {
      // Only the browser session is revoked here; the freshly minted credential
      // must survive (the old one is already deleted).
      await disconnectDevice(deviceDeps, { organizationId: actor.organizationId, profileId: operator.profileId, keepCredential: true });
    }
    await auditOperatorDeviceAction({ admin: deps.admin }, {
      organizationId: actor.organizationId,
      actor: toConfigActor(actor),
      profileId: operator.profileId,
      action: "credential.rotate",
      details: {
        rotate,
        takeover,
        environment: deps.environment,
        credentialId: device.telnyx_credential_id,
        revokedCredentialId: previous?.telnyx_credential_id && previous.telnyx_credential_id !== device.telnyx_credential_id ? previous.telnyx_credential_id : null,
      },
    });

    return Response.json({
      ok: true,
      profileId: operator.profileId,
      device: { environment: device.environment, credentialId: device.telnyx_credential_id, sipUsername: device.sip_username, registrationState: rotate ? "unregistered" : device.registration_state },
    });
  } catch (error) {
    return configErrorResponse(error, "Prihlasovacie údaje telefónu sa nepodarilo vytvoriť.");
  }
}
