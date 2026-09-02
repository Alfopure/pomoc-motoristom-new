import { serializeViptelError, ViptelInputError } from "@/lib/integrations/viptel/client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { ViptelQueueAgentAction } from "@/lib/integrations/viptel/client";
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
  assertNoPendingDispatchAvailabilityCommand,
  dispatchAvailabilityPayload,
  resolvePlannedDispatchQueue,
} from "@/server/telephony/dispatch-routing";
import { assertTelephonyLiveMutationEnabled } from "@/server/telephony/live-mutation-gate";
import { requestViptelProviderSnapshot } from "@/server/telephony/provider-snapshot-bridge";
import { beginTelephonyCommand } from "@/server/telephony/telephony-commands";

export const runtime = "nodejs";
const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

type AvailabilityIntent = "available" | "pause" | "offline";
const ALLOWED_INTENTS: AvailabilityIntent[] = ["available", "pause", "offline"];

type AgentBody = {
  assignmentGeneration?: unknown;
  browserInstanceId?: unknown;
  extension?: unknown;
  leaderEpoch?: unknown;
  leaseId?: unknown;
  leaseVersion?: unknown;
  action?: unknown;
  queue?: unknown;
};

export async function POST(request: Request) {
  try {
    const actor = await requireTelephonyActor(request);
    const body = (await request.json().catch(() => null)) as AgentBody | null;
    if (body?.queue !== undefined) {
      throw new ViptelInputError("queue is derived from the manager priority plan and must not be supplied.");
    }
    const requestedExtension = body?.extension === undefined
      ? undefined
      : readNumericString(body.extension, "extension");
    const intent = readString(body?.action) as AvailabilityIntent | undefined;
    if (!intent || !ALLOWED_INTENTS.includes(intent)) {
      throw new ViptelInputError("action must be available, pause, or offline.");
    }

    assertTelephonyLiveMutationEnabled(`queue.availability.${intent}`);
    const ownedExtension = await resolveOwnedTelephonyExtension(actor, requestedExtension);
    const leaseFence = body?.leaseId === undefined ? undefined : readWorkplaceLeaseFence(body);
    await requireActiveWorkplaceLease(actor, ownedExtension, leaseFence, { requireFence: true });
    const extension = ownedExtension.extension;
    const planned = await resolvePlannedDispatchQueue(actor.organizationId, extension);
    await assertNoPendingDispatchAvailabilityCommand(actor.organizationId, planned.queue, extension);
    const snapshot = await requestViptelProviderSnapshot(actor.organizationId, actor.profileId, { maxAgeMs: 2_000 });
    const status = snapshot.queueStatuses.find((candidate) => candidate.queue === planned.queue);
    if (!status) throw new MutationError(`VIPTel snapshot neobsahuje rad ${planned.queue}.`, 502);
    const member = status.members.find((candidate) => candidate.extension === extension);
    const action = providerAction(intent, member);
    if (!action) {
      return Response.json({
        ok: true,
        noOp: true,
        state: intent,
        queue: planned.queue,
        extension,
        routingRevision: planned.revision,
      }, { headers: NO_STORE_HEADERS });
    }

    const claimedExtension = await claimOwnedExtensionAction(actor, ownedExtension.id, "queue.availability", {
      leaseFence,
    });
    let command: Awaited<ReturnType<typeof beginTelephonyCommand>>;
    try {
      if (claimedExtension.extension !== extension) {
        throw new MutationError("Osobná klapka sa počas autorizácie dostupnosti zmenila.", 409);
      }
      command = await beginTelephonyCommand({
        organizationId: actor.organizationId,
        requestedBy: actor.profileId,
        commandType: `queue.${action}`,
        queueId: planned.queueId,
        extensionId: claimedExtension.id,
        assignmentGuard: claimedExtension.assignmentGuard,
        requestPayload: {
          queue: planned.queue,
          extension,
          action,
          ...dispatchAvailabilityPayload({
            queue: planned.queue,
            extension,
            revision: planned.revision,
            intent,
            planDigest: planned.planDigest,
          }),
        },
      });
    } catch (error) {
      await releaseExtensionAssignmentGuard(
        createSupabaseAdminClient(),
        actor.organizationId,
        claimedExtension.assignmentGuard,
      );
      throw error;
    }
    return Response.json({
      ok: true,
      command: { id: command.id, status: "queued" },
    }, { status: 202, headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json(
        { ok: false, error: error.message, ...(error.code ? { code: error.code } : {}) },
        { status: error.status, headers: NO_STORE_HEADERS },
      );
    }

    const serialized = serializeViptelError(error);
    return Response.json(
      { ok: false, error: serialized.message, providerStatus: serialized.providerStatus },
      { status: serialized.status, headers: NO_STORE_HEADERS },
    );
  }
}

function providerAction(
  intent: AvailabilityIntent,
  member: { paused: boolean } | undefined,
): ViptelQueueAgentAction | undefined {
  if (intent === "available") return !member ? "add" : member.paused ? "unpause" : undefined;
  if (intent === "pause") {
    if (!member) throw new ViptelInputError("Operator is not a member of the planned queue.");
    return member.paused ? undefined : "pause";
  }
  return member ? "remove" : undefined;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumericString(value: unknown, fieldName: string) {
  const text = readString(value);

  if (!text) {
    return undefined;
  }

  if (!/^\d{1,8}$/.test(text)) {
    throw new ViptelInputError(`${fieldName} must be numeric.`);
  }

  return text;
}
