import "server-only";

import { createHash, createHmac, randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import {
  hasBlockingExtensionCommand,
  loadTerminalAcceptedBrowserTransferCallIds,
} from "@/server/telephony/command-interlock";
import {
  assignedLifecycle,
  lifecycleAuditPayload,
  readAssignmentLifecycle,
  requireImmutableWorkplaceSeatLifecycle,
  unassignedLifecycle,
  type AssignmentLifecycle,
} from "@/server/telephony/assignment-lifecycle";
import {
  hasActiveAssignmentTransitionMetadata,
  reconcileTerminalExtensionAssignmentClaim,
} from "@/server/telephony/assignment-interlock";
import {
  DISPATCH_QUEUE_NUMBERS,
  dispatchRoutingOperationAuthorityDigest,
  parseDispatchRoutingState,
  readApplicableWorkplacePriorityDraft,
  recoverDispatchRoutingOperation,
  type DispatchPriorityPlan,
  type DispatchQueueNumber,
  type DispatchRoutingOperation,
} from "@/server/telephony/dispatch-routing";
import { configuredPersonalExtensions } from "@/server/telephony/personal-extension-config";
import {
  parseWorkplacePriorityDraft,
  requireLatestWorkplacePriorityDraftAuthority,
} from "@/server/telephony/workplace-draft-authority";
import {
  requestViptelProviderSnapshot,
  type ViptelProviderSnapshot,
} from "@/server/telephony/provider-snapshot-bridge";
import {
  canProfileUseWorkplaceHotdesk,
  canVacateQueuedWorkplace,
  workplaceHotdeskCapability,
  type WorkplaceHotdeskCapability,
} from "@/server/telephony/workplace-capability";
import {
  readWorkplaceLease,
  toWorkplaceLeaseClientRef,
  workplaceLeaseFreshness,
  workplaceSeatOwnershipVersion,
  type WorkplaceLease,
  type WorkplaceLeaseClientRef,
} from "@/server/telephony/workplace-lease";
import {
  canonicalTelephonyResourceClaims,
  toResourceClaimsJson,
  workplaceOperationIntentHash,
  type WorkplaceOperationKind,
} from "@/server/telephony/workplace-operation";
import {
  createWorkplaceOperationRepository,
  WorkplaceOperationRepositoryError,
  type WorkplaceOperationRepository,
} from "@/server/telephony/workplace-operation-repository";
import {
  assertExactWorkplaceProviderState,
  WorkplaceProviderRegisteredError,
} from "@/server/telephony/workplace-admin-actions";
import { requireActiveWorkplaceLease } from "@/server/telephony-access";

type AdminClient = SupabaseClient<Database>;
type ExtensionRow = Database["public"]["Tables"]["motorist_telephony_extensions"]["Row"];
type OperationRow = Database["public"]["Tables"]["motorist_workplace_operations"]["Row"];
type QueueRow = Pick<
  Database["public"]["Tables"]["motorist_telephony_queues"]["Row"],
  "external_id" | "id" | "metadata" | "updated_at"
>;
type RoutingRecoveryCommand = Pick<
  Database["public"]["Tables"]["motorist_telephony_commands"]["Row"],
  | "command_type"
  | "extension_id"
  | "id"
  | "idempotency_key"
  | "organization_id"
  | "provider"
  | "provider_response"
  | "queue_id"
  | "request_payload"
  | "requested_by"
  | "status"
>;

const PROVIDER = "viptel";
const COMMAND_SCAN_LIMIT = 501;
const NON_TERMINAL_COMMAND_STATUSES = ["queued", "sent", "accepted"] as const;
const CONTROLLED_QUEUE_PROBE_AUDIT_ACTION = "telephony.workplace.queue_probe.approved";
const ABANDONED_PRIORITY_DRAFT_MIN_AGE_MS = 5 * 60_000;
const PRIORITY_DRAFT_AUDIT_ACTION = "telephony.workplace.priority.draft";
const PRIORITY_DRAFT_ENTITY_TYPE = "motorist_telephony_queues";

export type DynamicSeatInput = {
  browserInstanceId: string;
  idempotencyKey: string;
  expectedVersion?: string;
};

export type DynamicSeatSelectionInput = DynamicSeatInput & { extension: unknown };
export type ConfirmDynamicSeatInput = DynamicSeatInput & {
  operationId: string;
  browserDisconnectOutcome?: "accepted" | "not_connected";
};

export type DynamicWorkplaceResult = {
  result: {
    state: "confirmed" | "disconnect_required";
    message: string;
    noOp?: true;
    operationId?: string;
  };
  lease?: WorkplaceLeaseClientRef;
  resumeSecret?: string;
};

type WorkplaceSeat = {
  extension: ExtensionRow;
  lease?: WorkplaceLease;
  lifecycle: AssignmentLifecycle;
  queue: DispatchQueueNumber | null;
};

type WorkplaceContext = {
  root: QueueRow;
  plan: DispatchPriorityPlan;
  source?: WorkplaceSeat;
  target?: WorkplaceSeat;
};

type ProviderProofOptions = {
  allowRegisteredSource?: boolean;
  allowRegisteredTarget?: boolean;
};

type CompletedOperationTarget = Pick<WorkplaceSeat, "extension" | "lease">;

class WorkplaceSourceUnregisterPendingError extends MutationError {
  constructor(readonly extension: string) {
    super(
      `VIPTel ešte dokončuje odpojenie telefónu na pracovnom mieste ${extension}. Bezpečne opakuj rovnaké potvrdenie.`,
      423,
      "workplace_source_unregister_pending",
    );
  }
}

export type WorkplaceHandoffDependencies = {
  client?: AdminClient;
  repository?: WorkplaceOperationRepository;
  requestProviderSnapshot?: (
    organizationId: string,
    requestedBy: string,
  ) => Promise<Pick<ViptelProviderSnapshot, "activeCalls" | "capturedAt" | "extensions" | "queueStatuses">>;
  randomId?: () => string;
  resumeSecretKey?: string;
  sleep?: (milliseconds: number) => Promise<void>;
  recoverBlockingRouting?: (
    actor: MotoristActor,
    targetExtension: string,
  ) => Promise<"none" | "recovered" | "pending">;
  recoverRouting?: typeof recoverDispatchRoutingOperation;
};

export async function selectDynamicWorkplaceSeat(
  actor: MotoristActor,
  input: DynamicSeatSelectionInput,
  dependencies: WorkplaceHandoffDependencies = {},
): Promise<DynamicWorkplaceResult> {
  const runtimeCapability = requireHotdeskRuntimeCapability();
  requireResumeSecretKey(dependencies);
  const targetNumber = readConfiguredExtension(input.extension);
  const client = dependencies.client ?? createSupabaseAdminClient();
  const repository = dependencies.repository ?? createWorkplaceOperationRepository(client);
  await recoverExpiredWorkplaceOperations(
    { organizationId: actor.organizationId, recoveryOwner: `request:${actor.profileId}` },
    { ...dependencies, client, repository },
  );
  const existing = await loadExistingOperation(client, actor, input.idempotencyKey);
  if (existing) {
    assertExistingSelectionIntent(existing, input, targetNumber);
    if (!existing.target_extension_id ||
        await loadExtensionNumber(client, actor.organizationId, existing.target_extension_id) !== targetNumber) {
      throw new MutationError("Identifikátor požiadavky už patrí inému cieľovému pracovnému miestu.", 409);
    }
    return continueOperation(actor, existing, dependencies, client, repository, runtimeCapability, false);
  }

  const routingRecovery = await (dependencies.recoverBlockingRouting ?? ((currentActor, currentTarget) =>
    recoverDefiniteFailedRoutingBeforeSeatSelection(currentActor, currentTarget, {
      client,
      repository,
      recoverRouting: dependencies.recoverRouting,
    })))(actor, targetNumber);
  if (routingRecovery === "pending") {
    throw new MutationError(
      "Najprv sa dokončuje obnova predchádzajúceho poradia. Pracovisko sa pripojí po jej potvrdení.",
      423,
      "priority_recovery_pending",
    );
  }
  await recoverAbandonedWorkplacePriorityDraft(actor, { client, repository });

  const capability = requireHotdeskClaimCapability(actor);
  const context = await loadWorkplaceContext(client, actor, targetNumber);
  if (!context.target) throw new MutationError(`Pracovné miesto ${targetNumber} nie je pripravené.`, 404);
  assertExpectedSeatVersion(context.target, input.expectedVersion);
  if (context.target.extension.profile_id === actor.profileId) {
    if (context.target.lease?.browserInstanceId === input.browserInstanceId) {
      try {
        return await existingOwnerResult(actor, context.target, input.browserInstanceId, client, repository);
      } catch (error) {
        if (!(error instanceof MutationError) || error.code !== "lease_lost") throw error;
      }
    }
    const reclaimContext = { ...context, source: undefined };
    assertSeatEligibility(context.target, "browser_transfer");
    await reconcileTerminalAssignmentClaims(actor, reclaimContext, dependencies, client, capability);
    const operation = await beginOperation(
      actor,
      input,
      "browser_transfer",
      reclaimContext,
      client,
      repository,
    );
    return finishOperation(
      actor,
      operation.operationId,
      reclaimContext,
      dependencies,
      client,
      repository,
      capability,
    );
  }
  const kind = context.source
    ? "switch"
    : context.target.extension.profile_id
      ? "takeover"
      : "claim";
  assertSeatEligibility(context.target, kind);
  if (context.source) {
    assertSourceLease(context.source, actor, input.browserInstanceId);
    assertSourceCanBeVacated(context.source, capability, actor);
  }
  await reconcileTerminalAssignmentClaims(actor, context, dependencies, client, capability);

  const operation = await beginOperation(actor, input, kind, context, client, repository);
  if (context.source) {
    return {
      result: {
        state: "disconnect_required",
        operationId: operation.operationId,
        message: `Odpoj telefón na pracovnom mieste ${context.source.extension.extension}; potom bezpečne dokončíme presun na ${targetNumber}.`,
      },
    };
  }
  return finishOperation(actor, operation.operationId, context, dependencies, client, repository, capability);
}

/**
 * Abandons only an exact, signed self-service routing step whose failed
 * command has an explicit proof of non-delivery and whose original operator
 * no longer has a fresh browser lease. This breaks the otherwise circular
 * dependency between recovering routing and reclaiming an expired workplace.
 */
export async function recoverDefiniteFailedRoutingBeforeSeatSelection(
  actor: MotoristActor,
  _targetExtension: string,
  dependencies: Pick<WorkplaceHandoffDependencies, "client" | "recoverRouting"> & {
    repository?: WorkplaceOperationRepository;
  } = {},
): Promise<"none" | "recovered" | "pending"> {
  const capability = workplaceHotdeskCapability();
  if (!canProfileUseWorkplaceHotdesk(capability, actor.profileId)) return "none";

  const client = dependencies.client ?? createSupabaseAdminClient();
  const repository = dependencies.repository ?? createWorkplaceOperationRepository(client);
  const rootResult = await client
    .from("motorist_telephony_queues")
    .select("id, external_id, metadata, updated_at")
    .eq("organization_id", actor.organizationId)
    .eq("provider", PROVIDER)
    .eq("external_id", "601")
    .eq("active", true)
    .is("line_id", null)
    .maybeSingle();
  if (rootResult.error) throw new MutationError("Rozpracované poradie sa nepodarilo overiť.", 500);
  if (!rootResult.data) return "none";

  const operation = parseDispatchRoutingState(rootResult.data.metadata).operation;
  if (!operation) return "none";
  const step = operation.steps[operation.currentStep];
  if (!step) return "none";

  const commandResult = await client
    .from("motorist_telephony_commands")
    .select(
      "id, organization_id, provider, requested_by, status, command_type, idempotency_key, extension_id, queue_id, request_payload, provider_response",
    )
    .eq("id", step.commandId)
    .eq("organization_id", actor.organizationId)
    .eq("provider", PROVIDER)
    .maybeSingle();
  if (commandResult.error) throw new MutationError("Posledný krok poradia sa nepodarilo overiť.", 500);
  const command = commandResult.data as RoutingRecoveryCommand | null;
  if (!definiteFailedWorkplaceRoutingCommand(actor.organizationId, operation, command)) return "none";

  const actorExtensionIds = operation.assignmentGuards
    .filter((guard) => guard.profileId === operation.actorProfileId)
    .map((guard) => guard.extensionId);
  if (actorExtensionIds.length === 0) return "none";
  const [databaseNow, leasesResult] = await Promise.all([
    repository.databaseNow(),
    client
      .from("motorist_workplace_leases")
      .select("*")
      .eq("organization_id", actor.organizationId)
      .eq("profile_id", operation.actorProfileId)
      .in("extension_id", actorExtensionIds)
      .in("state", ["active", "ending"]),
  ]);
  if (leasesResult.error) throw new MutationError("Relácia pôvodného operátora sa nepodarila overiť.", 500);
  for (const row of leasesResult.data ?? []) {
    const lease = readWorkplaceLease(row);
    if (!lease) throw new MutationError("Relácia pôvodného operátora má neplatný formát.", 409);
    const freshness = workplaceLeaseFreshness(lease, databaseNow);
    if (freshness === "fresh" || freshness === "ending" || freshness === "invalid_time") return "none";
  }

  const overview = await (dependencies.recoverRouting ?? recoverDispatchRoutingOperation)(
    actor,
    "rollback",
    operation.operationId,
  );
  return overview.operation ? "pending" : "recovered";
}

export function definiteFailedWorkplaceRoutingCommand(
  organizationId: string,
  operation: DispatchRoutingOperation,
  command: RoutingRecoveryCommand | null | undefined,
) {
  if (
    !command || command.status !== "failed" ||
    operation.status === "rolling_back" || operation.initialBootstrap || operation.releasePending ||
    operation.rootMetadataGuard?.key !== "workplacePriorityDraft"
  ) return false;
  const step = operation.steps[operation.currentStep];
  const payload = record(command.request_payload);
  const tag = record(payload.routingOperation);
  const response = record(command.provider_response);
  const reconciledActual = record(response.reconciledActual);
  if (
    Object.prototype.hasOwnProperty.call(response, "reconciledActual") &&
    (
      reconciledActual.applied !== false ||
      reconciledActual.queue !== step?.queue ||
      reconciledActual.extension !== step?.extension
    )
  ) return false;
  return Boolean(
    step &&
    command.organization_id === organizationId &&
    command.provider === PROVIDER &&
    command.requested_by === operation.actorProfileId &&
    command.id === step.commandId &&
    command.command_type === step.commandType &&
    command.idempotency_key === step.idempotencyKey &&
    command.extension_id === step.extensionId &&
    command.queue_id === step.queueId &&
    payload.queue === step.queue &&
    payload.extension === step.extension &&
    payload.action === step.action &&
    tag.operationId === operation.operationId &&
    tag.stepIndex === operation.currentStep &&
    tag.revision === operation.targetRevision &&
    tag.authorityDigest === dispatchRoutingOperationAuthorityDigest(organizationId, operation) &&
    response.deliveryUncertain === false
  );
}

/**
 * A self-service priority request persists its signed draft before the routing
 * saga is started. If that request is interrupted in the narrow gap between
 * those writes, the draft changes no VIPTel state but used to block every
 * later workplace leave/reclaim indefinitely.
 *
 * Discard only the exact actor's sufficiently old, still-unapplied draft. The
 * committed routing plan and all provider memberships remain untouched. A
 * fresh draft, a real routing operation, a foreign actor, an invalid proof or
 * a concurrent metadata update all continue to fail closed.
 */
export async function recoverAbandonedWorkplacePriorityDraft(
  actor: MotoristActor,
  dependencies: Pick<WorkplaceHandoffDependencies, "client"> & {
    repository?: WorkplaceOperationRepository;
  } = {},
): Promise<"none" | "recovered"> {
  const client = dependencies.client ?? createSupabaseAdminClient();
  const repository = dependencies.repository ?? createWorkplaceOperationRepository(client);
  const rootResult = await client
    .from("motorist_telephony_queues")
    .select("id, external_id, metadata, updated_at")
    .eq("organization_id", actor.organizationId)
    .eq("provider", PROVIDER)
    .eq("external_id", "601")
    .eq("active", true)
    .maybeSingle();
  if (rootResult.error) {
    throw new MutationError("RozpracovanÃ© poradie sa nepodarilo overiÅ¥.", 500);
  }
  if (!rootResult.data) return "none";

  const root = rootResult.data as QueueRow;
  const routing = parseDispatchRoutingState(root.metadata);
  if (routing.operation) return "none";

  const rawDraft = record(root.metadata).workplacePriorityDraft;
  if (rawDraft === undefined) return "none";
  const draft = parseWorkplacePriorityDraft(rawDraft);
  const applicablePlan = readApplicableWorkplacePriorityDraft(root.metadata, routing.revision, {
    organizationId: actor.organizationId,
    rootQueueId: root.id,
  });
  if (!applicablePlan || samePlan(applicablePlan, routing.currentPlan)) return "none";

  const authority = await requireLatestWorkplacePriorityDraftAuthority(client, draft, {
    organizationId: actor.organizationId,
    rootQueueId: root.id,
  });
  const authorityResult = await client
    .from("motorist_audit_log")
    .select("id, actor_profile_id")
    .eq("id", authority.auditId)
    .eq("organization_id", actor.organizationId)
    .eq("action", PRIORITY_DRAFT_AUDIT_ACTION)
    .eq("entity_type", PRIORITY_DRAFT_ENTITY_TYPE)
    .eq("entity_id", root.id)
    .maybeSingle();
  if (authorityResult.error) {
    throw new MutationError("VlastnÃ­ka rozpracovanÃ©ho poradia sa nepodarilo overiÅ¥.", 500);
  }
  const actorParticipatedInDraft = Object.values(draft.selectedBy).includes(actor.profileId);
  if (authorityResult.data?.actor_profile_id !== actor.profileId && !actorParticipatedInDraft) return "none";

  const databaseNow = await repository.databaseNow();
  const ageMs = Date.parse(databaseNow) - Date.parse(draft.updatedAt);
  if (!Number.isFinite(ageMs) || ageMs < ABANDONED_PRIORITY_DRAFT_MIN_AGE_MS) return "none";

  const previousMetadata = record(root.metadata);
  const nextMetadata = structuredClone(previousMetadata);
  delete nextMetadata.workplacePriorityDraft;
  const updated = await client
    .from("motorist_telephony_queues")
    .update({ metadata: nextMetadata as Json })
    .eq("id", root.id)
    .eq("organization_id", actor.organizationId)
    .eq("provider", PROVIDER)
    .eq("external_id", "601")
    .eq("updated_at", root.updated_at)
    .select("id, updated_at")
    .maybeSingle();
  if (updated.error) {
    throw new MutationError("OpustenÃ½ vÃ½ber poradia sa nepodarilo bezpeÄne zruÅ¡iÅ¥.", 500);
  }
  if (!updated.data) {
    throw new MutationError(
      "Poradie medzitÃ½m zmenila inÃ¡ poÅ¾iadavka. Obnov stav a skÃºs uvoÄ¾nenie znova.",
      409,
      "workplace_conflict",
    );
  }

  const recoveryAuditId = randomUUID();
  const auditResult = await client.from("motorist_audit_log").insert({
    id: recoveryAuditId,
    organization_id: actor.organizationId,
    actor_profile_id: actor.profileId,
    action: "telephony.workplace.priority.draft.abandoned",
    entity_type: PRIORITY_DRAFT_ENTITY_TYPE,
    entity_id: root.id,
    source: "web",
    after_payload: {
      schemaVersion: 1,
      reason: "stale_unapplied_draft",
      draftAuthorityId: authority.auditId,
      draftUpdatedAt: draft.updatedAt,
      baseRevision: draft.baseRevision,
    } as Json,
  });
  if (!auditResult.error) return "recovered";

  const rolledBack = await client
    .from("motorist_telephony_queues")
    .update({ metadata: previousMetadata as Json })
    .eq("id", root.id)
    .eq("organization_id", actor.organizationId)
    .eq("provider", PROVIDER)
    .eq("external_id", "601")
    .eq("updated_at", updated.data.updated_at)
    .select("id")
    .maybeSingle();
  if (rolledBack.error || !rolledBack.data) {
    throw new MutationError(
      "ZruÅ¡enie opustenÃ©ho poradia sa nepodarilo zauditovaÅ¥ ani bezpeÄne vrÃ¡tiÅ¥. Stav musÃ­ skontrolovaÅ¥ sprÃ¡vca.",
      500,
      "workplace_recovery_required",
    );
  }
  throw new MutationError("ZruÅ¡enie opustenÃ©ho poradia sa nepodarilo zauditovaÅ¥; pÃ´vodnÃ½ stav bol obnovenÃ½.", 500);
}

export async function leaveDynamicWorkplaceSeat(
  actor: MotoristActor,
  input: DynamicSeatInput,
  dependencies: WorkplaceHandoffDependencies = {},
): Promise<DynamicWorkplaceResult> {
  const capability = requireHotdeskRuntimeCapability();
  requireResumeSecretKey(dependencies);
  const client = dependencies.client ?? createSupabaseAdminClient();
  const repository = dependencies.repository ?? createWorkplaceOperationRepository(client);
  await recoverExpiredWorkplaceOperations(
    { organizationId: actor.organizationId, recoveryOwner: `request:${actor.profileId}` },
    { ...dependencies, client, repository },
  );
  const existing = await loadExistingOperation(client, actor, input.idempotencyKey);
  if (existing) {
    if (existing.kind !== "leave" || existing.browser_instance_id !== input.browserInstanceId) {
      throw new MutationError("Identifikátor požiadavky už patrí inej zmene pracoviska.", 409);
    }
    return continueOperation(actor, existing, dependencies, client, repository, capability, false);
  }
  await recoverAbandonedWorkplacePriorityDraft(actor, { client, repository });
  const context = await loadWorkplaceContext(client, actor);
  if (!context.source) {
    return { result: { state: "confirmed", noOp: true, message: "Nemáš aktívne pracovné miesto." } };
  }
  assertExpectedSeatVersion(context.source, input.expectedVersion);
  assertSourceLease(context.source, actor, input.browserInstanceId);
  assertSourceCanBeVacated(context.source, capability, actor);
  await reconcileTerminalAssignmentClaims(actor, context, dependencies, client, capability);
  const operation = await beginOperation(actor, input, "leave", context, client, repository);
  return {
    result: {
      state: "disconnect_required",
      operationId: operation.operationId,
      message: `Odpoj telefón na pracovnom mieste ${context.source.extension.extension}; potom bezpečne dokončíme odchod.`,
    },
  };
}

async function reconcileTerminalAssignmentClaims(
  actor: MotoristActor,
  context: WorkplaceContext,
  dependencies: WorkplaceHandoffDependencies,
  client: AdminClient,
  capability: WorkplaceHotdeskCapability,
) {
  const seats = [context.source, context.target]
    .filter((value): value is WorkplaceSeat => Boolean(value))
    .filter((seat) => Object.keys(record(record(seat.extension.metadata).assignmentActionClaim)).length > 0);
  if (seats.length === 0) return;
  // Recovery of an orphan/terminal action claim is deliberately more
  // expensive: prove the provider idle before clearing, then the begin RPC and
  // normal provider_checked phase prove it again under the resource lock.
  const snapshot = await freshProviderIdleProof(actor, context, dependencies);
  await assertControlledQueueProbeSafety(client, actor, context, capability, snapshot);
  for (const seat of seats) {
    await reconcileTerminalExtensionAssignmentClaim(client, actor.organizationId, seat.extension.id, {
      providerIdleProven: true,
      providerProofAt: snapshot.capturedAt,
    });
  }
}

export async function confirmDynamicWorkplaceChange(
  actor: MotoristActor,
  input: ConfirmDynamicSeatInput,
  dependencies: WorkplaceHandoffDependencies = {},
): Promise<DynamicWorkplaceResult> {
  const capability = requireHotdeskRuntimeCapability();
  requireResumeSecretKey(dependencies);
  if (input.operationId !== input.idempotencyKey) {
    throw new MutationError("Potvrdenie nezodpovedá pôvodnej požiadavke.", 409);
  }
  const client = dependencies.client ?? createSupabaseAdminClient();
  const repository = dependencies.repository ?? createWorkplaceOperationRepository(client);
  await recoverExpiredWorkplaceOperations(
    { organizationId: actor.organizationId, recoveryOwner: `request:${actor.profileId}` },
    { ...dependencies, client, repository },
  );
  const operation = await loadOperation(client, actor, input.operationId);
  if (!operation || operation.idempotency_key !== input.idempotencyKey) {
    throw new MutationError("Rozpracovaná zmena pracoviska sa nenašla.", 404);
  }
  if (operation.browser_instance_id !== input.browserInstanceId) {
    throw new MutationError("Zmenu pracoviska začalo iné okno prehliadača.", 409, "lease_lost");
  }
  return continueOperation(
    actor,
    operation,
    dependencies,
    client,
    repository,
    capability,
    true,
    input.browserDisconnectOutcome,
  );
}

/** Best-effort rollback when a browser disconnected but could not confirm. */
export async function cancelDynamicWorkplaceChange(
  actor: MotoristActor,
  input: ConfirmDynamicSeatInput,
  dependencies: WorkplaceHandoffDependencies = {},
): Promise<DynamicWorkplaceResult> {
  requireHotdeskRuntimeCapability();
  if (input.operationId !== input.idempotencyKey) {
    throw new MutationError("Zrušenie nezodpovedá pôvodnej požiadavke.", 409);
  }
  const client = dependencies.client ?? createSupabaseAdminClient();
  const repository = dependencies.repository ?? createWorkplaceOperationRepository(client);
  const operation = await loadOperation(client, actor, input.operationId);
  if (!operation || operation.idempotency_key !== input.idempotencyKey) {
    throw new MutationError("Rozpracovaná zmena pracoviska sa nenašla.", 404);
  }
  if (operation.browser_instance_id !== input.browserInstanceId) {
    throw new MutationError("Zmenu pracoviska začalo iné okno prehliadača.", 409, "lease_lost");
  }
  if (operation.phase === "aborted") {
    return {
      result: { state: "confirmed", noOp: true, message: "Rozpracovaná zmena už bola bezpečne zrušená." },
    };
  }
  if (
    operation.phase === "ownership_committed" || operation.phase === "audits_verified" ||
    operation.phase === "completed" || operation.phase === "manual_recovery_required"
  ) {
    throw new MutationError(
      "Zmenu už nemožno vrátiť späť; obnov pracovisko a dokonči jeho aktuálny stav.",
      409,
      "workplace_recovery_required",
    );
  }
  await repository.abort({
    organizationId: actor.organizationId,
    operationId: operation.id,
    claimGeneration: operation.claim_generation,
    errorSafe: "Browser cancelled precommit workplace change after disconnect/confirm failure.",
  }).catch(() => {
    throw new MutationError(
      "Zmenu sa nepodarilo jednoznačne zrušiť. Obnov pracovisko pred ďalšou akciou.",
      409,
      "workplace_recovery_required",
    );
  });
  return {
    result: { state: "confirmed", message: "Rozpracovaná zmena bola zrušená; pôvodné pracovisko zostalo pridelené." },
  };
}

/** Opportunistically aborts only DB-time-expired precommit operations. */
/** Default batch for the request path; the sweeper passes a larger bound. */
export const EXPIRED_OPERATION_RECOVERY_LIMIT = 10;

export type ExpiredOperationRecoveryOutcome = {
  recovered: number;
  /** Another owner legitimately holds recovery, or the row is not recoverable. */
  skipped: Array<{ operationId: string; reason: string }>;
  /** Anything else. The request path ignores these; the sweeper reports them. */
  failures: Array<{ operationId: string; reason: string }>;
};

/**
 * Recovers expired precommit operations.
 *
 * Takes an organization plus a recovery-owner label rather than an actor, so a
 * background sweeper can call it without fabricating a user. Failures are
 * returned rather than swallowed: request callers still ignore them (another
 * request may legitimately own recovery), but a sweeper running with no browser
 * open is the only thing that will ever notice a genuinely wedged claim.
 */
export async function recoverExpiredWorkplaceOperations(
  context: { organizationId: string; recoveryOwner: string },
  dependencies: WorkplaceHandoffDependencies = {},
  options: { limit?: number } = {},
): Promise<ExpiredOperationRecoveryOutcome> {
  const empty: ExpiredOperationRecoveryOutcome = { recovered: 0, skipped: [], failures: [] };
  const capability = workplaceHotdeskCapability();
  if (!capability.runtimeEnabled) return empty;
  const client = dependencies.client ?? createSupabaseAdminClient();
  const repository = dependencies.repository ?? createWorkplaceOperationRepository(client);
  const databaseNow = await repository.databaseNow();
  const stale = await client
    .from("motorist_workplace_operations")
    .select("id")
    .eq("organization_id", context.organizationId)
    .in("phase", ["created", "claimed", "browser_presence_checked", "provider_checked"])
    .lt("claim_expires_at", databaseNow)
    .order("claim_expires_at", { ascending: true })
    .limit(options.limit ?? EXPIRED_OPERATION_RECOVERY_LIMIT);
  if (stale.error) throw new MutationError("Uviaznuté zmeny pracovísk sa nepodarilo overiť.", 500);

  const outcome: ExpiredOperationRecoveryOutcome = { recovered: 0, skipped: [], failures: [] };
  for (const operation of stale.data ?? []) {
    try {
      await repository.recoverExpired({
        organizationId: context.organizationId,
        operationId: operation.id,
        recoveryOwner: context.recoveryOwner,
      });
      outcome.recovered += 1;
    } catch (error) {
      // Another request may own recovery, and a non-recoverable row is a
      // deliberate fail-closed outcome. Neither is a fault; anything else is.
      const reason = recoveryFailureReason(error);
      const expected = reason.includes("WORKPLACE_OPERATION_CLAIM_MISMATCH") ||
        reason.includes("WORKPLACE_RECOVERY_STATE_MISMATCH") ||
        reason.includes("WORKPLACE_OPERATION_NOT_RECOVERABLE") ||
        reason.includes("WORKPLACE_OPERATION_MUST_ROLL_FORWARD");
      (expected ? outcome.skipped : outcome.failures).push({ operationId: operation.id, reason });
    }
  }
  return outcome;
}

function recoveryFailureReason(error: unknown) {
  if (error instanceof WorkplaceOperationRepositoryError) {
    return error.causeSafe ?? error.message;
  }
  return error instanceof Error ? error.message : "unknown recovery failure";
}

async function continueOperation(
  actor: MotoristActor,
  operation: OperationRow,
  dependencies: WorkplaceHandoffDependencies,
  client: AdminClient,
  repository: WorkplaceOperationRepository,
  capability: WorkplaceHotdeskCapability,
  confirmedAfterDisconnect: boolean,
  browserDisconnectOutcome?: "accepted" | "not_connected",
) {
  if (operation.phase === "aborted") {
    throw new MutationError(
      "Predchádzajúca zmena bola bezpečne zrušená. Začni novú požiadavku.",
      409,
      "workplace_precommit_aborted",
    );
  }
  if (operation.phase === "manual_recovery_required") {
    throw new MutationError("Zmena pracoviska vyžaduje kontrolu správcom.", 409, "workplace_recovery_required");
  }
  if (operation.phase === "completed") {
    const target = await loadCompletedOperationTarget(client, actor, operation);
    return completedOperationResult(operation, target, dependencies);
  }
  const targetNumber = operation.target_extension_id
    ? await loadExtensionNumber(client, actor.organizationId, operation.target_extension_id)
    : undefined;
  const loadedContext = await loadWorkplaceContext(client, actor, targetNumber);
  const context = operation.kind === "browser_transfer"
    ? { ...loadedContext, source: undefined }
    : loadedContext;
  assertOperationStillMatches(operation, context);
  if (context.source) assertSourceCanBeVacated(context.source, capability, actor);
  if (operation.phase !== "claimed" && operation.phase !== "browser_presence_checked" && operation.phase !== "provider_checked") {
    throw new MutationError("Zmena pracoviska má neznámy rozpracovaný stav.", 409, "workplace_recovery_required");
  }
  if (!operation.source_extension_id) {
    return finishOperation(actor, operation.id, context, dependencies, client, repository, capability);
  }
  if (confirmedAfterDisconnect) {
    // Only the explicit confirmation may cross the browser-disconnect barrier.
    // Replaying the original select/leave request must stay idempotently parked
    // here and must never infer that the SIP phone has already disconnected.
    return finishOperation(
      actor,
      operation.id,
      context,
      dependencies,
      client,
      repository,
      capability,
      {
        waitForSourceUnregister: true,
        browserDisconnectConfirmed: Boolean(browserDisconnectOutcome),
      },
    );
  }
  return {
    result: {
      state: "disconnect_required" as const,
      operationId: operation.id,
      message: "Najprv odpoj telefón a potom zmenu potvrď.",
    },
  };
}

async function beginOperation(
  actor: MotoristActor,
  input: DynamicSeatInput,
  kind: WorkplaceOperationKind,
  context: WorkplaceContext,
  client: AdminClient,
  repository: WorkplaceOperationRepository,
) {
  const resources = canonicalTelephonyResourceClaims([
    { resourceType: "profile", resourceId: actor.profileId },
    // Independent operators must be able to claim, switch, and leave distinct
    // workplaces concurrently. Routing already participates in the same
    // extension-level barrier through assignmentActionClaim plus the durable
    // extension resource claim, so a global routing-plan claim only turns an
    // unrelated VIPTel unregister delay into an organization-wide hotdesk
    // outage.
    ...(context.source
      ? [
          { resourceType: "extension" as const, resourceId: context.source.extension.id },
          { resourceType: "workplace_lease" as const, resourceId: context.source.lease!.id },
        ]
      : []),
    ...(context.target
      ? [
          { resourceType: "extension" as const, resourceId: context.target.extension.id },
          ...(context.target.lease
            ? [{ resourceType: "workplace_lease" as const, resourceId: context.target.lease.id }]
            : []),
          ...(context.target.extension.profile_id
            ? context.target.extension.profile_id === actor.profileId
              ? []
              : [{ resourceType: "profile" as const, resourceId: context.target.extension.profile_id }]
            : []),
        ]
      : []),
  ]);
  const intent = {
    organizationId: actor.organizationId,
    actorProfileId: actor.profileId,
    kind,
    sourceExtensionId: context.source?.extension.id ?? null,
    targetExtensionId: context.target?.extension.id ?? null,
    browserInstanceId: input.browserInstanceId,
  };
  const beginInput = {
      operationId: input.idempotencyKey,
      organizationId: actor.organizationId,
      idempotencyKey: input.idempotencyKey,
      intentHash: workplaceOperationIntentHash(intent),
      kind,
      actorProfileId: actor.profileId,
      sourceExtensionId: intent.sourceExtensionId,
      targetExtensionId: intent.targetExtensionId,
      sourceLeaseId: context.source?.lease?.id ?? null,
      targetLeaseId: context.target?.lease?.id ?? null,
      browserInstanceId: input.browserInstanceId,
      expectedSourceAssignmentGeneration: context.source?.lease?.assignmentGeneration ?? null,
      expectedTargetAssignmentGeneration: context.target?.lifecycle.epoch ?? null,
      expectedSourceLeaseVersion: context.source?.lease?.leaseVersion ?? null,
      expectedTargetLeaseVersion: context.target?.lease?.leaseVersion ?? null,
      expectedSourceHeartbeatAt: context.source?.lease?.heartbeatAt ?? null,
      expectedTargetHeartbeatAt: context.target?.lease?.heartbeatAt ?? null,
      resources: toResourceClaimsJson(resources) as Json,
    };
  try {
    return await repository.begin(beginInput);
  } catch (error) {
    let persisted: OperationRow | undefined;
    try {
      persisted = await loadExistingOperation(client, actor, input.idempotencyKey);
    } catch {
      throw new MutationError(
        "Výsledok začatia zmeny pracoviska sa nepodarilo jednoznačne overiť. Obnov rovnakú požiadavku.",
        503,
        "workplace_recovery_required",
      );
    }
    if (persisted && exactBeginOperationMatches(persisted, beginInput)) {
      if (persisted.phase === "manual_recovery_required") {
        throw new MutationError("Zmena pracoviska vyžaduje kontrolu správcom.", 409, "workplace_recovery_required");
      }
      if (persisted.phase !== "aborted") {
        return { operationId: persisted.id };
      }
      // Same terminal signal continueOperation gives for an aborted phase: a
      // replay of this exact request is pointless, a fresh attempt is needed.
      throw new MutationError(
        "Predchádzajúca zmena bola bezpečne zrušená. Začni novú požiadavku.",
        409,
        "workplace_precommit_aborted",
      );
    }
    const classified = classifyWorkplaceBeginFailure(error);
    if (classified) throw classified;
    throw new MutationError(
      "Pracovné miesto medzitým zmenila iná požiadavka. Obnov stav a skús to znova.",
      409,
      "workplace_conflict",
    );
  }
}

function exactBeginOperationMatches(
  operation: OperationRow,
  input: {
    operationId: string;
    organizationId: string;
    idempotencyKey: string;
    intentHash: string;
    kind: WorkplaceOperationKind;
    actorProfileId: string;
    sourceExtensionId: string | null;
    targetExtensionId: string | null;
    sourceLeaseId: string | null;
    targetLeaseId: string | null;
    browserInstanceId: string;
    expectedSourceAssignmentGeneration: string | null;
    expectedTargetAssignmentGeneration: string | null;
    expectedSourceLeaseVersion: number | null;
    expectedTargetLeaseVersion: number | null;
    expectedSourceHeartbeatAt: string | null;
    expectedTargetHeartbeatAt: string | null;
  },
) {
  return operation.id === input.operationId && operation.organization_id === input.organizationId &&
    operation.idempotency_key === input.idempotencyKey && operation.intent_hash === input.intentHash &&
    operation.kind === input.kind && operation.actor_profile_id === input.actorProfileId &&
    operation.source_extension_id === input.sourceExtensionId && operation.target_extension_id === input.targetExtensionId &&
    operation.source_lease_id === input.sourceLeaseId && operation.target_lease_id === input.targetLeaseId &&
    operation.browser_instance_id === input.browserInstanceId &&
    operation.expected_source_assignment_generation === input.expectedSourceAssignmentGeneration &&
    operation.expected_target_assignment_generation === input.expectedTargetAssignmentGeneration &&
    operation.expected_source_lease_version === input.expectedSourceLeaseVersion &&
    operation.expected_target_lease_version === input.expectedTargetLeaseVersion &&
    operation.expected_source_heartbeat_at === input.expectedSourceHeartbeatAt &&
    operation.expected_target_heartbeat_at === input.expectedTargetHeartbeatAt;
}

async function finishOperation(
  actor: MotoristActor,
  operationId: string,
  context: WorkplaceContext,
  dependencies: WorkplaceHandoffDependencies,
  client: AdminClient,
  repository: WorkplaceOperationRepository,
  capability: WorkplaceHotdeskCapability,
  options: {
    browserDisconnectConfirmed?: boolean;
    waitForSourceUnregister?: boolean;
  } = {},
): Promise<DynamicWorkplaceResult> {
  const operation = await loadOperation(client, actor, operationId);
  if (!operation) throw new MutationError("Rozpracovaná zmena pracoviska sa nenašla.", 404);
  if (operation.phase === "completed") {
    const completedTarget = await loadCompletedOperationTarget(client, actor, operation);
    return completedOperationResult(operation, completedTarget, dependencies);
  }
  let providerMarked = operation.phase === "provider_checked";
  let lifecycleAt = operation.provider_checked_at ?? operation.locked_at;
  try {
    if (!providerMarked) {
      // The begin RPC has already locked the target against a live browser. An
      // expired owner, or a canonical unowned seat with no lease, can retain a
      // stale registrar Contact after an interrupted release. The newly
      // assigned browser clears the complete hotdesk AOR before it becomes
      // Ready. Calls, queue in-use state and every other provider invariant
      // remain mandatory below.
      const allowRegisteredTarget = Boolean(
        context.target && (
          operation.target_lease_id && context.target.extension.profile_id &&
          (operation.kind === "takeover" || operation.kind === "switch" || operation.kind === "browser_transfer") ||
          operation.kind === "claim" && !operation.target_lease_id &&
          !context.target.extension.profile_id && context.target.extension.is_registered === true
        ),
      );
      // VIPTel's REST registration bit is an observed cache and remained true
      // for about one minute in production after its SIP registrar had already
      // accepted the wildcard un-REGISTER. An exact authenticated browser
      // confirmation may therefore waive only that stale boolean. We still
      // require a fresh provider snapshot and validate active calls, queue
      // in-use state, endpoint uniqueness, pending commands and every target.
      const snapshot = options.waitForSourceUnregister && context.source && !options.browserDisconnectConfirmed
        ? await waitForSourceProviderUnregister(
            actor,
            context,
            dependencies,
            client,
            capability,
            { allowRegisteredTarget },
          )
        : await freshProviderProof(
            actor,
            context,
            dependencies,
            client,
            capability,
            {
              allowRegisteredSource: Boolean(options.browserDisconnectConfirmed && context.source),
              allowRegisteredTarget,
            },
          );
      const marked = await repository.markProviderChecked({
        organizationId: actor.organizationId,
        operationId,
        claimGeneration: operation.claim_generation,
        providerProofHash: providerProofHash(snapshot, context),
      });
      providerMarked = true;
      lifecycleAt = marked.databaseNow;
    }
  } catch (error) {
    // A successful SIP unregister can remain visible as registered in VIPTel
    // for tens of seconds. Keep the exact precommit journal and its resource
    // claim so the same confirm request can safely prove convergence later.
    // Every other provider blocker still aborts below.
    if (error instanceof WorkplaceSourceUnregisterPendingError) throw error;
    await safeAbort(repository, actor.organizationId, operation, safeError(error));
    // The abort above is a definite outcome: the precommit is rolled back and
    // replaying the identical request can never succeed. Rethrowing a codeless
    // 5xx here (the provider-snapshot timeout is a 504) made the client treat
    // it as a possibly-committed lost response, arm the exact-replay journal,
    // and refuse every other workplace action while it spun -- the operator
    // could then neither leave nor set themselves available. The code marks
    // the outcome as final so the client clears the journal and retries fresh.
    if (error instanceof MutationError) {
      throw error.code ? error : new MutationError(error.message, error.status, "workplace_precommit_aborted");
    }
    throw new MutationError(
      "Zmena pracoviska sa bezpečne zrušila a pôvodný stav zostal zachovaný. Skús akciu znova.",
      500,
      "workplace_precommit_aborted",
    );
  }
  if (!lifecycleAt) {
    throw new MutationError("Databázový čas zmeny pracoviska chýba.", 409, "workplace_recovery_required");
  }

  const ids = dependencies.randomId ?? randomUUID;
  const newLeaseId = context.target ? ids() : null;
  const newGeneration = context.target ? ids() : null;
  const resumeSecret = newLeaseId
    ? deriveResumeSecret(dependencies, operation.id, newLeaseId, operation.browser_instance_id)
    : undefined;
  const sourceLifecycle = context.source
    ? unassignedLifecycle(context.source.lifecycle, {
        unassignedAt: lifecycleAt,
        unassignedBy: actor.profileId,
      })
    : undefined;
  const targetLifecycle = context.target && newGeneration
    ? assignedLifecycle({
        assignedAt: lifecycleAt,
        assignedBy: actor.profileId,
        assignmentMode: "workplace_claim",
        epoch: newGeneration,
        extension: context.target.extension.extension,
        extensionId: context.target.extension.id,
        profileId: actor.profileId,
      })
    : undefined;
  try {
    const finalized = await repository.finalize({
      organizationId: actor.organizationId,
      operationId,
      claimGeneration: operation.claim_generation,
      newLeaseId,
      newAssignmentGeneration: newGeneration,
      newBrowserInstanceId: context.target ? operation.browser_instance_id : null,
      newResumeSecretHash: resumeSecret ? sha256(resumeSecret) : null,
      sourceLifecycle: sourceLifecycle ? lifecycleAuditPayload(sourceLifecycle) : null,
      targetLifecycle: targetLifecycle ? lifecycleAuditPayload(targetLifecycle) : null,
      sourceUnassignAuditId: context.source ? ids() : null,
      targetUnassignAuditId: null,
      targetAssignAuditId: context.target ? ids() : null,
    });
    if (!context.target || !finalized.leaseId || !finalized.assignmentGeneration || !finalized.expiresAt ||
        !finalized.leaderEpoch || !finalized.leaseVersion) {
      return { result: { state: "confirmed", message: "Pracovné miesto je uvoľnené." } };
    }
    return {
      result: { state: "confirmed", message: `Pracovné miesto ${context.target.extension.extension} je pripravené.` },
      lease: {
        leaseId: finalized.leaseId,
        seatId: context.target.extension.id,
        extension: context.target.extension.extension,
        assignmentGeneration: finalized.assignmentGeneration,
        leaderEpoch: finalized.leaderEpoch,
        leaseVersion: finalized.leaseVersion,
        expiresAt: finalized.expiresAt,
        heartbeatIntervalMs: 15_000,
      },
      resumeSecret,
    };
  } catch (error) {
    // The finalize RPC is atomic. An exact primary readback therefore splits a
    // lost successful response (roll forward) from a validation failure that
    // never crossed the ownership commit (safe abort). If readback itself is
    // unavailable, retain the claim and fail closed for recovery.
    let readback: OperationRow | undefined;
    try {
      readback = await loadOperation(client, actor, operationId);
    } catch {
      readback = undefined;
    }
    if (readback?.phase === "completed") {
      try {
        const completedTarget = await loadCompletedOperationTarget(client, actor, readback);
        return completedOperationResult(readback, completedTarget, dependencies);
      } catch {
        throw new MutationError(
          "Vlastníctvo sa uložilo, ale jeho potvrdený výsledok sa nepodarilo načítať. Obnov pracovisko.",
          409,
          "workplace_recovery_required",
        );
      }
    }
    if (
      readback &&
      ["created", "claimed", "browser_presence_checked", "provider_checked"].includes(readback.phase)
    ) {
      await safeAbort(repository, actor.organizationId, readback, safeError(error));
      throw new MutationError(
        "Zmena sa neuložila a pôvodné pracovisko zostalo zachované. Obnov stav a skús to znova.",
        409,
        "workplace_conflict",
      );
    }
    throw new MutationError(
      "Výsledok zmeny sa nepodarilo jednoznačne potvrdiť. Obnov pracovisko; požiadavku neopakuj s novým identifikátorom.",
      409,
      "workplace_recovery_required",
    );
  }
}

async function waitForSourceProviderUnregister(
  actor: MotoristActor,
  context: WorkplaceContext,
  dependencies: WorkplaceHandoffDependencies,
  client: AdminClient,
  capability: WorkplaceHotdeskCapability,
  options: ProviderProofOptions = {},
) {
  const sourceExtension = context.source?.extension.extension;
  if (!sourceExtension) return freshProviderProof(actor, context, dependencies, client, capability, options);
  try {
    // Prove every invariant while permitting only the source's lingering
    // registrar Contact. Registration convergence is deliberately checked
    // once per exact confirmation request. The durable browser journal owns
    // the bounded retries; nesting six provider captures inside every retry
    // multiplied a normal 1-2 second VIPTel read into minute-long actions.
    const snapshot = await freshProviderProof(actor, context, dependencies, client, capability, {
      ...options,
      allowRegisteredSource: true,
    });
    assertExactWorkplaceProviderState(sourceExtension, context.source?.queue ?? null, snapshot, {
      allowOffline: true,
      allowPaused: true,
    });
    return snapshot;
  } catch (error) {
    const sourceStillRegistered = error instanceof WorkplaceProviderRegisteredError &&
      error.extension === sourceExtension;
    if (!sourceStillRegistered) throw error;
    throw new WorkplaceSourceUnregisterPendingError(sourceExtension);
  }
}

function classifyWorkplaceBeginFailure(error: unknown) {
  if (!(error instanceof WorkplaceOperationRepositoryError) || error.operation !== "begin") return undefined;
  const cause = error.causeSafe ?? "";
  if (cause.includes("WORKPLACE_TARGET_ACTIVE")) {
    return new MutationError(
      "Predchádzajúce okno toto pracovné miesto ešte aktívne obnovuje. Zavri ho alebo počkaj najviac minútu a potom miesto obnov znova.",
      409,
      "lease_lost",
    );
  }
  if (
    cause.includes("WORKPLACE_SOURCE_LEASE_EXPIRED") ||
    cause.includes("WORKPLACE_SOURCE_LEASE_MISMATCH")
  ) {
    return new MutationError(
      "Relácia tohto okna už nie je aktuálna. Obnov rovnaké pracovné miesto; potom ho bude možné uvoľniť alebo zmeniť.",
      409,
      "lease_lost",
    );
  }
  if (cause.includes("WORKPLACE_TARGET_LEASE_MISMATCH")) {
    return new MutationError(
      "Stará relácia pracovného miesta sa práve zmenila. Obnov stav a zopakuj výber iba raz.",
      409,
      "workplace_conflict",
    );
  }
  if (cause.includes("TELEPHONY_RESOURCE_BUSY")) {
    return new MutationError(
      "Pracovné miesto práve dokončuje inú telefonickú akciu. Po jej skončení obnov stav a skús zmenu znova.",
      409,
      "workplace_conflict",
    );
  }
  if (cause.includes("WORKPLACE_IDEMPOTENCY_CONFLICT")) {
    // The generic fallback used to tell the operator to refresh and try again,
    // which can never work here: the request is rejected precisely because this
    // idempotency key already exists with different content. Repeating the same
    // action reuses the same key and fails identically.
    return new MutationError(
      "Táto požiadavka už existuje s iným obsahom. Obnov pracovisko a začni novú akciu; to isté tlačidlo znova nepomôže.",
      409,
      "workplace_conflict",
    );
  }
  if (cause.includes("WORKPLACE_ACTOR_ALREADY_HAS_SEAT")) {
    return new MutationError(
      "Máš už priradené iné pracovné miesto. Najprv ho uvoľni, alebo použi zmenu miesta.",
      409,
      "workplace_conflict",
    );
  }
  return undefined;
}

/**
 * A terminal replay must not depend on the mutable queue/draft state. A
 * priority saga may legitimately start immediately after ownership commits.
 * Read only the exact target and terminal lease; expose the resume secret only
 * while that lease is still the actor's current, active assignment.
 */
async function loadCompletedOperationTarget(
  client: AdminClient,
  actor: MotoristActor,
  operation: OperationRow,
): Promise<CompletedOperationTarget | undefined> {
  if (!operation.target_extension_id) return undefined;
  const safeResult = record(operation.result_safe);
  const leaseId = uuid(safeResult.leaseId);
  const assignmentGeneration = uuid(safeResult.assignmentGeneration);
  const [extensionResult, leaseResult] = await Promise.all([
    client
      .from("motorist_telephony_extensions")
      .select("*")
      .eq("organization_id", actor.organizationId)
      .eq("id", operation.target_extension_id)
      .eq("provider", PROVIDER)
      .maybeSingle(),
    leaseId
      ? client
          .from("motorist_workplace_leases")
          .select("*")
          .eq("organization_id", actor.organizationId)
          .eq("id", leaseId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (extensionResult.error || leaseResult.error || !extensionResult.data) {
    throw new MutationError(
      "Uložený výsledok pracoviska sa nepodarilo načítať.",
      409,
      "workplace_recovery_required",
    );
  }

  const extension = extensionResult.data;
  const parsedLease = readWorkplaceLease(leaseResult.data);
  const lifecycle = readAssignmentLifecycle(record(extension.metadata).assignmentLifecycle);
  const leaseIsCurrent = Boolean(
    leaseId &&
    assignmentGeneration &&
    parsedLease &&
    (parsedLease.state === "active" || parsedLease.state === "ending") &&
    parsedLease.id === leaseId &&
    parsedLease.organizationId === actor.organizationId &&
    parsedLease.extensionId === extension.id &&
    parsedLease.profileId === actor.profileId &&
    parsedLease.assignmentGeneration === assignmentGeneration &&
    parsedLease.browserInstanceId === operation.browser_instance_id &&
    extension.profile_id === actor.profileId &&
    extension.workplace_seat_generation &&
    lifecycle?.state === "assigned" &&
    lifecycle.extensionId === extension.id &&
    lifecycle.extension === extension.extension &&
    lifecycle.profileId === actor.profileId &&
    lifecycle.epoch === assignmentGeneration &&
    lifecycle.assignmentMode === "workplace_claim"
  );
  return {
    extension,
    ...(leaseIsCurrent && parsedLease ? { lease: parsedLease } : {}),
  };
}

async function loadWorkplaceContext(
  client: AdminClient,
  actor: MotoristActor,
  targetNumber?: string,
): Promise<WorkplaceContext> {
  const [extensionsResult, queuesResult] = await Promise.all([
    client
      .from("motorist_telephony_extensions")
      .select("*")
      .eq("organization_id", actor.organizationId)
      .eq("provider", PROVIDER)
      .eq("active", true)
      .in("extension", configuredPersonalExtensions()),
    client
      .from("motorist_telephony_queues")
      .select("id, external_id, metadata, updated_at")
      .eq("organization_id", actor.organizationId)
      .eq("provider", PROVIDER)
      .eq("active", true)
      .in("external_id", [...DISPATCH_QUEUE_NUMBERS]),
  ]);
  if (extensionsResult.error || queuesResult.error) {
    throw new MutationError("Dynamické pracoviská sa nepodarilo načítať.", 500);
  }
  const extensions = extensionsResult.data ?? [];
  const sources = extensions.filter((extension) => extension.profile_id === actor.profileId);
  if (sources.length > 1) throw new MutationError("Operátor má nejednoznačné pracovné miesto.", 409);
  const targetExtension = targetNumber
    ? extensions.find((extension) => extension.extension === targetNumber)
    : undefined;
  if (targetNumber && !targetExtension) throw new MutationError(`Pracovné miesto ${targetNumber} nie je aktívne.`, 404);
  const roots = (queuesResult.data ?? []).filter((queue) => queue.external_id === "601");
  if (roots.length !== 1 || (queuesResult.data ?? []).length !== 3) {
    throw new MutationError("Katalóg poradia 601–603 nie je úplný.", 409);
  }
  const root = roots[0] as QueueRow;
  const routing = parseDispatchRoutingState(root.metadata);
  if (routing.operation) throw new MutationError("VIPTel práve mení poradie. Počkaj na dokončenie.", 409);
  const draft = readApplicableWorkplacePriorityDraft(root.metadata, routing.revision, {
    organizationId: actor.organizationId,
    rootQueueId: root.id,
  });
  if (draft && !samePlan(draft, routing.currentPlan)) {
    throw new MutationError("Najprv dokonči alebo obnov rozpracovanú zmenu poradia.", 409);
  }
  const relevantIds = new Set([sources[0]?.id, targetExtension?.id].filter((value): value is string => Boolean(value)));
  const leasesResult = relevantIds.size === 0
    ? { data: [], error: null }
    : await client
        .from("motorist_workplace_leases")
        .select("*")
        .eq("organization_id", actor.organizationId)
        .in("extension_id", [...relevantIds])
        .in("state", ["active", "ending"]);
  if (leasesResult.error) throw new MutationError("Relácie pracovísk sa nepodarilo načítať.", 500);
  const leases = (leasesResult.data ?? []).map((row) => {
    const lease = readWorkplaceLease(row);
    if (!lease) throw new MutationError("Uložená relácia pracoviska je neplatná.", 409);
    return lease;
  });
  const seat = async (extension: ExtensionRow | undefined): Promise<WorkplaceSeat | undefined> => {
    if (!extension) return undefined;
    if (!extension.workplace_seat_generation || hasActiveAssignmentTransitionMetadata(extension.metadata)) {
      throw new MutationError(
        `Pracovné miesto ${extension.extension} ešte nie je bezpečne pripravené na dynamické používanie.`,
        409,
        "workplace_bootstrap_required",
      );
    }
    const lifecycle = await requireImmutableWorkplaceSeatLifecycle(client, actor.organizationId, extension);
    const matches = leases.filter((lease) => lease.extensionId === extension.id);
    if (matches.length > 1) throw new MutationError("Pracovné miesto má viac aktívnych relácií.", 409);
    const lease = matches[0];
    if (
      (extension.profile_id === null) !== (lease === undefined) ||
      (lease && (lease.profileId !== extension.profile_id || lease.assignmentGeneration !== lifecycle.epoch))
    ) {
      throw new MutationError("Vlastník pracoviska a jeho relácia sa nezhodujú.", 409);
    }
    return {
      extension,
      lifecycle,
      lease,
      queue: queueFor(routing.currentPlan, extension.extension),
    };
  };
  return {
    root,
    plan: routing.currentPlan,
    source: await seat(sources[0]),
    target: await seat(targetExtension),
  };
}

async function freshProviderProof(
  actor: MotoristActor,
  context: WorkplaceContext,
  dependencies: WorkplaceHandoffDependencies,
  client: AdminClient,
  capability: WorkplaceHotdeskCapability,
  options: ProviderProofOptions = {},
) {
  const snapshot = await freshProviderIdleProof(actor, context, dependencies, options);
  await assertNoPendingCommands(client, actor.organizationId, [context.source, context.target]
    .filter((value): value is WorkplaceSeat => Boolean(value)));
  await assertControlledQueueProbeSafety(client, actor, context, capability, snapshot);
  return snapshot;
}

async function freshProviderIdleProof(
  actor: MotoristActor,
  context: WorkplaceContext,
  dependencies: WorkplaceHandoffDependencies,
  options: ProviderProofOptions = {},
) {
  let snapshot: Pick<ViptelProviderSnapshot, "activeCalls" | "capturedAt" | "extensions" | "queueStatuses">;
  try {
    snapshot = dependencies.requestProviderSnapshot
      ? await dependencies.requestProviderSnapshot(actor.organizationId, actor.profileId)
      : await requestViptelProviderSnapshot(actor.organizationId, actor.profileId, {
          maxAgeMs: 2_000,
          requireNewCapture: true,
        });
  } catch (error) {
    if (error instanceof MutationError) throw error;
    throw new MutationError("Živý stav VIPTel sa nepodarilo overiť. Miesto zostalo bez zmeny.", 502);
  }
  for (const seat of [context.source, context.target].filter((value): value is WorkplaceSeat => Boolean(value))) {
    // Paused is a safe queue availability state, not evidence of a live owner.
    // Preserve it across ownership handoff; the new operator explicitly chooses
    // Dostupný after their browser phone connects. Registration/call/inUse and
    // ambiguous provider evidence remain hard blockers.
    assertExactWorkplaceProviderState(seat.extension.extension, seat.queue, snapshot, {
      allowOffline: true,
      allowPaused: true,
      allowRegistered:
        (options.allowRegisteredSource === true && seat === context.source) ||
        (options.allowRegisteredTarget === true && seat === context.target),
    });
  }
  return snapshot;
}

async function assertControlledQueueProbeSafety(
  client: AdminClient,
  actor: MotoristActor,
  context: WorkplaceContext,
  capability: WorkplaceHotdeskCapability,
  snapshot: Pick<ViptelProviderSnapshot, "capturedAt" | "queueStatuses">,
) {
  const source = context.source;
  if (!source?.queue || capability.mode === "production_revocable") return;
  if (!canVacateQueuedWorkplace(capability, {
    profileId: actor.profileId,
    sourceExtension: source.extension.extension,
  })) {
    throw new MutationError(
      "Kontrolovaný test uvoľnenia radu nie je povolený pre toto pracovné miesto a účet.",
      409,
      "queue_probe_scope_mismatch",
    );
  }
  // The acknowledged production pilot intentionally has no controlled-probe
  // audit/window infrastructure. The fresh provider-idle and pending-command
  // checks above still run; only this trusted-test-specific proof is skipped.
  if (capability.mode === "production_static_pilot") return;
  const probe = capability.queueProbe;
  const evidenceId = capability.queueEvidenceId;
  if (!probe || !evidenceId) {
    throw new MutationError("Kontrolovaný test radu nemá úplnú bezpečnostnú konfiguráciu.", 409, "queue_probe_scope_mismatch");
  }
  const capturedAt = timestamp(snapshot.capturedAt);
  if (!capturedAt || capturedAt < probe.startsAt || capturedAt > probe.endsAt) {
    throw new MutationError(
      "Kontrolovaný test uvoľnenia radu je mimo schváleného časového okna.",
      409,
      "queue_probe_window_closed",
    );
  }
  const queueStatuses = DISPATCH_QUEUE_NUMBERS.map((queue) =>
    snapshot.queueStatuses.filter((status) => status.queue === queue));
  if (
    queueStatuses.some((matches) => matches.length !== 1) ||
    queueStatuses.some(([status]) => status.waitingCalls !== 0)
  ) {
    throw new MutationError(
      "Kontrolovaný test nemožno vykonať: všetky rady 601–603 musia mať čerstvo potvrdených 0 čakajúcich hovorov.",
      409,
      "queue_probe_waiting_calls",
    );
  }
  const evidence = await client
    .from("motorist_audit_log")
    .select("id, action, entity_type, entity_id, after_payload")
    .eq("id", evidenceId)
    .eq("organization_id", actor.organizationId)
    .eq("action", CONTROLLED_QUEUE_PROBE_AUDIT_ACTION)
    .eq("entity_type", "motorist_telephony_queues")
    .eq("entity_id", context.root.id)
    .maybeSingle();
  if (evidence.error) throw new MutationError("Schválenie kontrolovaného testu radu sa nepodarilo overiť.", 500);
  const approved = record(evidence.data?.after_payload);
  if (
    !evidence.data || evidence.data.id !== evidenceId ||
    approved.schemaVersion !== 1 || approved.capability !== "controlled_probe" ||
    approved.organizationId !== actor.organizationId || approved.profileId !== actor.profileId ||
    approved.sourceExtension !== source.extension.extension || approved.rootQueueId !== context.root.id ||
    approved.startsAt !== probe.startsAt || approved.endsAt !== probe.endsAt ||
    approved.fallbackReference !== probe.fallbackReference
  ) {
    throw new MutationError(
      "Konfigurácia kontrolovaného testu nezodpovedá nemennému schváleniu.",
      409,
      "queue_probe_evidence_mismatch",
    );
  }
}

async function assertNoPendingCommands(client: AdminClient, organizationId: string, seats: WorkplaceSeat[]) {
  const result = await client
    .from("motorist_telephony_commands")
    .select("id, call_id, extension_id, request_payload, provider_response, command_type, status")
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .in("status", [...NON_TERMINAL_COMMAND_STATUSES])
    .order("created_at", { ascending: true })
    .limit(COMMAND_SCAN_LIMIT);
  if (result.error) throw new MutationError("Rozpracované telefonické príkazy sa nepodarilo overiť.", 500);
  if ((result.data?.length ?? 0) >= COMMAND_SCAN_LIMIT) {
    throw new MutationError("Fronta telefonických príkazov je príliš veľká na bezpečné overenie.", 409);
  }
  const potentiallyBlocking = [];
  for (const command of result.data ?? []) {
    if (command.command_type === "call.transfer.dtmf" && command.status === "accepted" &&
        await hasTerminalDtmfDeliveryAudit(client, organizationId, command)) continue;
    potentiallyBlocking.push(command);
  }
  const terminalBrowserTransferCallIds = await loadTerminalAcceptedBrowserTransferCallIds(client, organizationId, potentiallyBlocking);
  for (const seat of seats) {
    if (hasBlockingExtensionCommand(potentiallyBlocking, seat.extension.id, seat.extension.extension, {
      terminalBrowserTransferCallIds,
    })) {
      throw new MutationError(`Pracovné miesto ${seat.extension.extension} má rozpracovaný telefonický príkaz.`, 409);
    }
  }
}

async function hasTerminalDtmfDeliveryAudit(
  client: AdminClient,
  organizationId: string,
  command: { id: string; call_id: string | null; extension_id: string | null; provider_response: Json | null },
) {
  const delivery = record(record(command.provider_response).browserDtmfDelivery);
  if (delivery.outcome === "complete" || delivery.outcome === "partial") return true;
  if (!command.call_id || !command.extension_id) return false;
  const audit = await client
    .from("motorist_audit_log")
    .select("after_payload")
    .eq("organization_id", organizationId)
    .eq("action", "telephony.command.browser_dtmf.delivery")
    .eq("entity_type", "motorist_calls")
    .eq("entity_id", command.call_id)
    .contains("after_payload", {
      browser_dtmf_delivery: { commandId: command.id, extensionId: command.extension_id },
    })
    .limit(2);
  if (audit.error || (audit.data?.length ?? 0) > 1) {
    throw new MutationError("Nemenný výsledok DTMF prepojenia sa nepodarilo jednoznačne overiť.", 500);
  }
  const outcome = record(record(audit.data?.[0]?.after_payload).browser_dtmf_delivery).delivery;
  const value = record(outcome).outcome;
  return value === "complete" || value === "partial";
}

function assertSeatEligibility(target: WorkplaceSeat, kind: WorkplaceOperationKind) {
  if (!target.extension.profile_id) {
    if (target.lease) throw new MutationError("Voľné pracovisko má nečakanú aktívnu reláciu.", 409);
    return;
  }
  if (kind !== "takeover" && kind !== "switch" && kind !== "browser_transfer") {
    throw new MutationError("Pracovisko je obsadené.", 409);
  }
  if (!target.lease) throw new MutationError("Obsadené pracovisko nemá zhodnú reláciu a nemožno ho prevziať.", 409);
  // Freshness is decided only inside begin RPC with PostgreSQL clock time.
}

function assertSourceLease(source: WorkplaceSeat, actor: MotoristActor, browserInstanceId: string) {
  if (!source.lease || source.lease.profileId !== actor.profileId || source.lease.browserInstanceId !== browserInstanceId) {
    throw new MutationError("Aktuálne pracovisko používa iné okno alebo reláciu.", 409, "lease_lost");
  }
}

function assertSourceCanBeVacated(
  source: WorkplaceSeat,
  capability: WorkplaceHotdeskCapability,
  actor: MotoristActor,
) {
  if (source.queue && !canVacateQueuedWorkplace(capability, {
    profileId: actor.profileId,
    sourceExtension: source.extension.extension,
  })) {
    throw new MutationError(
      `Pracovné miesto ${source.extension.extension} je v rade ${source.queue}. Bez overeného preskočenia prázdneho miesta ho zatiaľ nemožno opustiť.`,
      409,
      "queue_vacate_not_verified",
    );
  }
}

async function existingOwnerResult(
  actor: MotoristActor,
  target: WorkplaceSeat,
  browserInstanceId: string,
  client: AdminClient,
  repository: WorkplaceOperationRepository,
): Promise<DynamicWorkplaceResult> {
  if (!target.lease || target.lease.profileId !== actor.profileId) {
    throw new MutationError("Vlastníctvo pracoviska nemá zhodnú aktívnu reláciu.", 409);
  }
  if (target.lease.browserInstanceId !== browserInstanceId) {
    throw new MutationError("Pracovisko používa iné okno. Použi bezpečné obnovenie relácie.", 409, "lease_lost");
  }
  const fence = {
    leaseId: target.lease.id,
    assignmentGeneration: target.lease.assignmentGeneration,
    browserInstanceId,
    leaderEpoch: target.lease.leaderEpoch,
    leaseVersion: target.lease.leaseVersion,
  };
  await requireActiveWorkplaceLease(actor, target.extension, fence, {
    client,
    requireFence: true,
    verifyLease: () => repository.verify({
      organizationId: actor.organizationId,
      profileId: actor.profileId,
      extensionId: target.extension.id,
      leaseId: fence.leaseId,
      assignmentGeneration: fence.assignmentGeneration,
      browserInstanceId: fence.browserInstanceId,
      leaderEpoch: fence.leaderEpoch,
      leaseVersion: fence.leaseVersion,
      requireFence: true,
    }),
    loadLease: async () => [target.lease],
  });
  return {
    result: { state: "confirmed", noOp: true, message: `Pracovné miesto ${target.extension.extension} už používaš.` },
    lease: toWorkplaceLeaseClientRef(target.lease, {
      extension: target.extension.extension,
      seatId: target.extension.id,
    }),
  };
}

function requireHotdeskRuntimeCapability() {
  const capability = workplaceHotdeskCapability();
  if (!capability.runtimeEnabled) {
    throw new MutationError("Správa aktívnych pracovísk nie je bezpečne povolená.", 503, "hotdesk_disabled");
  }
  return capability;
}

function requireHotdeskClaimCapability(actor: MotoristActor) {
  const capability = requireHotdeskRuntimeCapability();
  if (!capability.enabled || !capability.claimsEnabled) {
    throw new MutationError("Nové obsadenie pracoviska je dočasne pozastavené.", 503, "hotdesk_claims_disabled");
  }
  if (!canProfileUseWorkplaceHotdesk(capability, actor.profileId)) {
    throw new MutationError("Tento účet nemá povolené dynamické pracovisko.", 403);
  }
  return capability;
}

async function loadExistingOperation(client: AdminClient, actor: MotoristActor, idempotencyKey: string) {
  const result = await client
    .from("motorist_workplace_operations")
    .select("*")
    .eq("organization_id", actor.organizationId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (result.error) throw new MutationError("Rozpracovanú zmenu sa nepodarilo overiť.", 500);
  if (result.data && result.data.actor_profile_id !== actor.profileId) {
    throw new MutationError("Identifikátor požiadavky už použil iný operátor.", 409);
  }
  return result.data ?? undefined;
}

async function loadOperation(client: AdminClient, actor: MotoristActor, operationId: string) {
  const result = await client
    .from("motorist_workplace_operations")
    .select("*")
    .eq("organization_id", actor.organizationId)
    .eq("id", operationId)
    .eq("actor_profile_id", actor.profileId)
    .maybeSingle();
  if (result.error) throw new MutationError("Rozpracovanú zmenu sa nepodarilo načítať.", 500);
  return result.data ?? undefined;
}

async function loadExtensionNumber(client: AdminClient, organizationId: string, extensionId: string) {
  const result = await client
    .from("motorist_telephony_extensions")
    .select("extension")
    .eq("organization_id", organizationId)
    .eq("id", extensionId)
    .eq("provider", PROVIDER)
    .maybeSingle();
  if (result.error || !result.data) throw new MutationError("Cieľové pracovné miesto sa nenašlo.", 409);
  return result.data.extension;
}

function assertExistingSelectionIntent(operation: OperationRow, input: DynamicSeatSelectionInput, target: string) {
  if (operation.browser_instance_id !== input.browserInstanceId || operation.kind === "leave") {
    throw new MutationError("Identifikátor požiadavky už patrí inej zmene pracoviska.", 409);
  }
  // Exact target ID is revalidated by continueOperation. The public extension
  // is bounded here so a forged replay cannot become an arbitrary selector.
  readConfiguredExtension(target);
}

function assertOperationStillMatches(operation: OperationRow, context: WorkplaceContext) {
  if (
    operation.source_extension_id !== (context.source?.extension.id ?? null) ||
    operation.target_extension_id !== (context.target?.extension.id ?? null) ||
    operation.source_lease_id !== (context.source?.lease?.id ?? null) ||
    operation.target_lease_id !== (context.target?.lease?.id ?? null)
  ) {
    if (operation.phase === "completed") return;
    throw new MutationError("Pracovisko sa počas zmeny odchýlilo od uzamknutého stavu.", 409);
  }
}

function completedOperationResult(
  operation: OperationRow,
  target: CompletedOperationTarget | undefined,
  dependencies: WorkplaceHandoffDependencies,
): DynamicWorkplaceResult {
  const result = record(operation.result_safe);
  if (!operation.target_extension_id) {
    return { result: { state: "confirmed", noOp: true, message: "Pracovné miesto je uvoľnené." } };
  }
  const leaseId = uuid(result.leaseId);
  const generation = uuid(result.assignmentGeneration);
  const leaderEpoch = positiveInteger(result.leaderEpoch);
  const leaseVersion = positiveInteger(result.leaseVersion);
  const expiresAt = timestamp(result.expiresAt);
  if (!target || !leaseId || !generation || !leaderEpoch || !leaseVersion || !expiresAt) {
    throw new MutationError("Uložený výsledok pracoviska je neplatný.", 409, "workplace_recovery_required");
  }
  if (!target.lease) {
    throw new MutationError(
      "Táto dokončená zmena bola neskôr nahradená aktuálnym vlastníkom pracoviska. Obnov aktuálny stav.",
      409,
      "workplace_operation_superseded",
    );
  }
  const derivedResumeSecret = deriveResumeSecret(dependencies, operation.id, leaseId, operation.browser_instance_id);
  const resumeSecret = target.lease.id === leaseId && target.lease.resumeSecretHash === sha256(derivedResumeSecret)
    ? derivedResumeSecret
    : undefined;
  return {
    result: { state: "confirmed", noOp: true, message: `Pracovné miesto ${target.extension.extension} je pripravené.` },
    lease: {
      leaseId,
      seatId: target.extension.id,
      extension: target.extension.extension,
      assignmentGeneration: generation,
      leaderEpoch,
      leaseVersion,
      expiresAt,
      heartbeatIntervalMs: 15_000,
    },
    ...(resumeSecret ? { resumeSecret } : {}),
  };
}

async function safeAbort(
  repository: WorkplaceOperationRepository,
  organizationId: string,
  operation: OperationRow,
  message: string,
) {
  try {
    await repository.abort({
      organizationId,
      operationId: operation.id,
      claimGeneration: operation.claim_generation,
      errorSafe: message.slice(0, 300),
    });
  } catch {
    throw new MutationError("Zmenu sa nepodarilo bezpečne zrušiť; pracovisko ostáva uzamknuté.", 409, "workplace_recovery_required");
  }
}

function providerProofHash(
  snapshot: Pick<ViptelProviderSnapshot, "activeCalls" | "capturedAt" | "extensions" | "queueStatuses">,
  context: WorkplaceContext,
) {
  return sha256(stableJson({
    capturedAt: snapshot.capturedAt,
    extensions: [context.source, context.target]
      .filter((value): value is WorkplaceSeat => Boolean(value))
      .map((seat) => snapshot.extensions.filter((extension) => extension.extension === seat.extension.extension)),
    activeCalls: snapshot.activeCalls,
    queueStatuses: snapshot.queueStatuses,
  }));
}

function deriveResumeSecret(
  dependencies: WorkplaceHandoffDependencies,
  operationId: string,
  leaseId: string,
  browserInstanceId: string,
) {
  const key = dependencies.resumeSecretKey ?? process.env.VIPTEL_WORKPLACE_RESUME_SECRET_KEY?.trim();
  if (!key || key.length < 32) {
    throw new MutationError("Server nemá pripravený kľúč na bezpečné obnovenie pracoviska.", 503);
  }
  return createHmac("sha256", key)
    .update("motorist.workplace.resume.v1\0")
    .update(operationId)
    .update("\0")
    .update(leaseId)
    .update("\0")
    .update(browserInstanceId)
    .digest("base64url");
}

function requireResumeSecretKey(dependencies: WorkplaceHandoffDependencies) {
  const key = dependencies.resumeSecretKey ?? process.env.VIPTEL_WORKPLACE_RESUME_SECRET_KEY?.trim();
  if (!key || key.length < 32) {
    throw new MutationError("Server nemá pripravený samostatný kľúč na obnovenie pracoviska.", 503, "hotdesk_resume_key_missing");
  }
}

function readConfiguredExtension(value: unknown) {
  const extension = typeof value === "string" ? value.trim() : "";
  if (!configuredPersonalExtensions().includes(extension)) {
    throw new MutationError(`Vyber pracovné miesto ${configuredPersonalExtensions().join(", ")}.`, 400);
  }
  return extension;
}

function queueFor(plan: DispatchPriorityPlan, extension: string): DispatchQueueNumber | null {
  return DISPATCH_QUEUE_NUMBERS.find((queue) => plan[queue] === extension) ?? null;
}

function assertExpectedSeatVersion(seat: WorkplaceSeat, expectedVersion?: string) {
  if (!expectedVersion) return;
  const actual = workplaceSeatOwnershipVersion({
    seatId: seat.extension.id,
    lifecycleEpoch: seat.lifecycle.epoch,
    lease: seat.lease,
  });
  if (actual !== expectedVersion) {
    throw new MutationError(
      "Stav pracovného miesta sa od posledného zobrazenia zmenil. Obnov ho a skús znova.",
      409,
      "workplace_conflict",
    );
  }
}

function samePlan(left: DispatchPriorityPlan, right: DispatchPriorityPlan) {
  return DISPATCH_QUEUE_NUMBERS.every((queue) => left[queue] === right[queue]);
}

function safeError(error: unknown) {
  return error instanceof MutationError ? error.message : "Bezpečnostné overenie pracoviska zlyhalo.";
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function uuid(value: unknown) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function timestamp(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}
