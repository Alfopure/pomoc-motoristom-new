import {
  cleanDialTarget,
  getViptelConfig,
  serializeViptelError,
  ViptelInputError,
} from "@/lib/integrations/viptel/client";
import { getViptelWebphoneConfig } from "@/lib/telephony/webphone";
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
import {
  beginSerializedOutboundCall,
  readBrowserSipReconciliationReport,
  reconcileBrowserSipInvite,
  recordUnsentBrowserSipInvite,
} from "@/server/telephony/telephony-commands";
import {
  requestViptelProviderSnapshot,
  requirePersonalExtensionInSnapshot,
} from "@/server/telephony/provider-snapshot-bridge";
import { VIPTEL_NEUTRAL_OUTBOUND_CID } from "@/server/telephony/viptel-line-catalog";

export const runtime = "nodejs";

type CreateCallBody = {
  assignmentGeneration?: unknown;
  browserInstanceId?: unknown;
  fromExtension?: unknown;
  phoneNumber?: unknown;
  toNumber?: unknown;
  destination?: unknown;
  callerId?: unknown;
  caseId?: unknown;
  dryRun?: unknown;
  mode?: unknown;
  leaderEpoch?: unknown;
  leaseId?: unknown;
  leaseVersion?: unknown;
  webphoneExtension?: unknown;
};

export async function POST(request: Request) {
  try {
    const actor = await requireTelephonyActor(request);
    const body = (await request.json().catch(() => null)) as CreateCallBody | null;

    if (!body) {
      throw new ViptelInputError("Request body is required.");
    }
    if (body.callerId !== undefined) {
      throw new ViptelInputError("callerId is controlled by the server and must not be supplied.");
    }

    const dryRun = body.dryRun === true;
    const mode = readString(body.mode) ?? "extension_callback";

    if (!["extension_callback", "extension", "mobile"].includes(mode)) {
      if (mode !== "webphone" && mode !== "browser_sip") {
        throw new ViptelInputError("mode must be extension_callback, extension, mobile, webphone, or browser_sip.");
      }
    }

    let config: ReturnType<typeof getViptelConfig> | undefined;

    try {
      config = getViptelConfig();
    } catch {
      // Provider commands are executed by the always-on Hetzner listener.
      // Vercel does not need the VIPTel secret just to enqueue durable work.
    }

    const browserMode = mode === "webphone" || mode === "browser_sip";
    const webphoneConfig = browserMode ? getViptelWebphoneConfig(process.env) : undefined;
    const webphoneExtension =
      browserMode ? readString(body.webphoneExtension) ?? readString(body.fromExtension) : undefined;
    const ownedExtension = await resolveOwnedTelephonyExtension(actor, webphoneExtension ?? body.fromExtension);
    const caller = ownedExtension.extension;
    const destination = cleanDialTarget(body.toNumber ?? body.destination ?? body.phoneNumber, "toNumber");
    const requestedCallerId = cleanDialTarget(VIPTEL_NEUTRAL_OUTBOUND_CID, "callerId");
    const caseId = readString(body.caseId);
    const requestPayload = {
      caller,
      destination,
      requestedCallerId,
      caseId,
      mode,
      transport: mode === "browser_sip" ? "browser_sip" : "outbox_websocket",
      webphone: webphoneConfig
        ? {
            status: webphoneConfig.status,
            dialMode: webphoneConfig.dialMode,
            sipWebSocketConfigured: Boolean(webphoneConfig.sipWebSocketUrl),
            sipDomain: webphoneConfig.sipDomain,
            browserRegistrationAllowed: webphoneConfig.browserRegistrationAllowed,
          }
        : undefined,
      providerNote:
        mode === "browser_sip"
          ? "The browser starts the SIP call only after this audited intent exists; the listener confirms it from the matching VIPTel call.begin event."
          : "The always-on listener sends VIPTel call.create from the assigned extension; outbound CID comes from PBX extension settings.",
    };

    if (dryRun) {
      return Response.json({
        ok: true,
        dryRun: true,
        configAvailable: Boolean(config),
        request: requestPayload,
      });
    }

    const leaseFence = body.leaseId === undefined ? undefined : readWorkplaceLeaseFence(body);
    await requireActiveWorkplaceLease(actor, ownedExtension, leaseFence, { requireFence: true });

    const providerSnapshot = await requestViptelProviderSnapshot(actor.organizationId, actor.profileId, {
      maxAgeMs: 2_000,
      ...(browserMode ? { requireNewCapture: true } : {}),
    });
    requirePersonalExtensionInSnapshot(
      providerSnapshot,
      ownedExtension.extension,
      mode === "browser_sip"
        ? { allowInactiveForBrowserSipIntent: true, requireRegistered: true }
        : { requireRegistered: browserMode },
    );
    const actionClaim = await claimOwnedExtensionAction(actor, ownedExtension.id, "call.create", {
      leaseFence,
    });
    let command: Awaited<ReturnType<typeof beginSerializedOutboundCall>>;
    try {
      command = await beginSerializedOutboundCall({
        organizationId: actor.organizationId,
        requestedBy: actor.profileId,
        extensionId: actionClaim.id,
        assignmentGuard: actionClaim.assignmentGuard,
        providerActiveCalls: providerSnapshot.activeCalls,
        providerSnapshotCapturedAt: providerSnapshot.capturedAt,
        requestPayload: { ...requestPayload, caller: actionClaim.extension },
        initialStatus: mode === "browser_sip" ? "accepted" : "queued",
      });
    } catch (error) {
      await releaseExtensionAssignmentGuard(
        createSupabaseAdminClient(),
        actor.organizationId,
        actionClaim.assignmentGuard,
      );
      throw error;
    }
    return Response.json({
      ok: true,
      command: { id: command.id, status: mode === "browser_sip" ? "accepted" : "queued" },
      requestId: command.idempotencyKey,
    }, { status: 202 });
  } catch (error) {
    return callErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await requireTelephonyActor(request);
    const body = (await request.json().catch(() => null)) as {
      browserReport?: unknown;
      commandId?: unknown;
      outcome?: unknown;
    } | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ViptelInputError("Request body is required.");
    }
    if (body.outcome === "reconcile") {
      const browserReport = readBrowserSipReconciliationReport(body.browserReport);
      const providerSnapshot = await requestViptelProviderSnapshot(
        actor.organizationId,
        actor.profileId,
        { maxAgeMs: 2_000, requireNewCapture: true },
      );
      const command = await reconcileBrowserSipInvite({
        browserReport,
        commandId: body.commandId,
        organizationId: actor.organizationId,
        providerActiveCalls: providerSnapshot.activeCalls,
        providerCapturedAt: providerSnapshot.capturedAt,
        requestedBy: actor.profileId,
      });
      return Response.json({ ok: true, command }, {
        headers: { "Cache-Control": "private, no-store" },
      });
    }
    if (body.outcome !== undefined && body.outcome !== "invite_not_sent") {
      throw new ViptelInputError("outcome must be invite_not_sent or reconcile.");
    }
    const command = await recordUnsentBrowserSipInvite({
      commandId: body.commandId,
      organizationId: actor.organizationId,
      requestedBy: actor.profileId,
    });
    return Response.json({ ok: true, command }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return callErrorResponse(error);
  }
}

function callErrorResponse(error: unknown) {
  if (error instanceof MutationError) {
    return Response.json(
      { ok: false, error: error.message, ...(error.code ? { code: error.code } : {}) },
      { status: error.status },
    );
  }

  const serialized = serializeViptelError(error);

  return Response.json(
    {
      ok: false,
      error: serialized.message,
      providerStatus: serialized.providerStatus,
      providerResponseSummary: serialized.providerResponseSummary,
    },
    { status: serialized.status },
  );
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
