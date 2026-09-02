import { getViptelWebphoneSession, ViptelWebphoneSessionError } from "@/lib/telephony/webphone";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { MutationError } from "@/server/motorist-mutations";
import {
  readWorkplaceLeaseFence,
  requireActiveWorkplaceLease,
  requireTelephonyActor,
  resolveOwnedTelephonyExtension,
} from "@/server/telephony-access";
import {
  claimOwnedExtensionAction,
  releaseExtensionAssignmentGuard,
} from "@/server/telephony/assignment-interlock";
import { assertTelephonyLiveMutationEnabled } from "@/server/telephony/live-mutation-gate";
import {
  requestViptelProviderSnapshot,
  requirePersonalExtensionInSnapshot,
} from "@/server/telephony/provider-snapshot-bridge";

export const runtime = "nodejs";

type WebphoneSessionBody = {
  assignmentGeneration?: unknown;
  browserInstanceId?: unknown;
  extension?: unknown;
  leaderEpoch?: unknown;
  leaseId?: unknown;
  leaseVersion?: unknown;
  webphoneExtension?: unknown;
};

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

export async function POST(request: Request) {
  try {
    const actor = await requireTelephonyActor(request);
    assertTelephonyLiveMutationEnabled("webphone.session.issue");
    const parsedBody = await request.json().catch(() => undefined);
    if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
      throw new MutationError("Údaje webphone session musia byť platný JSON objekt.", 400);
    }
    const body = parsedBody as WebphoneSessionBody;
    const extension = await resolveOwnedTelephonyExtension(actor, body.extension ?? body.webphoneExtension);
    const fence = body.leaseId === undefined ? undefined : readWorkplaceLeaseFence(body);
    await requireActiveWorkplaceLease(actor, extension, fence, { requireFence: true });
    const providerSnapshot = await requestViptelProviderSnapshot(actor.organizationId, actor.profileId, { maxAgeMs: 2_000 });
    requirePersonalExtensionInSnapshot(providerSnapshot, extension.extension, {
      allowInactiveForRegistration: true,
    });
    const client = createSupabaseAdminClient();
    const actionClaim = await claimOwnedExtensionAction(actor, extension.id, "webphone.session.issue", {
      allowExactRoutingWebphoneSession: true,
      client,
      leaseFence: fence,
    });
    let session: ReturnType<typeof getViptelWebphoneSession>;
    try {
      session = getViptelWebphoneSession(process.env, actionClaim.extension);
    } finally {
      // Credentials are returned only after the exact synchronous issuance
      // claim has been cleared. This also clears a claim when configuration or
      // credential derivation fails before a session can be issued.
      if (actionClaim.releaseAssignmentGuard) {
        await releaseExtensionAssignmentGuard(client, actor.organizationId, actionClaim.assignmentGuard);
      }
    }

    return Response.json(
      {
        ok: true,
        checkedAt: new Date().toISOString(),
        session,
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    const expectedError = error instanceof ViptelWebphoneSessionError || error instanceof MutationError;
    const status = expectedError ? error.status : 500;

    return Response.json(
      {
        ok: false,
        error: expectedError ? error.message : "Pripojenie telefónu v prehliadači sa nepodarilo.",
        ...(error instanceof MutationError && error.code ? { code: error.code } : {}),
      },
      { status, headers: NO_STORE_HEADERS },
    );
  }
}
