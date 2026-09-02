import "server-only";

import { createHash, randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  type ViptelActiveCall,
  type ViptelClient,
  type ViptelExtension,
  type ViptelQueueAgentAction,
  type ViptelQueueStatus,
} from "@/lib/integrations/viptel/client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import { isReadOnlyTelephonyCommand } from "@/server/telephony/command-interlock";
import {
  AssignmentInterlockRejected,
  captureRoutingAssignmentGuards,
  parseAssignmentGuard,
  releaseRoutingAssignmentGuards,
  revalidateExtensionAssignmentGuard,
  revalidateRoutingAssignmentGuards,
  type TelephonyAssignmentGuard,
} from "./assignment-interlock";
import { assertTelephonyLiveMutationEnabled, telephonyLiveMutationGateStatus } from "./live-mutation-gate";
import { authorizeViptelMutationCommand } from "./mutation-command-authority";
import { configuredPersonalExtensions } from "./personal-extension-config";
import { requestViptelProviderSnapshot } from "./provider-snapshot-bridge";
import {
  parseWorkplacePriorityDraft,
  requireLatestWorkplacePriorityDraftAuthority,
  verifyWorkplacePriorityDraftSignature,
  type WorkplaceDraftAuthorityContext,
} from "./workplace-draft-authority";
import { assertNoActiveWorkplaceOwnerTransition } from "./workplace-owner-transition";
import { readAssignmentLifecycle } from "./assignment-lifecycle";
import { DISPATCH_QUEUE_NUMBERS, type DispatchQueueNumber } from "./dispatch-queues";
import {
  dispatchCoverageDigest,
  onlineDispatchExtensions,
  packDispatchQueueCoverage,
} from "./dispatch-coverage";
import { workplaceHotdeskCapability } from "./workplace-capability";

type AdminClient = SupabaseClient<Database>;
type QueueRow = Database["public"]["Tables"]["motorist_telephony_queues"]["Row"];
type ExtensionRow = Database["public"]["Tables"]["motorist_telephony_extensions"]["Row"];
type CommandRow = Database["public"]["Tables"]["motorist_telephony_commands"]["Row"];
type CatalogQueueRow = Pick<QueueRow, "id" | "external_id" | "label" | "line_id" | "active" | "metadata" | "updated_at">;

// Declared in a leaf module so callers that need only the queue identities do
// not have to import this file, which sits deep enough in the import graph to
// form a cycle back through assignment-interlock and fallback-settings.
// Re-exported here so every existing import site keeps working unchanged.
export { DISPATCH_QUEUE_NUMBERS };
export type { DispatchQueueNumber };

const PROVIDER = "viptel";
const ROUTING_METADATA_KEY = "dispatchRouting";
const NON_TERMINAL_COMMAND_STATUSES = ["queued", "sent", "accepted"] as const;
const QUEUE_COMMAND_TYPES = ["queue.add", "queue.remove", "queue.pause", "queue.unpause"] as const;
const ROUTING_OPERATION_AUTHORIZED_ACTION = "telephony.routing.operation.authorized";
const ROUTING_PLAN_COMMITTED_ACTION = "telephony.routing.plan.committed";
const ROUTING_STEP_CONFIRMED_ACTION = "telephony.routing.step.confirmed";
const ROUTING_AUTHORITY_SCHEMA_VERSION = 1;
const QUEUE_LABELS: Record<DispatchQueueNumber, string> = {
  "601": "Dispečing – prvá priorita",
  "602": "Dispečing – druhá priorita",
  "603": "Dispečing – tretia priorita / slučka",
};

export type DispatchPriorityPlan = Record<DispatchQueueNumber, string | null>;

export type DispatchPrioritySlot = {
  queue: DispatchQueueNumber;
  extension: string | null;
};

export type DispatchRoutingFallback = {
  queue: DispatchQueueNumber;
  extension: string;
  queueId: string;
  extensionId: string;
};

export type DispatchRoutingStep = {
  stepIndex: number;
  commandId: string;
  idempotencyKey: string;
  commandType: `queue.${ViptelQueueAgentAction}`;
  action: ViptelQueueAgentAction;
  queue: DispatchQueueNumber;
  queueId: string;
  extension: string;
  extensionId: string;
  status: "pending" | "confirmed";
};

export type DispatchRoutingOperation = {
  operationId: string;
  status: "applying" | "degraded" | "rolling_back";
  baseRevision: number;
  targetRevision: number;
  previousPlan: DispatchPriorityPlan;
  targetPlan: DispatchPriorityPlan;
  steps: DispatchRoutingStep[];
  currentStep: number;
  fallback: DispatchRoutingFallback;
  affectedExtensions: string[];
  assignmentGuards: TelephonyAssignmentGuard[];
  rootMetadataGuard?: DispatchRoutingRootMetadataGuard;
  actorProfileId: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  initialBootstrap?: true;
  releasePending?: boolean;
};

export type DispatchRoutingState = {
  revision: number;
  currentPlan: DispatchPriorityPlan;
  operation?: DispatchRoutingOperation;
};

export type DispatchRoutingPlanInput = {
  baseRevision: number;
  slots: DispatchPrioritySlot[];
  fallback: { queue: unknown; extension: unknown };
  previewDigest?: unknown;
  dryRun?: boolean;
  rootMetadataGuard?: DispatchRoutingRootMetadataGuard;
};

export type DispatchRoutingRootMetadataGuard = {
  key: "workplacePriorityDraft";
  digest: string;
  authorityId: string;
};

export type EmptyDispatchRoutingBootstrapInput = Omit<DispatchRoutingPlanInput, "fallback">;

export type DispatchRoutingRootQueue = Pick<QueueRow, "id" | "external_id" | "line_id" | "metadata" | "updated_at">;
type RootQueue = DispatchRoutingRootQueue;
export type ProviderSnapshot = {
  extensions: ViptelExtension[];
  queueStatuses: ViptelQueueStatus[];
  activeCalls?: ViptelActiveCall[];
};

export type EmptyBootstrapProviderSnapshot = ProviderSnapshot & {
  activeCalls: ViptelActiveCall[];
};
type DispatchProviderClient = Pick<ViptelClient, "getQueueStatus" | "listExtensions"> &
  Partial<Pick<ViptelClient, "listActiveCalls">>;

type RecoveryCommand = Pick<CommandRow, "id" | "status" | "command_type" | "request_payload">;
type RoutingFailureCommand = Pick<
  CommandRow,
  | "command_type"
  | "extension_id"
  | "id"
  | "idempotency_key"
  | "organization_id"
  | "provider"
  | "queue_id"
  | "request_payload"
  | "requested_by"
>;

export async function getStoredDispatchRoutingOverview(actor: MotoristActor) {
  const client = createSupabaseAdminClient();
  const [queuesResult, extensionsResult, membershipsResult, snapshotsResult] = await Promise.all([
    client
      .from("motorist_telephony_queues")
      .select("id, external_id, label, line_id, active, metadata, updated_at")
      .eq("organization_id", actor.organizationId)
      .eq("provider", PROVIDER)
      .in("external_id", [...DISPATCH_QUEUE_NUMBERS])
      .order("external_id", { ascending: true }),
    client
      .from("motorist_telephony_extensions")
      .select("id, extension, profile_id, display_name, is_registered, active")
      .eq("organization_id", actor.organizationId)
      .eq("provider", PROVIDER)
      .eq("active", true)
      .in("extension", configuredPersonalExtensions()),
    client
      .from("motorist_queue_memberships")
      .select("queue_number, extension_number, paused, in_use, last_synced_at")
      .eq("organization_id", actor.organizationId)
      .eq("provider", PROVIDER)
      .in("queue_number", [...DISPATCH_QUEUE_NUMBERS]),
    client
      .from("motorist_queue_snapshots")
      .select("queue_number, waiting_calls, captured_at")
      .eq("organization_id", actor.organizationId)
      .eq("provider", PROVIDER)
      .in("queue_number", [...DISPATCH_QUEUE_NUMBERS])
      .order("captured_at", { ascending: false })
      .limit(100),
  ]);
  throwQueryError(queuesResult.error, "Katalóg dispečerských radov sa nepodarilo načítať.");
  throwQueryError(extensionsResult.error, "Osobné klapky sa nepodarilo načítať.");
  throwQueryError(membershipsResult.error, "Členstvá dispečerských radov sa nepodarilo načítať.");
  throwQueryError(snapshotsResult.error, "Stav čakania v radoch sa nepodarilo načítať.");

  const queueRows = queuesResult.data ?? [];
  const root = queueRows.find((queue) => queue.external_id === "601");
  const state = root ? parseDispatchRoutingState(root.metadata) : emptyRoutingState();
  const profileIds = (extensionsResult.data ?? [])
    .map((extension) => extension.profile_id)
    .filter((value): value is string => Boolean(value));
  const profiles = profileIds.length > 0
    ? await client
        .from("motorist_profiles")
        .select("id, display_name")
        .eq("organization_id", actor.organizationId)
        .eq("active", true)
        .in("id", profileIds)
    : { data: [], error: null };
  throwQueryError(profiles.error, "Mená operátorov sa nepodarilo načítať.");
  const profileNames = new Map((profiles.data ?? []).map((profile) => [profile.id, profile.display_name]));
  const latestWaiting = new Map<string, { count: number; capturedAt: string }>();
  for (const snapshot of snapshotsResult.data ?? []) {
    if (!latestWaiting.has(snapshot.queue_number)) {
      latestWaiting.set(snapshot.queue_number, { count: snapshot.waiting_calls, capturedAt: snapshot.captured_at });
    }
  }

  return {
    gate: telephonyLiveMutationGateStatus(),
    catalog: planDispatchQueueCatalog(queueRows),
    revision: state.revision,
    currentPlan: slotsFromPlan(state.currentPlan),
    operation: operationSummary(state.operation),
    candidates: (extensionsResult.data ?? [])
      .filter((extension) => extension.profile_id && profileNames.has(extension.profile_id))
      .map((extension) => ({
        extensionId: extension.id,
        extension: extension.extension,
        profileId: extension.profile_id as string,
        profileName: profileNames.get(extension.profile_id as string) as string,
        registered: extension.is_registered ?? undefined,
      }))
      .sort((left, right) => left.extension.localeCompare(right.extension, "en", { numeric: true })),
    actualMemberships: (membershipsResult.data ?? []).map((membership) => ({
      queue: membership.queue_number,
      extension: membership.extension_number,
      paused: membership.paused,
      inUse: membership.in_use,
      lastSyncedAt: membership.last_synced_at ?? undefined,
    })),
    waitingCalls: DISPATCH_QUEUE_NUMBERS.map((queue) => ({
      queue,
      count: latestWaiting.get(queue)?.count ?? 0,
      capturedAt: latestWaiting.get(queue)?.capturedAt,
    })),
  };
}

export async function bootstrapDispatchQueueCatalog(actor: MotoristActor, dryRun = true) {
  const client = createSupabaseAdminClient();
  const existing = await loadDispatchQueueRows(client, actor.organizationId);
  const plan = planDispatchQueueCatalog(existing);
  if (dryRun) return plan;

  assertTelephonyLiveMutationEnabled("dispatch.routing.bootstrap");
  const existingRoot = existing.find((row) => row.external_id === "601");
  if (existingRoot) assertNoActiveWorkplaceOwnerTransition(existingRoot.metadata);
  for (const item of plan.queues) {
    if (item.action === "noop") continue;
    const result = await client.from("motorist_telephony_queues").upsert({
      organization_id: actor.organizationId,
      provider: PROVIDER,
      external_id: item.queue,
      label: QUEUE_LABELS[item.queue],
      line_id: null,
      active: true,
    }, { onConflict: "organization_id,provider,external_id" });
    throwQueryError(result.error, `Rad ${item.queue} sa nepodarilo bezpečne zapísať.`);
  }
  await writeAudit(client, actor, "telephony.routing.catalog.bootstrap", null, { queues: plan.queues });
  return planDispatchQueueCatalog(await loadDispatchQueueRows(client, actor.organizationId));
}

export async function previewOrStartDispatchRoutingPlan(actor: MotoristActor, input: DispatchRoutingPlanInput) {
  return previewOrStartDispatchRoutingPlanInternal(actor, input, false, true);
}

/**
 * Self-service availability may temporarily leave one priority empty. It uses
 * the same signed, provider-confirmed operation as the complete manager plan;
 * only input completeness differs. The unchanged fallback still protects the
 * controlled window and direct queue writes remain forbidden.
 */
export async function previewOrStartPartialDispatchRoutingPlan(actor: MotoristActor, input: DispatchRoutingPlanInput) {
  return previewOrStartDispatchRoutingPlanInternal(actor, input, false, false);
}

export async function previewOrStartEmptyDispatchRoutingPlan(
  actor: MotoristActor,
  input: EmptyDispatchRoutingBootstrapInput,
) {
  const targetPlan = planFromDispatchPrioritySlots(input.slots, false);
  const fallback = initialBootstrapFallback(targetPlan);
  return previewOrStartDispatchRoutingPlanInternal(actor, {
    ...input,
    fallback,
  }, true, false);
}

async function previewOrStartDispatchRoutingPlanInternal(
  actor: MotoristActor,
  input: DispatchRoutingPlanInput,
  initialBootstrap: boolean,
  requireCompletePlan: boolean,
) {
  const client = createSupabaseAdminClient();
  const queueRows = await requireDispatchQueueCatalog(client, actor.organizationId);
  const root = queueRows.get("601") as RootQueue;
  assertNoActiveWorkplaceOwnerTransition(root.metadata);
  const rootAuthorityContext = { organizationId: actor.organizationId, rootQueueId: root.id };
  const rootMetadataGuard = requireDispatchRoutingRootMetadataGuard(
    root.metadata,
    input.rootMetadataGuard,
    rootAuthorityContext,
  );
  if (rootMetadataGuard) {
    await requireLatestWorkplacePriorityDraftAuthority(
      client,
      jsonRecord(root.metadata).workplacePriorityDraft,
      rootAuthorityContext,
      rootMetadataGuard.authorityId,
    );
  }
  const state = parseDispatchRoutingState(root.metadata);
  const targetPlan = planFromDispatchPrioritySlots(input.slots, requireCompletePlan);
  assertDispatchPlanCanStart(state, input.baseRevision);
  if (initialBootstrap) {
    assertEmptyDispatchBootstrapState(state);
    await assertNoHistoricalRoutingAuthority(client, actor.organizationId);
  }
  else await requireCommittedRoutingPlan(client, actor.organizationId, root, state);

  const previousExtensions = Object.values(state.currentPlan).filter((value): value is string => Boolean(value));
  const extensions = await requirePlanExtensions(
    client,
    actor.organizationId,
    targetPlan,
    input.fallback.extension,
    true,
    previousExtensions,
  );
  const bridgedSnapshot = await requestViptelProviderSnapshot(actor.organizationId, actor.profileId, { maxAgeMs: 2_000 });
  const bootstrapSnapshot = initialBootstrap ? bridgedSnapshot : undefined;
  const snapshot = bridgedSnapshot;
  const fallback = resolveFallback(input.fallback, queueRows, extensions);
  const previousPlan = state.currentPlan;
  const steps = initialBootstrap
    ? buildEmptyBootstrapSteps(queueRows, extensions, targetPlan)
    : buildRoutingSteps(queueRows, extensions, snapshot.queueStatuses, previousPlan, targetPlan);
  if (initialBootstrap) {
    await assertNoPendingTelephonyCommands(client, actor.organizationId);
    validateEmptyDispatchBootstrapStart(bootstrapSnapshot as EmptyBootstrapProviderSnapshot, targetPlan, fallback);
  } else {
    validateDispatchControlledWindow(snapshot, steps, fallback, extensions.keys(), {
      allowRegisteredAffected: Boolean(rootMetadataGuard),
      allowTargetAnchor: Boolean(rootMetadataGuard),
    });
  }
  const preview = {
    baseRevision: state.revision,
    targetRevision: state.revision + 1,
    previousPlan: slotsFromPlan(previousPlan),
    targetPlan: slotsFromPlan(targetPlan),
    steps: steps.map(publicStep),
    fallback: { queue: fallback.queue, extension: fallback.extension },
    ...(rootMetadataGuard ? { rootMetadataGuard } : {}),
    ...(initialBootstrap ? { initialBootstrap: true as const } : {}),
  };
  const previewDigest = dispatchRoutingPreviewDigest(preview);
  if (input.dryRun !== false) return { dryRun: true as const, preview, previewDigest };

  if (readString(input.previewDigest) !== previewDigest) {
    throw new MutationError("Živý routing diff sa od posledného dry-run zmenil. Obnov dry-run a skontroluj kroky znova.", 409);
  }

  assertTelephonyLiveMutationEnabled(initialBootstrap ? "dispatch.routing.bootstrap_empty" : "dispatch.routing.apply");
  if (initialBootstrap) await assertNoPendingTelephonyCommands(client, actor.organizationId);
  else await assertNoBlockingQueueCommands(client, actor.organizationId);
  const operationId = randomUUID();
  const assignmentGuards = await captureRoutingAssignmentGuards(
    client,
    actor.organizationId,
    routingGuardExtensionIds(extensions, previousPlan, targetPlan, fallback.extension),
    initialBootstrap ? "dispatch.routing.bootstrap_empty" : "dispatch.routing.apply",
    operationId,
  );
  try {
    assertRoutingAssignmentGuardsMatchRows(assignmentGuards, extensions);
  } catch (error) {
    await releaseUnpersistedRoutingGuards(client, actor.organizationId, assignmentGuards, error);
    throw error;
  }
  const now = new Date().toISOString();
  if (steps.length === 0) {
    const releasePending: DispatchRoutingOperation = {
      operationId,
      status: "degraded",
      baseRevision: state.revision,
      targetRevision: state.revision + 1,
      previousPlan,
      targetPlan,
      steps: [],
      currentStep: 0,
      fallback,
      affectedExtensions: [],
      assignmentGuards,
      rootMetadataGuard,
      actorProfileId: actor.profileId,
      createdAt: now,
      updatedAt: now,
      lastError: "Plán nevyžaduje provider krok; dokončuje sa uvoľnenie assignment interlocku.",
      initialBootstrap: initialBootstrap || undefined,
      releasePending: true,
    };
    let releaseRoot: RootQueue;
    try {
      await revalidateRoutingAssignmentGuards(client, actor.organizationId, assignmentGuards);
      releaseRoot = await compareAndSetDispatchRoutingState(client, root, {
        revision: state.revision + 1,
        currentPlan: targetPlan,
        operation: releasePending,
      });
    } catch (error) {
      await releaseUnpersistedRoutingGuards(client, actor.organizationId, assignmentGuards, error);
      throw error;
    }
    try {
      await authorizeRoutingOperation(client, actor.organizationId, releasePending);
      await requireRoutingOperationProgress(client, actor.organizationId, releasePending, true);
      await releaseRoutingAssignmentGuards(client, actor.organizationId, assignmentGuards);
    } catch (error) {
      await writeOperationAudit(
        client,
        actor.organizationId,
        actor.profileId,
        "telephony.routing.operation.release_failed",
        releaseRoot.id,
        { error: safeError(error), operationId: releasePending.operationId },
      ).catch(() => undefined);
      throw error;
    }
    const updated = await compareAndSetDispatchRoutingState(client, releaseRoot, {
      revision: state.revision + 1,
      currentPlan: targetPlan,
    });
    await writeCommittedRoutingPlan(
      client,
      actor.organizationId,
      actor.profileId,
      updated,
      { revision: state.revision + 1, currentPlan: targetPlan },
      operationId,
    );
    await writeAudit(client, actor, "telephony.routing.plan.noop", updated.id, preview);
    return { dryRun: false as const, preview, previewDigest, routing: await getStoredDispatchRoutingOverview(actor) };
  }

  const operation: DispatchRoutingOperation = {
    operationId,
    status: "applying",
    baseRevision: state.revision,
    targetRevision: state.revision + 1,
    previousPlan,
    targetPlan,
    steps,
    currentStep: 0,
    fallback,
    affectedExtensions: [...new Set(steps.map((step) => step.extension))],
    assignmentGuards,
    rootMetadataGuard,
    actorProfileId: actor.profileId,
    createdAt: now,
    updatedAt: now,
    initialBootstrap: initialBootstrap || undefined,
  };
  let updatedRoot: RootQueue;
  try {
    await revalidateRoutingAssignmentGuards(client, actor.organizationId, assignmentGuards);
    updatedRoot = await compareAndSetDispatchRoutingState(client, root, { ...state, operation });
  } catch (error) {
    await releaseUnpersistedRoutingGuards(client, actor.organizationId, assignmentGuards, error);
    throw error;
  }
  try {
    if (initialBootstrap) await assertNoPendingTelephonyCommands(client, actor.organizationId);
    else await assertNoBlockingQueueCommands(client, actor.organizationId);
    await authorizeRoutingOperation(client, actor.organizationId, operation);
    await enqueueCurrentOperationStep(client, actor.organizationId, operation);
  } catch (error) {
    updatedRoot = await degradeOperation(client, updatedRoot, operation.operationId, safeError(error));
    throw new MutationError(`Zmena priorít bola zastavená pred prvým krokom: ${safeError(error)}`, 409);
  }
  await writeAudit(
    client,
    actor,
    initialBootstrap ? "telephony.routing.plan.bootstrap_empty" : "telephony.routing.plan.apply",
    updatedRoot.id,
    { operationId: operation.operationId, ...preview },
  );
  return { dryRun: false as const, preview, previewDigest, routing: await getStoredDispatchRoutingOverview(actor) };
}

export function dispatchRoutingPreviewDigest(preview: {
  baseRevision: number;
  targetRevision: number;
  previousPlan: DispatchPrioritySlot[];
  targetPlan: DispatchPrioritySlot[];
  steps: Array<{ stepIndex: number; action: ViptelQueueAgentAction; queue: DispatchQueueNumber; extension: string }>;
  fallback: { queue: DispatchQueueNumber; extension: string };
  rootMetadataGuard?: DispatchRoutingRootMetadataGuard;
  initialBootstrap?: true;
}) {
  return createHash("sha256").update(JSON.stringify(preview)).digest("hex");
}

export function dispatchRoutingRootMetadataDigest(
  key: DispatchRoutingRootMetadataGuard["key"],
  value: unknown,
) {
  if (value === undefined) {
    throw new MutationError(`Chránené metadata ${key} chýbajú.`, 409);
  }
  return createHash("sha256")
    .update("motorist.telephony.routing-root-metadata.v1")
    .update("\0")
    .update(key)
    .update("\0")
    .update(canonicalJson(value))
    .digest("hex");
}

export function requireDispatchRoutingRootMetadataGuard(
  metadata: unknown,
  guard?: DispatchRoutingRootMetadataGuard,
  authorityContext?: WorkplaceDraftAuthorityContext,
) {
  if (!guard) return undefined;
  const parsed = parseDispatchRoutingRootMetadataGuard(guard, 400);
  if (!parsed) throw new MutationError("Ochrana rozpracovaného výberu priorít chýba.", 400);
  const guardedValue = jsonRecord(metadata)[parsed.key];
  const actual = dispatchRoutingRootMetadataDigest(parsed.key, guardedValue);
  if (actual !== parsed.digest) {
    throw new MutationError("Rozpracovaný výber priorít medzitým zmenil iný operátor. Obnov stav a skús to znova.", 409);
  }
  if (!authorityContext) {
    throw new MutationError("Ochrane výberu priorít chýba serverový kontext.", 409);
  }
  const authority = verifyWorkplacePriorityDraftSignature(guardedValue, authorityContext);
  if (authority.auditId !== parsed.authorityId) {
    throw new MutationError("Ochrana výberu priorít nezodpovedá serverovému dôkazu.", 409);
  }
  return parsed;
}

/**
 * Reads only a draft belonging to the current committed revision. Older valid
 * drafts are superseded by the committed routing head; malformed or future
 * drafts remain fail-closed because they cannot be safely classified.
 */
export function readApplicableWorkplacePriorityDraft(
  metadata: unknown,
  routingRevision: number,
  authorityContext?: WorkplaceDraftAuthorityContext,
): DispatchPriorityPlan | undefined {
  const raw = jsonRecord(metadata).workplacePriorityDraft;
  if (raw === undefined) return undefined;
  const draft = parseWorkplacePriorityDraft(raw);
  const baseRevision = draft.baseRevision;
  if (baseRevision > routingRevision) {
    throw new MutationError("Rozpracovaný výber priorít odkazuje na budúcu revíziu.", 409);
  }
  if (baseRevision < routingRevision) return undefined;
  if (!authorityContext) {
    throw new MutationError("Aktuálnemu výberu priorít chýba serverový kontext.", 409);
  }
  verifyWorkplacePriorityDraftSignature(draft, authorityContext);
  return { ...draft.selections };
}

function parseDispatchRoutingRootMetadataGuard(value: unknown, status = 409) {
  if (value === undefined) return undefined;
  const record = jsonRecord(value);
  if (
    Object.keys(record).length !== 3 ||
    record.key !== "workplacePriorityDraft" ||
    typeof record.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.digest) ||
    typeof record.authorityId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.authorityId)
  ) {
    throw new MutationError("Ochrana rozpracovaného výberu priorít má neplatný formát.", status);
  }
  return {
    key: "workplacePriorityDraft",
    digest: record.digest,
    authorityId: record.authorityId,
  } satisfies DispatchRoutingRootMetadataGuard;
}

export function dispatchRoutingOperationAuthorityDigest(
  organizationId: string,
  operation: DispatchRoutingOperation,
) {
  return createHash("sha256").update(JSON.stringify(routingOperationIntent(organizationId, operation))).digest("hex");
}

export function dispatchRoutingCommittedPlanDigest(
  organizationId: string,
  rootId: string,
  state: Pick<DispatchRoutingState, "currentPlan" | "revision">,
) {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: ROUTING_AUTHORITY_SCHEMA_VERSION,
    organizationId,
    rootId,
    revision: state.revision,
    currentPlan: canonicalPlan(state.currentPlan),
  })).digest("hex");
}

export async function recoverDispatchRoutingOperation(
  actor: MotoristActor,
  action: "resume" | "rollback" | "reconcile",
  expectedOperationId?: string,
) {
  assertTelephonyLiveMutationEnabled(`dispatch.routing.${action}`);
  const client = createSupabaseAdminClient();
  const queueRows = await requireDispatchQueueCatalog(client, actor.organizationId);
  const root = queueRows.get("601") as RootQueue;
  assertNoActiveWorkplaceOwnerTransition(root.metadata);
  const state = parseDispatchRoutingState(root.metadata);
  const operation = state.operation;
  if (!operation) throw new MutationError("Nie je rozpracovaná žiadna zmena priorít.", 409);
  if (expectedOperationId && operation.operationId !== expectedOperationId) {
    throw new MutationError(
      "Rozpracovaná zmena priorít sa medzitým zmenila. Obnov pracovisko.",
      409,
      "routing_recovery_operation_changed",
    );
  }
  const rootAuthorityContext = { organizationId: actor.organizationId, rootQueueId: root.id };
  requireDispatchRoutingRootMetadataGuard(root.metadata, operation.rootMetadataGuard, rootAuthorityContext);
  if (operation.rootMetadataGuard) {
    await requireLatestWorkplacePriorityDraftAuthority(
      client,
      jsonRecord(root.metadata).workplacePriorityDraft,
      rootAuthorityContext,
      operation.rootMetadataGuard.authorityId,
    );
  }
  await requireAuthorizedRoutingOperation(client, actor.organizationId, operation);
  await requireRoutingOperationProgress(client, actor.organizationId, operation, true);
  if (operation.releasePending) {
    if (action === "rollback") {
      throw new MutationError("Provider kroky sú už ukončené; možno iba dokončiť uvoľnenie interlocku.", 409);
    }
    assertRoutingAssignmentGuardCoverage(operation);
    await releaseRoutingAssignmentGuards(client, actor.organizationId, operation.assignmentGuards);
    const completedRoot = await compareAndSetDispatchRoutingState(client, root, {
      revision: state.revision,
      currentPlan: state.currentPlan,
    });
    await writeCommittedRoutingPlan(
      client,
      actor.organizationId,
      actor.profileId,
      completedRoot,
      state,
      operation.operationId,
    );
    await writeAudit(client, actor, "telephony.routing.operation.release.complete", completedRoot.id, {
      operationId: operation.operationId,
    });
    return getStoredDispatchRoutingOverview(actor);
  }
  await assertCurrentOperationStepRecoverable(client, actor.organizationId, operation);
  if (operation.initialBootstrap) await assertNoPendingTelephonyCommands(client, actor.organizationId);
  else await assertNoBlockingQueueCommands(client, actor.organizationId);

  if (action === "reconcile") {
    const reconciled = await reconcileUncertainCurrentStep(client, actor.organizationId, operation);
    if (!reconciled) {
      throw new MutationError("Aktuálny krok nemá neisté doručenie, ktoré by bolo treba zosúladiť.", 409);
    }
    await writeAudit(client, actor, "telephony.routing.operation.reconcile", root.id, {
      operationId: operation.operationId,
      stepIndex: operation.currentStep,
    });
    return getStoredDispatchRoutingOverview(actor);
  }

  await assertNoUnresolvedDelivery(client, actor.organizationId, operation.operationId);
  const bridgedSnapshot = await requestViptelProviderSnapshot(actor.organizationId, actor.profileId, { maxAgeMs: 2_000 });
  const bootstrapSnapshot = operation.initialBootstrap ? bridgedSnapshot : undefined;
  const snapshot = bridgedSnapshot;
  const recoveryTarget = action === "resume" ? operation.targetPlan : operation.previousPlan;
  const extraExtensions = [
    ...Object.values(operation.previousPlan),
    ...Object.values(operation.targetPlan),
    ...(operation.initialBootstrap ? operation.steps.map((step) => step.extension) : []),
    ...(operation.initialBootstrap ? operation.assignmentGuards.map((guard) => guard.extension) : []),
  ]
    .filter((value): value is string => Boolean(value));
  const extensionRows = await requirePlanExtensions(
    client,
    actor.organizationId,
    recoveryTarget,
    operation.fallback.extension,
    false,
    extraExtensions,
  );
  if (operation.initialBootstrap) {
    validateEmptyDispatchBootstrapRecoverySnapshot(
      bootstrapSnapshot as EmptyBootstrapProviderSnapshot,
      operation,
    );
  }
  const rollingBack = dispatchRecoveryIsRollingBack(operation, action);
  const steps = operation.initialBootstrap && !rollingBack
    ? buildEmptyBootstrapResumeSteps(queueRows, extensionRows, snapshot.queueStatuses, recoveryTarget)
    : buildRoutingSteps(
        queueRows,
        extensionRows,
        snapshot.queueStatuses,
        operation.previousPlan,
        recoveryTarget,
        extraExtensions,
      );
  const fallback = resolveFallback(operation.fallback, queueRows, extensionRows);
  if (!operation.initialBootstrap) {
    const providerAlreadyMatchesCommittedRollback =
      rollingBack &&
      steps.length === 0 &&
      DISPATCH_QUEUE_NUMBERS.every((queue) => recoveryTarget[queue] === operation.previousPlan[queue]);
    if (providerAlreadyMatchesCommittedRollback) {
      // The provider has already returned exactly to the last committed plan.
      // There is no provider mutation left to protect with the operation's
      // fallback, which may be the now-offline target that caused the failure.
      // Keep the canonical snapshot checks before completing only the durable
      // metadata/assignment-guard cleanup below.
      assertCanonicalDispatchProviderSnapshot(snapshot, extensionRows.keys());
    } else {
      validateDispatchControlledWindow(snapshot, steps, fallback, extensionRows.keys(), {
        allowRegisteredAffected: Boolean(operation.rootMetadataGuard),
        allowTargetAnchor: Boolean(operation.rootMetadataGuard),
      });
    }
  }
  const guardResolution = await recoverOrCaptureRoutingAssignmentGuards(
    client,
    actor.organizationId,
    operation,
    extensionRows,
    recoveryTarget,
    fallback.extension,
  );
  const assignmentGuards = guardResolution.guards;
  const now = new Date().toISOString();
  const nextOperation: DispatchRoutingOperation = {
    ...operation,
    status: rollingBack ? "rolling_back" : "applying",
    targetPlan: recoveryTarget,
    targetRevision: Math.max(operation.targetRevision, state.revision + 1),
    steps,
    currentStep: 0,
    fallback,
    affectedExtensions: [...new Set(steps.map((step) => step.extension))],
    assignmentGuards,
    actorProfileId: actor.profileId,
    updatedAt: now,
    lastError: undefined,
  };
  if (operation.initialBootstrap && steps.length > 0) {
    validateEmptyDispatchBootstrapOperation(
      bootstrapSnapshot as EmptyBootstrapProviderSnapshot,
      nextOperation,
    );
  }
  let recoveryPersisted = false;
  try {
    await revalidateRoutingAssignmentGuards(client, actor.organizationId, assignmentGuards);
    if (steps.length === 0) {
      const releasePending: DispatchRoutingOperation = {
        ...operation,
        status: "degraded",
        targetPlan: recoveryTarget,
        targetRevision: nextOperation.targetRevision,
        steps: [],
        currentStep: 0,
        assignmentGuards,
        lastError: "Provider stav je zosúladený; dokončuje sa uvoľnenie assignment interlocku.",
        releasePending: true,
        updatedAt: new Date().toISOString(),
      };
      const releaseRoot = await compareAndSetDispatchRoutingState(client, root, {
        revision: nextOperation.targetRevision,
        currentPlan: recoveryTarget,
        operation: releasePending,
      });
      recoveryPersisted = true;
      await authorizeRoutingOperation(client, actor.organizationId, releasePending);
      await requireRoutingOperationProgress(client, actor.organizationId, releasePending, true);
      await releaseRoutingAssignmentGuards(client, actor.organizationId, assignmentGuards);
      const completedRoot = await compareAndSetDispatchRoutingState(client, releaseRoot, {
        revision: nextOperation.targetRevision,
        currentPlan: recoveryTarget,
      });
      await writeCommittedRoutingPlan(
        client,
        actor.organizationId,
        actor.profileId,
        completedRoot,
        { revision: nextOperation.targetRevision, currentPlan: recoveryTarget },
        operation.operationId,
      );
    } else {
      const updatedRoot = await compareAndSetDispatchRoutingState(client, root, { ...state, operation: nextOperation });
      recoveryPersisted = true;
      try {
        await authorizeRoutingOperation(client, actor.organizationId, nextOperation);
        await enqueueCurrentOperationStep(client, actor.organizationId, nextOperation);
      } catch (error) {
        await degradeOperation(client, updatedRoot, nextOperation.operationId, safeError(error));
        throw new MutationError(`Obnova priorít bola zastavená pred prvým krokom: ${safeError(error)}`, 409);
      }
    }
  } catch (error) {
    if (guardResolution.captured && !recoveryPersisted) {
      await releaseUnpersistedRoutingGuards(client, actor.organizationId, assignmentGuards, error);
    }
    throw error;
  }
  await writeAudit(client, actor, `telephony.routing.operation.${action}`, root.id, {
    operationId: operation.operationId,
    stepCount: steps.length,
  });
  return getStoredDispatchRoutingOverview(actor);
}

export function dispatchRecoveryIsRollingBack(
  operation: DispatchRoutingOperation,
  action: "resume" | "rollback" | "reconcile",
) {
  if (action === "rollback" || operation.status === "rolling_back") return true;
  return Boolean(
    operation.initialBootstrap &&
    DISPATCH_QUEUE_NUMBERS.every((queue) => operation.targetPlan[queue] === null) &&
    operation.steps.every((step) => step.action === "remove"),
  );
}

export async function resolvePlannedDispatchQueue(
  organizationId: string,
  extension: string,
) {
  const client = createSupabaseAdminClient();
  const queues = await requireDispatchQueueCatalog(client, organizationId);
  const root = queues.get("601") as RootQueue;
  const state = parseDispatchRoutingState(root.metadata);
  if (state.operation) {
    throw new MutationError("Dostupnosť operátorov je počas zmeny priorít dočasne uzamknutá.", 409);
  }
  const planDigest = await requireCommittedRoutingPlan(client, organizationId, root, state);
  const queue = DISPATCH_QUEUE_NUMBERS.find((number) => state.currentPlan[number] === extension);
  if (!queue) {
    throw new MutationError("Osobná klapka nie je zaradená v aktuálnom pláne 601–603.", 403);
  }
  return { queue, queueId: (queues.get(queue) as QueueRow).id, revision: state.revision, planDigest };
}

/**
 * Assignment changes may run before the one-time routing bootstrap, but once
 * routing has ever been authorized they must only trust the latest immutable
 * committed plan. This prevents a member-writable root-row wipe/restore from
 * authorizing ownership changes behind the queue plan.
 */
export async function requireAssignmentSafeDispatchRoutingState(
  client: AdminClient,
  organizationId: string,
  root: RootQueue,
  state: DispatchRoutingState,
) {
  const latest = await client
    .from("motorist_audit_log")
    .select("id, action, created_at")
    .eq("organization_id", organizationId)
    .eq("entity_type", "motorist_telephony_queues")
    .in("action", [ROUTING_OPERATION_AUTHORIZED_ACTION, ROUTING_PLAN_COMMITTED_ACTION])
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(2);
  if (latest.error) throw new MutationError("Nemenný stav routing plánu sa nepodarilo overiť.", 500);
  const latestRows = latest.data ?? [];
  if (latestRows.length > 1 && latestRows[0]?.created_at === latestRows[1]?.created_at) {
    throw new MutationError("Nemenný routing head má nejednoznačné poradie.", 409);
  }
  const latestRow = latestRows[0];
  if (!latestRow) {
    assertEmptyDispatchBootstrapState(state);
    return;
  }
  if (latestRow.action !== ROUTING_PLAN_COMMITTED_ACTION || state.operation) {
    throw new MutationError("Routing operácia nie je nemenne dokončená; zmena vlastníka klapky je zablokovaná.", 409);
  }
  await requireCommittedRoutingPlan(client, organizationId, root, state);
}

export function dispatchAvailabilityPayload(input: {
  queue: DispatchQueueNumber;
  extension: string;
  revision: number;
  intent: "available" | "pause" | "offline";
  planDigest: string;
}) {
  return {
    routingAvailability: {
      kind: "availability",
      queue: input.queue,
      extension: input.extension,
      revision: input.revision,
      intent: input.intent,
      planDigest: input.planDigest,
    },
  };
}

export async function assertNoPendingDispatchAvailabilityCommand(
  organizationId: string,
  queue: DispatchQueueNumber,
  extension: string,
) {
  const client = createSupabaseAdminClient();
  const result = await client
    .from("motorist_telephony_commands")
    .select("id, request_payload")
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .in("command_type", [...QUEUE_COMMAND_TYPES])
    .in("status", [...NON_TERMINAL_COMMAND_STATUSES])
    .order("created_at", { ascending: true })
    .limit(100);
  throwQueryError(result.error, "Čakajúce príkazy dostupnosti sa nepodarilo overiť.");
  const conflict = (result.data ?? []).some((command) => {
    const payload = jsonRecord(command.request_payload);
    // A coverage add is derived from the very intent the operator is
    // expressing: both are trying to make this extension ring. The reconciler
    // packs a newly online operator into the remaining queues within seconds
    // of them joining the first one, so letting those commands block the
    // operator's own "Dostupný" made every seat takeover report a failure it
    // had not actually suffered.
    //
    // A coverage *remove* is the genuinely conflicting direction -- it is
    // taking the extension out of a queue while the operator asks to be in one
    // -- and still blocks, as does every manager routing command.
    if (jsonRecord(payload.routingCoverage).kind === "coverage" && readString(payload.action) === "add") {
      return false;
    }
    return readString(payload.queue) === queue || readString(payload.extension) === extension;
  });
  if (conflict) throw new MutationError("Predchádzajúca zmena dostupnosti ešte nie je potvrdená.", 409);
}

/** Reloaded by the listener after claiming and immediately before queue REST. */
export async function revalidateDispatchQueueCommand(
  client: AdminClient,
  organizationId: string,
  command: CommandRow,
  viptel: DispatchProviderClient,
) {
  const payload = jsonRecord(command.request_payload);
  const queue = readDispatchQueue(payload.queue);
  if (!queue) {
    throw new DispatchRoutingCommandRejected("Queue príkaz mimo riadených radov 601–603 bol odmietnutý.");
  }
  const operationTag = jsonRecord(payload.routingOperation);
  const availabilityTag = jsonRecord(payload.routingAvailability);
  const coverageTag = jsonRecord(payload.routingCoverage);
  const root = await requireRootQueue(client, organizationId);
  const state = parseDispatchRoutingState(root.metadata);

  if (Object.keys(operationTag).length > 0) {
    const operation = state.operation;
    const operationId = readString(operationTag.operationId);
    const stepIndex = readInteger(operationTag.stepIndex);
    const step = operation?.steps[operation.currentStep];
    if (
      !operation ||
      operation.status === "degraded" ||
      operation.operationId !== operationId ||
      operation.currentStep !== stepIndex ||
      operation.targetRevision !== readInteger(operationTag.revision) ||
      Boolean(operation.initialBootstrap) !== (operationTag.initialBootstrap === true) ||
      !step ||
      step.commandId !== command.id ||
      step.queue !== queue ||
      step.extension !== readString(payload.extension) ||
      step.commandType !== command.command_type
    ) {
      throw new DispatchRoutingCommandRejected("Stale alebo neplatný krok zmeny priorít bol odmietnutý.");
    }
    const authorityDigest = await requireAuthorizedRoutingOperation(client, organizationId, operation);
    if (readString(operationTag.authorityDigest) !== authorityDigest) {
      throw new DispatchRoutingCommandRejected("Krok zmeny priorít nemá nemennú autorizáciu aktuálnej operácie.");
    }
    await requireRoutingOperationProgress(client, organizationId, operation, false);
    if (operation.initialBootstrap) await assertNoPendingTelephonyCommands(client, organizationId, command.id);
    else await assertNoBlockingQueueCommands(client, organizationId, command.id);
    try {
      const rootAuthorityContext = { organizationId, rootQueueId: root.id };
      requireDispatchRoutingRootMetadataGuard(root.metadata, operation.rootMetadataGuard, rootAuthorityContext);
      if (operation.rootMetadataGuard) {
        await requireLatestWorkplacePriorityDraftAuthority(
          client,
          jsonRecord(root.metadata).workplacePriorityDraft,
          rootAuthorityContext,
          operation.rootMetadataGuard.authorityId,
        );
      }
      assertRoutingAssignmentGuardCoverage(operation);
      await revalidateRoutingAssignmentGuards(client, organizationId, operation.assignmentGuards);
      const snapshot = operation.initialBootstrap
        ? await loadEmptyBootstrapProviderSnapshot(viptel)
        : await loadProviderSnapshot(viptel);
      validateDispatchStepObservedState(snapshot.queueStatuses, step);
      if (operation.initialBootstrap) {
        validateEmptyDispatchBootstrapOperation(snapshot as EmptyBootstrapProviderSnapshot, operation);
      } else {
        validateDispatchControlledWindow(
          snapshot,
          operation.steps.slice(operation.currentStep),
          operation.fallback,
          operation.assignmentGuards.map((guard) => guard.extension),
          {
            allowRegisteredAffected: Boolean(operation.rootMetadataGuard),
            allowTargetAnchor: Boolean(operation.rootMetadataGuard),
          },
        );
      }
    } catch (error) {
      await degradeOperation(client, root, operation.operationId, safeError(error));
      throw new DispatchRoutingCommandRejected(safeError(error));
    }
    return;
  }

  if (Object.keys(availabilityTag).length > 0) {
    const extension = readString(availabilityTag.extension);
    const revision = readInteger(availabilityTag.revision);
    if (
      state.operation ||
      revision !== state.revision ||
      extension !== readString(payload.extension) ||
      state.currentPlan[queue] !== extension
    ) {
      throw new DispatchRoutingCommandRejected("Príkaz dostupnosti už nezodpovedá aktuálnemu plánu priorít.");
    }
    const planDigest = await requireCommittedRoutingPlan(client, organizationId, root, state);
    if (readString(availabilityTag.planDigest) !== planDigest) {
      throw new DispatchRoutingCommandRejected("Príkaz dostupnosti nezodpovedá nemennému potvrdenému plánu.");
    }
    if (!command.extension_id || !command.requested_by) {
      throw new DispatchRoutingCommandRejected("Príkazu dostupnosti chýba osobná klapka alebo vlastník.");
    }
    const ownership = await client
      .from("motorist_telephony_extensions")
      .select("id")
      .eq("id", command.extension_id)
      .eq("organization_id", organizationId)
      .eq("provider", PROVIDER)
      .eq("active", true)
      .eq("profile_id", command.requested_by)
      .eq("extension", extension)
      .maybeSingle();
    if (ownership.error || !ownership.data) {
      throw new DispatchRoutingCommandRejected("Osobná klapka už nie je aktívna alebo nepatrí pôvodnému operátorovi.");
    }
    await assertOldestDispatchAvailabilityCommand(client, organizationId, command.id, queue, extension);
    const action = readQueueAction(payload.action);
    if (!action || command.command_type !== `queue.${action}`) {
      throw new DispatchRoutingCommandRejected("Príkaz dostupnosti nemá konzistentnú provider akciu.");
    }
    const assignmentGuard = parseAssignmentGuard(payload.assignmentGuard);
    if (
      !assignmentGuard ||
      assignmentGuard.extensionId !== command.extension_id ||
      assignmentGuard.extension !== extension ||
      assignmentGuard.profileId !== command.requested_by
    ) {
      throw new DispatchRoutingCommandRejected("Príkaz dostupnosti nemá platný assignment interlock osobnej klapky.");
    }
    try {
      await revalidateExtensionAssignmentGuard(client, organizationId, assignmentGuard);
      const snapshot = await loadProviderSnapshot(viptel);
      assertCanonicalDispatchProviderSnapshot(snapshot, [extension]);
      const status = snapshot.queueStatuses.find((candidate) => candidate.queue === queue);
      if (!status) throw new MutationError(`VIPTel nevrátil aktuálny stav radu ${queue}.`, 409);
      validateQueueActionObservedState(status, action, extension);
    } catch (error) {
      throw new DispatchRoutingCommandRejected(safeError(error));
    }
    return;
  }

  if (Object.keys(coverageTag).length > 0) {
    const extension = readString(payload.extension);
    const action = readQueueAction(payload.action);
    if (!extension || !action || command.command_type !== `queue.${action}`) {
      throw new DispatchRoutingCommandRejected("Príkaz pokrytia nemá konzistentnú provider akciu.");
    }
    if (state.operation) {
      throw new DispatchRoutingCommandRejected("Počas zmeny poradia sa pokrytie radov neupravuje.");
    }
    if (readInteger(coverageTag.planRevision) !== state.revision) {
      throw new DispatchRoutingCommandRejected("Príkaz pokrytia už nezodpovedá aktuálnemu plánu priorít.");
    }
    // Only extensions the committed plan owns may be moved.
    const planOrder = DISPATCH_QUEUE_NUMBERS
      .map((number) => state.currentPlan[number])
      .filter((value): value is string => Boolean(value));
    if (!planOrder.includes(extension)) {
      throw new DispatchRoutingCommandRejected("Príkaz pokrytia sa týka klapky mimo potvrdeného plánu.");
    }
    await requireCommittedRoutingPlan(client, organizationId, root, state);

    try {
      const snapshot = await loadProviderSnapshot(viptel);
      assertCanonicalDispatchProviderSnapshot(snapshot, [extension]);
      const status = snapshot.queueStatuses.find((candidate) => candidate.queue === queue);
      if (!status) throw new MutationError(`VIPTel nevrátil aktuálny stav radu ${queue}.`, 409);

      // The strongest fence available: recompute the desired arrangement from
      // the provider state as it is right now. A command queued before somebody
      // went offline can never be delivered afterwards, because the freshly
      // derived digest will no longer match the one it was created for.
      const online = onlineDispatchExtensions({
        planOrder,
        queueStatuses: snapshot.queueStatuses,
        extensions: snapshot.extensions,
      });
      const desired = packDispatchQueueCoverage(DISPATCH_QUEUE_NUMBERS, online);
      if (dispatchCoverageDigest(desired) !== readString(coverageTag.desiredDigest)) {
        throw new MutationError("Pokrytie radov sa medzitým zmenilo; príkaz sa nedoručí.", 409);
      }
      validateQueueActionObservedState(status, action, extension);
    } catch (error) {
      throw new DispatchRoutingCommandRejected(safeError(error));
    }
    return;
  }

  throw new DispatchRoutingCommandRejected(`Rad ${queue} vyžaduje serverom podpísaný routing kontext.`);
}

export async function advanceDispatchRoutingOperationForConfirmedCommand(
  client: AdminClient,
  organizationId: string,
  command: CommandRow,
) {
  const tag = jsonRecord(jsonRecord(command.request_payload).routingOperation);
  const operationId = readString(tag.operationId);
  const stepIndex = readInteger(tag.stepIndex);
  if (!operationId || stepIndex === undefined) return false;
  const root = await requireRootQueue(client, organizationId);
  const state = parseDispatchRoutingState(root.metadata);
  const operation = state.operation;
  const step = operation?.steps[operation.currentStep];
  if (!operation || operation.operationId !== operationId || operation.currentStep !== stepIndex || step?.commandId !== command.id) {
    return false;
  }

  const authorityDigest = await requireAuthorizedRoutingOperation(client, organizationId, operation);
  if (readString(tag.authorityDigest) !== authorityDigest) {
    throw new MutationError("Potvrdenie routing kroku nezodpovedá nemennej autorizácii operácie.", 409);
  }
  const progress = await requireRoutingOperationProgress(client, organizationId, operation, true);
  if (!progress.currentStepConfirmed) {
    await writeRoutingStepConfirmation(client, organizationId, operation, authorityDigest);
  }

  const steps = operation.steps.map((item, index) => index === operation.currentStep ? { ...item, status: "confirmed" as const } : item);
  if (operation.currentStep >= steps.length - 1) {
    const releasePending: DispatchRoutingOperation = {
      ...operation,
      status: "degraded",
      steps,
      lastError: "Všetky provider kroky sú potvrdené; dokončuje sa uvoľnenie assignment interlocku.",
      releasePending: true,
      updatedAt: new Date().toISOString(),
    };
    const releaseRoot = await compareAndSetDispatchRoutingState(client, root, {
      revision: operation.targetRevision,
      currentPlan: operation.targetPlan,
      operation: releasePending,
    });
    try {
      await releaseRoutingAssignmentGuards(client, organizationId, operation.assignmentGuards);
    } catch (error) {
      await writeOperationAudit(
        client,
        organizationId,
        operation.actorProfileId,
        "telephony.routing.operation.release_failed",
        releaseRoot.id,
        { error: safeError(error), operationId },
      ).catch(() => undefined);
      throw error;
    }
    const completedRoot = await compareAndSetDispatchRoutingState(client, releaseRoot, {
      revision: operation.targetRevision,
      currentPlan: operation.targetPlan,
    });
    await writeCommittedRoutingPlan(
      client,
      organizationId,
      operation.actorProfileId,
      completedRoot,
      { revision: operation.targetRevision, currentPlan: operation.targetPlan },
      operation.operationId,
    );
    await writeOperationAudit(client, organizationId, operation.actorProfileId, "telephony.routing.operation.complete", completedRoot.id, {
      operationId,
      revision: operation.targetRevision,
    });
    return true;
  }

  const advanced: DispatchRoutingOperation = {
    ...operation,
    steps,
    currentStep: operation.currentStep + 1,
    updatedAt: new Date().toISOString(),
  };
  const updatedRoot = await compareAndSetDispatchRoutingState(client, root, { ...state, operation: advanced });
  try {
    await enqueueCurrentOperationStep(client, organizationId, advanced);
  } catch (error) {
    await degradeOperation(client, updatedRoot, operationId, safeError(error));
  }
  return true;
}

export async function markDispatchRoutingCommandFailed(
  client: AdminClient,
  organizationId: string,
  command: RoutingFailureCommand,
  reason: string,
) {
  const payload = jsonRecord(command.request_payload);
  const tag = jsonRecord(payload.routingOperation);
  const operationId = readString(tag.operationId);
  const stepIndex = readInteger(tag.stepIndex);
  if (!operationId || stepIndex === undefined) return;
  const root = await requireRootQueue(client, organizationId);
  const state = parseDispatchRoutingState(root.metadata);
  const operation = state.operation;
  const step = operation?.steps[operation.currentStep];
  const exactCurrentStep = Boolean(
    operation && step &&
    command.organization_id === organizationId &&
    command.provider === PROVIDER &&
    operation.operationId === operationId &&
    operation.currentStep === stepIndex &&
    operation.actorProfileId === command.requested_by &&
    operation.targetRevision === readInteger(tag.revision) &&
    dispatchRoutingOperationAuthorityDigest(organizationId, operation) === readString(tag.authorityDigest) &&
    Boolean(operation.initialBootstrap) === (tag.initialBootstrap === true) &&
    !operation.releasePending &&
    step.stepIndex === stepIndex &&
    step.status === "pending" &&
    step.commandId === command.id &&
    step.commandType === command.command_type &&
    step.idempotencyKey === command.idempotency_key &&
    step.queueId === command.queue_id &&
    step.extensionId === command.extension_id &&
    step.queue === readString(payload.queue) &&
    step.extension === readString(payload.extension) &&
    step.action === readString(payload.action)
  );
  if (!exactCurrentStep) return;
  await degradeOperation(client, root, operationId, reason);
}

export class DispatchRoutingCommandRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchRoutingCommandRejected";
  }
}

function emptyPlan(): DispatchPriorityPlan {
  return { "601": null, "602": null, "603": null };
}

function emptyRoutingState(): DispatchRoutingState {
  return { revision: 0, currentPlan: emptyPlan() };
}

function slotsFromPlan(plan: DispatchPriorityPlan): DispatchPrioritySlot[] {
  return DISPATCH_QUEUE_NUMBERS.map((queue) => ({ queue, extension: plan[queue] }));
}

export function planFromDispatchPrioritySlots(slots: DispatchPrioritySlot[], requireComplete = true): DispatchPriorityPlan {
  if (!Array.isArray(slots) || slots.length !== DISPATCH_QUEUE_NUMBERS.length) {
    throw new MutationError("Plán priorít musí obsahovať presne rady 601, 602 a 603.", 400);
  }
  const plan = emptyPlan();
  const seenQueues = new Set<string>();
  const seenExtensions = new Set<string>();
  for (const slot of slots) {
    if (!isDispatchQueue(slot?.queue) || seenQueues.has(slot.queue)) {
      throw new MutationError("Každý z radov 601, 602 a 603 musí byť v pláne práve raz.", 400);
    }
    seenQueues.add(slot.queue);
    const extension = readNumeric(slot.extension);
    if (requireComplete && !extension) throw new MutationError(`Rad ${slot.queue} nemá vybranú osobnú klapku.`, 400);
    if (extension && seenExtensions.has(extension)) throw new MutationError("Jedna osobná klapka nemôže byť vo viacerých prioritách.", 400);
    if (extension) seenExtensions.add(extension);
    plan[slot.queue] = extension ?? null;
  }
  return plan;
}

export function assertDispatchPlanCanStart(state: DispatchRoutingState, baseRevision: number) {
  if (!Number.isInteger(baseRevision) || baseRevision < 0 || baseRevision !== state.revision) {
    throw new MutationError("Plán priorít je zastaraný. Obnov údaje a skús zmenu znova.", 409);
  }
  if (state.operation) {
    throw new MutationError("Predchádzajúca zmena priorít ešte nie je ukončená.", 409);
  }
}

export function assertEmptyDispatchBootstrapState(state: DispatchRoutingState) {
  if (DISPATCH_QUEUE_NUMBERS.some((queue) => state.currentPlan[queue] !== null)) {
    throw new MutationError("Prvotný bootstrap je povolený iba pred vytvorením prvého plánu 601–603.", 409);
  }
  if (state.operation) {
    throw new MutationError("Prvotný bootstrap nemožno spustiť počas rozpracovanej routing operácie.", 409);
  }
}

export function parseDispatchRoutingState(metadata: Json): DispatchRoutingState {
  const root = jsonRecord(metadata);
  const raw = root[ROUTING_METADATA_KEY];
  if (raw === undefined) return emptyRoutingState();
  const record = jsonRecord(raw);
  const revision = readInteger(record.revision);
  if (revision === undefined || revision < 0) throw new MutationError("Metadata plánu priorít sú poškodené.", 409);
  const currentPlan = parseStoredPlan(record.currentPlan);
  const operation = record.operation === undefined || record.operation === null
    ? undefined
    : parseStoredOperation(record.operation);
  if (operation?.releasePending) {
    const rootMatchesTarget =
      revision === operation.targetRevision &&
      DISPATCH_QUEUE_NUMBERS.every((queue) => currentPlan[queue] === operation.targetPlan[queue]);
    const terminalSteps = operation.steps.length === 0
      ? operation.currentStep === 0
      : operation.currentStep === operation.steps.length - 1 &&
        operation.steps.every((step) => step.status === "confirmed");
    if (operation.status !== "degraded" || !rootMatchesTarget || !terminalSteps) {
      throw new MutationError("Metadata release fázy routing operácie nie sú bezpečne terminálne.", 409);
    }
  }
  return { revision, currentPlan, operation };
}

function parseStoredPlan(value: unknown): DispatchPriorityPlan {
  const record = jsonRecord(value);
  const plan = emptyPlan();
  for (const queue of DISPATCH_QUEUE_NUMBERS) {
    const extension = record[queue];
    if (extension !== null && extension !== undefined && !readNumeric(extension)) {
      throw new MutationError("Metadata plánu priorít obsahujú neplatnú klapku.", 409);
    }
    plan[queue] = readNumeric(extension) ?? null;
  }
  const assigned = Object.values(plan).filter((value): value is string => Boolean(value));
  if (new Set(assigned).size !== assigned.length) throw new MutationError("Metadata plánu priorít obsahujú duplicitnú klapku.", 409);
  return plan;
}

function parseStoredOperation(value: unknown): DispatchRoutingOperation {
  const record = jsonRecord(value);
  const status = record.status;
  if (!Array.isArray(record.steps)) {
    throw new MutationError("Metadata krokov routing operácie sú poškodené.", 409);
  }
  const steps = record.steps.map(parseStoredStep);
  const fallbackRecord = jsonRecord(record.fallback);
  const fallbackQueue = readDispatchQueue(fallbackRecord.queue);
  const fallbackExtension = readNumeric(fallbackRecord.extension);
  const fallbackQueueId = readString(fallbackRecord.queueId);
  const fallbackExtensionId = readString(fallbackRecord.extensionId);
  const assignmentGuards = parseStoredAssignmentGuards(record.assignmentGuards);
  const rootMetadataGuard = parseDispatchRoutingRootMetadataGuard(record.rootMetadataGuard);
  const initialBootstrap = record.initialBootstrap === true;
  if (record.initialBootstrap !== undefined && record.initialBootstrap !== true) {
    throw new MutationError("Metadata prvotného bootstrapu priorít sú poškodené.", 409);
  }
  const releasePending = record.releasePending === true;
  if (record.releasePending !== undefined && record.releasePending !== true) {
    throw new MutationError("Metadata release fázy routing operácie sú poškodené.", 409);
  }
  if (
    !readString(record.operationId) ||
    !["applying", "degraded", "rolling_back"].includes(String(status)) ||
    readInteger(record.baseRevision) === undefined ||
    readInteger(record.targetRevision) === undefined ||
    !fallbackQueue || !fallbackExtension || !fallbackQueueId || !fallbackExtensionId ||
    !readString(record.actorProfileId) || !readString(record.createdAt) || !readString(record.updatedAt)
  ) throw new MutationError("Metadata rozpracovanej zmeny priorít sú poškodené.", 409);
  const currentStep = readInteger(record.currentStep);
  if (
    currentStep === undefined || currentStep < 0 ||
    (releasePending && steps.length === 0 ? currentStep !== 0 : currentStep >= steps.length)
  ) {
    throw new MutationError("Metadata kroku zmeny priorít sú poškodené.", 409);
  }
  const operation: DispatchRoutingOperation = {
    operationId: readString(record.operationId) as string,
    status: status as DispatchRoutingOperation["status"],
    baseRevision: readInteger(record.baseRevision) as number,
    targetRevision: readInteger(record.targetRevision) as number,
    previousPlan: parseStoredPlan(record.previousPlan),
    targetPlan: parseStoredPlan(record.targetPlan),
    steps,
    currentStep,
    fallback: { queue: fallbackQueue, extension: fallbackExtension, queueId: fallbackQueueId, extensionId: fallbackExtensionId },
    affectedExtensions: Array.isArray(record.affectedExtensions) ? record.affectedExtensions.map(readNumeric).filter(Boolean) as string[] : [],
    assignmentGuards,
    rootMetadataGuard,
    actorProfileId: readString(record.actorProfileId) as string,
    createdAt: readString(record.createdAt) as string,
    updatedAt: readString(record.updatedAt) as string,
    lastError: readString(record.lastError),
    initialBootstrap: initialBootstrap || undefined,
    releasePending: releasePending || undefined,
  };
  if (operation.initialBootstrap) assertEmptyDispatchBootstrapOperationShape(operation);
  return operation;
}

function parseStoredAssignmentGuards(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new MutationError("Metadata assignment interlocku routing operácie sú poškodené.", 409);
  const guards = value.map(parseAssignmentGuard);
  if (guards.some((guard) => !guard || (guard.profileId === null && !guard.workplaceSeatGeneration))) {
    throw new MutationError("Metadata assignment interlocku routing operácie sú poškodené.", 409);
  }
  return guards as TelephonyAssignmentGuard[];
}

function parseStoredStep(value: unknown): DispatchRoutingStep {
  const record = jsonRecord(value);
  const queue = readDispatchQueue(record.queue);
  const action = readQueueAction(record.action);
  const commandType = readString(record.commandType);
  const status = record.status;
  if (
    readInteger(record.stepIndex) === undefined || !readString(record.commandId) || !readString(record.idempotencyKey) ||
    !queue || !action || commandType !== `queue.${action}` || !readString(record.queueId) || !readNumeric(record.extension) ||
    !readString(record.extensionId) || !["pending", "confirmed"].includes(String(status))
  ) throw new MutationError("Metadata príkazu zmeny priorít sú poškodené.", 409);
  return {
    stepIndex: readInteger(record.stepIndex) as number,
    commandId: readString(record.commandId) as string,
    idempotencyKey: readString(record.idempotencyKey) as string,
    commandType: commandType as DispatchRoutingStep["commandType"],
    action,
    queue,
    queueId: readString(record.queueId) as string,
    extension: readNumeric(record.extension) as string,
    extensionId: readString(record.extensionId) as string,
    status: status as DispatchRoutingStep["status"],
  };
}

function operationSummary(operation?: DispatchRoutingOperation) {
  if (!operation) return null;
  return {
    operationId: operation.operationId,
    status: operation.status,
    baseRevision: operation.baseRevision,
    targetRevision: operation.targetRevision,
    previousPlan: slotsFromPlan(operation.previousPlan),
    targetPlan: slotsFromPlan(operation.targetPlan),
    currentStep: operation.currentStep,
    stepCount: operation.steps.length,
    fallback: { queue: operation.fallback.queue, extension: operation.fallback.extension },
    lastError: operation.lastError,
    initialBootstrap: operation.initialBootstrap,
    releasePending: operation.releasePending,
    rootMetadataGuard: operation.rootMetadataGuard,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
  };
}

export function planDispatchQueueCatalog(rows: Array<Pick<QueueRow, "id" | "external_id" | "label" | "line_id" | "active">>) {
  const byNumber = new Map(rows.map((row) => [row.external_id, row]));
  const queues = DISPATCH_QUEUE_NUMBERS.map((queue) => {
    const existing = byNumber.get(queue);
    const action = !existing ? "insert" : existing.line_id !== null || !existing.active || existing.label !== QUEUE_LABELS[queue] ? "update" : "noop";
    return {
      queue,
      label: QUEUE_LABELS[queue],
      id: existing?.id,
      lineId: existing?.line_id,
      action: action as "insert" | "update" | "noop",
    };
  });
  return { ready: queues.every((queue) => queue.action === "noop"), queues };
}

async function loadDispatchQueueRows(client: AdminClient, organizationId: string) {
  const result = await client
    .from("motorist_telephony_queues")
    .select("id, external_id, label, line_id, active, metadata, updated_at")
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .in("external_id", [...DISPATCH_QUEUE_NUMBERS])
    .order("external_id", { ascending: true });
  throwQueryError(result.error, "Katalóg dispečerských radov sa nepodarilo načítať.");
  return result.data ?? [];
}

export async function requireDispatchQueueCatalog(client: AdminClient, organizationId: string) {
  const rows = await loadDispatchQueueRows(client, organizationId);
  const plan = planDispatchQueueCatalog(rows);
  if (!plan.ready) throw new MutationError("Najprv bezpečne priprav katalóg radov 601–603 s line_id = null.", 409);
  return new Map(rows.map((row) => [row.external_id as DispatchQueueNumber, row]));
}

async function requireRootQueue(client: AdminClient, organizationId: string): Promise<RootQueue> {
  const result = await client
    .from("motorist_telephony_queues")
    .select("id, external_id, line_id, metadata, updated_at")
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .eq("external_id", "601")
    .eq("active", true)
    .is("line_id", null)
    .maybeSingle();
  throwQueryError(result.error, "Koreňový rad 601 sa nepodarilo načítať.");
  if (!result.data) throw new MutationError("Rad 601 nie je pripravený pre spoločné DID smerovanie.", 409);
  return result.data;
}

async function requirePlanExtensions(
  client: AdminClient,
  organizationId: string,
  plan: DispatchPriorityPlan,
  fallbackValue: unknown,
  enforceConfigured = true,
  extraExtensions: string[] = [],
) {
  const planExtensions = Object.values(plan).filter((value): value is string => Boolean(value));
  const fallback = readNumeric(fallbackValue);
  if (!fallback) throw new MutationError("Záložná klapka musí byť číselná.", 400);
  if (enforceConfigured) {
    const allowed = new Set(configuredPersonalExtensions());
    const invalid = planExtensions.find((extension) => !allowed.has(extension));
    if (invalid) throw new MutationError(`Klapka ${invalid} nie je medzi povolenými osobnými klapkami.`, 400);
  }
  const requested = [...new Set([...planExtensions, ...extraExtensions.filter((value) => /^\d{1,8}$/.test(value)), fallback])];
  const hotdeskRuntime = workplaceHotdeskCapability().runtimeEnabled;
  const result = hotdeskRuntime
    ? await client
        .from("motorist_telephony_extensions")
        .select("id, extension, profile_id, active, is_registered, metadata, workplace_seat_generation")
        .eq("organization_id", organizationId)
        .eq("provider", PROVIDER)
        .eq("active", true)
        .in("extension", requested)
    : await client
        .from("motorist_telephony_extensions")
        .select("id, extension, profile_id, active, is_registered")
        .eq("organization_id", organizationId)
        .eq("provider", PROVIDER)
        .eq("active", true)
        .in("extension", requested);
  throwQueryError(result.error, "Osobné a záložné klapky sa nepodarilo overiť.");
  const rows = (result.data ?? []) as ExtensionRow[];
  for (const extension of planExtensions) {
    const row = rows.find((candidate) => candidate.extension === extension);
    if (!row || (!row.profile_id && !isCanonicalUnassignedRoutingSeat(row, hotdeskRuntime))) {
      throw new MutationError(`Klapka ${extension} nepatrí aktívnemu operátorovi ani overenému voľnému pracovisku.`, 409);
    }
  }
  if (!rows.some((row) => row.extension === fallback)) throw new MutationError(`Záložná klapka ${fallback} nie je aktívna.`, 409);
  return new Map(rows.map((row) => [row.extension, row as ExtensionRow]));
}

function resolveFallback(
  input: { queue: unknown; extension: unknown },
  queues: Map<DispatchQueueNumber, CatalogQueueRow>,
  extensions: Map<string, ExtensionRow>,
): DispatchRoutingFallback {
  const queue = readDispatchQueue(input.queue);
  const extension = readNumeric(input.extension);
  const queueRow = queue ? queues.get(queue) : undefined;
  const extensionRow = extension ? extensions.get(extension) : undefined;
  if (!queue || !queueRow || !extension || !extensionRow) {
    throw new MutationError("Nezávislá záloha musí odkazovať na existujúci rad a aktívnu klapku.", 400);
  }
  return { queue, extension, queueId: queueRow.id, extensionId: extensionRow.id };
}

function routingGuardExtensionIds(
  extensions: Map<string, ExtensionRow>,
  previousPlan: DispatchPriorityPlan,
  targetPlan: DispatchPriorityPlan,
  fallbackExtension: string,
) {
  const numbers = [...new Set([
    ...Object.values(previousPlan),
    ...Object.values(targetPlan),
    fallbackExtension,
  ].filter((value): value is string => Boolean(value)))];
  return numbers.map((extension) => {
    const row = extensions.get(extension);
    if (!row) throw new MutationError(`Klapka ${extension} chýba v assignment interlocku routing plánu.`, 409);
    return row.id;
  });
}

function assertRoutingAssignmentGuardsMatchRows(
  guards: readonly TelephonyAssignmentGuard[],
  extensions: Map<string, ExtensionRow>,
) {
  const rows = [...extensions.values()];
  if (guards.length !== rows.length) {
    throw new MutationError("Routing assignment interlock neobsahuje presne všetky použité klapky.", 409);
  }
  for (const row of rows) {
    const guard = guards.find((candidate) => candidate.extensionId === row.id);
    if (
      !guard || guard.extension !== row.extension || guard.profileId !== row.profile_id ||
      (row.profile_id === null && !guard.workplaceSeatGeneration)
    ) {
      throw new MutationError(`Vlastník klapky ${row.extension} sa počas prípravy routing plánu zmenil.`, 409);
    }
  }
}

function isCanonicalUnassignedRoutingSeat(
  row: Pick<ExtensionRow, "id" | "extension" | "metadata" | "profile_id" | "workplace_seat_generation">,
  runtimeEnabled: boolean,
) {
  if (!runtimeEnabled || row.profile_id !== null || !row.workplace_seat_generation) return false;
  const metadata = jsonRecord(row.metadata);
  const lifecycle = readAssignmentLifecycle(metadata.assignmentLifecycle);
  return lifecycle?.assignmentMode === "workplace_claim" && lifecycle.state === "unassigned" &&
    lifecycle.extensionId === row.id && lifecycle.extension === row.extension && lifecycle.profileId === null;
}

async function recoverOrCaptureRoutingAssignmentGuards(
  client: AdminClient,
  organizationId: string,
  operation: DispatchRoutingOperation,
  extensions: Map<string, ExtensionRow>,
  recoveryTarget: DispatchPriorityPlan,
  fallbackExtension: string,
) {
  if (operation.assignmentGuards.length > 0) {
    assertRoutingAssignmentGuardCoverage(operation);
    assertRoutingAssignmentGuardsMatchRows(operation.assignmentGuards, extensions);
    try {
      await revalidateRoutingAssignmentGuards(client, organizationId, operation.assignmentGuards);
      return { captured: false as const, guards: operation.assignmentGuards };
    } catch (error) {
      if (!(error instanceof AssignmentInterlockRejected)) throw error;
      // Legacy or manually recovered metadata can hold a stale claim while
      // the exact extension ids/numbers/owners are still unchanged. A fresh
      // CAS capture is the only safe way to continue that durable operation.
    }
  }
  const guards = await captureRoutingAssignmentGuards(
    client,
    organizationId,
    routingGuardExtensionIds(extensions, operation.previousPlan, recoveryTarget, fallbackExtension),
    "dispatch.routing.recover",
    operation.operationId,
  );
  try {
    assertRoutingAssignmentGuardsMatchRows(guards, extensions);
  } catch (error) {
    await releaseUnpersistedRoutingGuards(client, organizationId, guards, error);
    throw error;
  }
  return { captured: true as const, guards };
}

async function releaseUnpersistedRoutingGuards(
  client: AdminClient,
  organizationId: string,
  guards: readonly TelephonyAssignmentGuard[],
  originalError: unknown,
) {
  try {
    await releaseRoutingAssignmentGuards(client, organizationId, guards);
  } catch (cleanupError) {
    throw new MutationError(
      `Routing operácia sa neuložila a jej interlock sa nepodarilo uvoľniť. Vyžaduje manuálnu obnovu. ` +
      `Pôvodná chyba: ${safeError(originalError)}; cleanup: ${safeError(cleanupError)}`,
      500,
    );
  }
}

export function assertRoutingAssignmentGuardCoverage(operation: DispatchRoutingOperation) {
  const expected = new Set([
    ...Object.values(operation.previousPlan),
    ...Object.values(operation.targetPlan),
    ...operation.steps.map((step) => step.extension),
    operation.fallback.extension,
  ].filter((value): value is string => Boolean(value)));
  const actual = operation.assignmentGuards.map((guard) => guard.extension);
  const byExtension = new Map(operation.assignmentGuards.map((guard) => [guard.extension, guard]));
  if (
    (operation.initialBootstrap ? actual.length < expected.size : actual.length !== expected.size) ||
    new Set(actual).size !== actual.length ||
    (operation.initialBootstrap
      ? [...expected].some((extension) => !byExtension.has(extension))
      : actual.some((extension) => !expected.has(extension))) ||
    operation.assignmentGuards.some((guard) => guard.routingOperationId !== operation.operationId) ||
    operation.steps.some((step) => byExtension.get(step.extension)?.extensionId !== step.extensionId) ||
    byExtension.get(operation.fallback.extension)?.extensionId !== operation.fallback.extensionId
  ) {
    throw new MutationError("Routing operácia nemá úplné assignment snapshoty všetkých použitých klapiek.", 409);
  }
}

async function loadProviderSnapshot(
  client: DispatchProviderClient,
): Promise<ProviderSnapshot> {
  const [extensions, queueStatuses, activeCalls] = await Promise.all([
    client.listExtensions(),
    Promise.all(DISPATCH_QUEUE_NUMBERS.map((queue) => client.getQueueStatus(queue))),
    typeof client.listActiveCalls === "function" ? client.listActiveCalls() : Promise.resolve(undefined),
  ]);
  const snapshot = { extensions, queueStatuses, activeCalls };
  assertCanonicalDispatchProviderSnapshot(snapshot);
  return snapshot;
}

async function loadEmptyBootstrapProviderSnapshot(
  client: DispatchProviderClient,
): Promise<EmptyBootstrapProviderSnapshot> {
  if (typeof client.listActiveCalls !== "function") {
    throw new MutationError("VIPTel klient nevie overiť aktívne hovory; prvotný bootstrap zostal zablokovaný.", 502);
  }
  const [extensions, activeCalls, queueStatuses] = await Promise.all([
    client.listExtensions(),
    client.listActiveCalls(),
    Promise.all(DISPATCH_QUEUE_NUMBERS.map((queue) => client.getQueueStatus(queue))),
  ]);
  const snapshot = { extensions, activeCalls, queueStatuses };
  assertCanonicalDispatchProviderSnapshot(snapshot);
  return snapshot;
}

export function assertCompleteDispatchQueueStatuses(statuses: ViptelQueueStatus[]) {
  const counts = new Map<string, number>();
  for (const status of statuses) counts.set(status.queue, (counts.get(status.queue) ?? 0) + 1);
  const invalid = DISPATCH_QUEUE_NUMBERS.filter((queue) => counts.get(queue) !== 1);
  if (statuses.length !== DISPATCH_QUEUE_NUMBERS.length || invalid.length > 0) {
    throw new MutationError(
      "VIPTel musí vrátiť práve jeden aktuálny stav pre každý rad 601, 602 a 603; neúplný alebo duplicitný snapshot bol odmietnutý.",
      409,
    );
  }
}

export function assertCanonicalDispatchProviderSnapshot(
  snapshot: ProviderSnapshot,
  requiredExtensions: Iterable<string> = [],
) {
  assertCompleteDispatchQueueStatuses(snapshot.queueStatuses);

  const extensionCounts = new Map<string, number>();
  for (const extension of snapshot.extensions) {
    extensionCounts.set(extension.extension, (extensionCounts.get(extension.extension) ?? 0) + 1);
  }
  const duplicateExtension = [...extensionCounts].find(([, count]) => count > 1)?.[0];
  if (duplicateExtension) {
    throw new MutationError(
      `VIPTel vrátil duplicitný alebo konfliktný záznam klapky ${duplicateExtension}; snapshot bol odmietnutý.`,
      409,
    );
  }

  for (const extension of new Set(requiredExtensions)) {
    if (extensionCounts.get(extension) !== 1) {
      throw new MutationError(
        `VIPTel musí vrátiť práve jeden aktuálny záznam klapky ${extension}; neúplný alebo duplicitný snapshot bol odmietnutý.`,
        409,
      );
    }
  }

  assertCanonicalDispatchQueueMembers(snapshot.queueStatuses);
}

function assertCanonicalDispatchQueueMembers(statuses: ViptelQueueStatus[]) {
  for (const status of statuses) {
    const counts = new Map<string, number>();
    for (const member of status.members) {
      const count = (counts.get(member.extension) ?? 0) + 1;
      counts.set(member.extension, count);
      if (count > 1) {
        throw new MutationError(
          `VIPTel vrátil duplicitné alebo konfliktné členstvo ${status.queue}/${member.extension}; snapshot bol odmietnutý.`,
          409,
        );
      }
    }
  }
}

function buildRoutingSteps(
  queues: Map<DispatchQueueNumber, CatalogQueueRow>,
  extensions: Map<string, ExtensionRow>,
  statuses: ViptelQueueStatus[],
  previousPlan: DispatchPriorityPlan,
  targetPlan: DispatchPriorityPlan,
  additionalManagedExtensions: string[] = [],
) {
  const steps: Omit<DispatchRoutingStep, "stepIndex">[] = [];
  const statusByQueue = new Map(statuses.map((status) => [status.queue, status]));
  const managedExtensions = new Set(
    [...Object.values(previousPlan), ...Object.values(targetPlan), ...additionalManagedExtensions]
      .filter((value): value is string => Boolean(value)),
  );
  const addStep = (queue: DispatchQueueNumber, extension: string, action: ViptelQueueAgentAction) => {
    const queueRow = queues.get(queue);
    const extensionRow = extensions.get(extension);
    if (!queueRow || !extensionRow) throw new MutationError("Routing diff odkazuje na neznámy rad alebo klapku.", 409);
    steps.push({
      commandId: randomUUID(),
      idempotencyKey: randomUUID().replaceAll("-", ""),
      commandType: `queue.${action}`,
      action,
      queue,
      queueId: queueRow.id,
      extension,
      extensionId: extensionRow.id,
      status: "pending",
    });
  };

  // Make before break: create/unpause every target membership first.
  for (const queue of DISPATCH_QUEUE_NUMBERS) {
    const target = targetPlan[queue];
    if (!target) continue;
    const member = statusByQueue.get(queue)?.members.find((candidate) => candidate.extension === target);
    if (!member) addStep(queue, target, "add");
    else if (member.paused) addStep(queue, target, "unpause");
  }
  for (const queue of DISPATCH_QUEUE_NUMBERS) {
    const target = targetPlan[queue];
    for (const member of statusByQueue.get(queue)?.members ?? []) {
      if (!managedExtensions.has(member.extension) || member.extension === target) continue;
      if (!member.dynamic) throw new MutationError(`Statické členstvo ${queue}/${member.extension} aplikácia nesmie odstrániť.`, 409);
      addStep(queue, member.extension, "remove");
    }
  }
  return steps.map((step, stepIndex) => ({ ...step, stepIndex }));
}

function buildEmptyBootstrapSteps(
  queues: Map<DispatchQueueNumber, CatalogQueueRow>,
  extensions: Map<string, ExtensionRow>,
  targetPlan: DispatchPriorityPlan,
): DispatchRoutingStep[] {
  return (["603", "602", "601"] as const).flatMap((queue) => {
    const extension = targetPlan[queue];
    if (!extension) return [];
    const queueRow = queues.get(queue);
    const extensionRow = extensions.get(extension);
    if (!queueRow || !extensionRow) {
      throw new MutationError("Bootstrap diff odkazuje na neznámy rad alebo osobnú klapku.", 409);
    }
    return [{
      stepIndex: 0,
      commandId: randomUUID(),
      idempotencyKey: randomUUID().replaceAll("-", ""),
      commandType: "queue.add" as const,
      action: "add" as const,
      queue,
      queueId: queueRow.id,
      extension,
      extensionId: extensionRow.id,
      status: "pending" as const,
    }];
  }).map((step, stepIndex) => ({ ...step, stepIndex }));
}

function buildEmptyBootstrapResumeSteps(
  queues: Map<DispatchQueueNumber, CatalogQueueRow>,
  extensions: Map<string, ExtensionRow>,
  statuses: ViptelQueueStatus[],
  targetPlan: DispatchPriorityPlan,
) {
  const present = new Set(
    statuses.flatMap((status) => status.members.map((member) => `${status.queue}:${member.extension}`)),
  );
  const missingQueues = (["603", "602", "601"] as const).filter((queue) => {
    const extension = targetPlan[queue];
    return extension && !present.has(`${queue}:${extension}`);
  });
  return missingQueues.map((queue, stepIndex) => {
    const extension = targetPlan[queue];
    const queueRow = queues.get(queue);
    const extensionRow = extension ? extensions.get(extension) : undefined;
    if (!extension || !queueRow || !extensionRow) {
      throw new MutationError("Obnova bootstrapu odkazuje na neznámy rad alebo osobnú klapku.", 409);
    }
    return {
      stepIndex,
      commandId: randomUUID(),
      idempotencyKey: randomUUID().replaceAll("-", ""),
      commandType: "queue.add" as const,
      action: "add" as const,
      queue,
      queueId: queueRow.id,
      extension,
      extensionId: extensionRow.id,
      status: "pending" as const,
    };
  });
}

export function validateDispatchControlledWindow(
  snapshot: ProviderSnapshot,
  steps: DispatchRoutingStep[],
  fallback: DispatchRoutingFallback,
  relevantExtensions: Iterable<string> = [],
  options: { allowRegisteredAffected?: boolean; allowTargetAnchor?: boolean } = {},
) {
  const affected = new Set(steps.map((step) => step.extension));
  assertCanonicalDispatchProviderSnapshot(snapshot, [...relevantExtensions, ...affected, fallback.extension]);
  const anchorStep = steps.find(
    (step) => step.queue === fallback.queue && step.extension === fallback.extension,
  );
  const targetAnchor = Boolean(
    options.allowTargetAnchor && anchorStep?.stepIndex === 0 &&
    (anchorStep.action === "add" || anchorStep.action === "unpause"),
  );
  if (anchorStep && !targetAnchor) {
    throw new MutationError("Nezávislá záloha nesmie byť súčasťou menených krokov.", 409);
  }
  if (snapshot.queueStatuses.some((status) => status.waitingCalls > 0)) {
    throw new MutationError("Zmenu priorít nemožno vykonať, kým v rade čaká hovor.", 409);
  }
  for (const extension of affected) {
    const provider = snapshot.extensions.find((candidate) => candidate.extension === extension);
    if (!provider || (provider.isRegistered !== true && provider.isRegistered !== false)) {
      throw new MutationError(`Registrácia klapky ${extension} nie je v živom VIPTel stave jednoznačná.`, 409);
    }
    if (provider.isRegistered) {
      if (options.allowRegisteredAffected !== true) {
        throw new MutationError(`Klapka ${extension} musí byť počas servisnej zmeny preukázateľne odregistrovaná.`, 409);
      }
      if (!snapshot.activeCalls) {
        throw new MutationError(`VIPTel nevie overiť aktívne hovory klapky ${extension}; zmena bola zastavená.`, 409);
      }
    }
    if (snapshot.activeCalls?.some((call) => activeCallReferencesExtension(call, extension))) {
      throw new MutationError(`Klapka ${extension} má aktívny hovor. Zmena priority bola zastavená.`, 409);
    }
    if (snapshot.queueStatuses.some((status) => status.members.some((member) => member.extension === extension && member.inUse))) {
      throw new MutationError(`Klapka ${extension} je stále používaná hovorom.`, 409);
    }
  }
  const fallbackProvider = snapshot.extensions.find((candidate) => candidate.extension === fallback.extension);
  const fallbackMember = snapshot.queueStatuses
    .find((status) => status.queue === fallback.queue)
    ?.members.find((member) => member.extension === fallback.extension);
  if (targetAnchor) {
    if (fallbackProvider?.isRegistered !== true || fallbackMember?.inUse ||
        (anchorStep?.action === "add" && fallbackMember) ||
        (anchorStep?.action === "unpause" && (!fallbackMember || !fallbackMember.paused))) {
      throw new MutationError("Nová bezpečnostná kotva nie je pripravená na pridanie pred odobratím voľného miesta.", 409);
    }
    return;
  }
  if (fallbackProvider?.isRegistered !== true || !fallbackMember || fallbackMember.paused || fallbackMember.inUse) {
    throw new MutationError("Nezávislá záloha už nie je registrovaná, voľná a nepozastavená.", 409);
  }
}

function activeCallReferencesExtension(call: ViptelActiveCall, extension: string) {
  if (["ended", "failed", "missed", "abandoned_queue"].includes(call.status)) return false;
  return [
    call.callerExtension,
    call.receivedExtension,
    call.destinationExtension,
    call.callerNumber,
    call.calledNumber,
  ].some((value) => normalizeEndpoint(value) === extension);
}

function normalizeEndpoint(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/^sip:/i, "").split("@")[0];
  return /^\d{1,20}$/.test(normalized) ? normalized : undefined;
}

export function validateEmptyDispatchBootstrapStart(
  snapshot: EmptyBootstrapProviderSnapshot,
  targetPlan: DispatchPriorityPlan,
  fallback: DispatchRoutingFallback,
) {
  const targets = Object.values(targetPlan).filter((value): value is string => Boolean(value));
  const expectedFallback = initialBootstrapFallback(targetPlan);
  assertCanonicalDispatchProviderSnapshot(snapshot, targets);
  if (fallback.queue !== expectedFallback.queue || fallback.extension !== expectedFallback.extension) {
    throw new MutationError("Prvotný bootstrap musí použiť posledného vybraného operátora ako bezpečnostnú kotvu.", 409);
  }
  if (snapshot.queueStatuses.some((status) => status.waitingCalls > 0 || status.members.length > 0)) {
    throw new MutationError("Prvotný bootstrap je povolený iba vtedy, keď sú rady 601–603 úplne prázdne a bez čakajúcich hovorov.", 409);
  }
  assertNoLiveBootstrapCalls(snapshot.activeCalls);
  for (const extension of targets) {
    const provider = snapshot.extensions.find((candidate) => candidate.extension === extension);
    if (provider?.isRegistered !== true) {
      throw new MutationError(`Klapka ${extension} musí byť pred prvotným bootstrapom preukázateľne registrovaná.`, 409);
    }
  }
}

export function validateEmptyDispatchBootstrapOperation(
  snapshot: EmptyBootstrapProviderSnapshot,
  operation: DispatchRoutingOperation,
) {
  if (!operation.initialBootstrap) {
    throw new MutationError("Routing operácia nie je označená ako prvotný bootstrap.", 409);
  }
  assertEmptyDispatchBootstrapOperationShape(operation);
  const requiredExtensions = operation.assignmentGuards.map((guard) => guard.extension);
  assertCanonicalDispatchProviderSnapshot(snapshot, requiredExtensions);
  if (snapshot.queueStatuses.some((status) => status.waitingCalls > 0)) {
    throw new MutationError("Prvotný bootstrap nemožno meniť, kým v rade čaká hovor.", 409);
  }
  assertNoLiveBootstrapCalls(snapshot.activeCalls);
  for (const extension of requiredExtensions) {
    const provider = snapshot.extensions.find((candidate) => candidate.extension === extension);
    if (provider?.isRegistered !== true) {
      throw new MutationError(`Klapka ${extension} sa počas prvotného bootstrapu odregistrovala.`, 409);
    }
  }

  const expected = new Map<string, { queue: DispatchQueueNumber; extension: string }>();
  if (operation.status === "rolling_back") {
    for (const step of operation.steps) {
      if (step.action !== "remove") {
        throw new MutationError("Rollback prvotného bootstrapu obsahuje nepovolený provider krok.", 409);
      }
      if (step.stepIndex >= operation.currentStep && step.status !== "confirmed") {
        expected.set(`${step.queue}:${step.extension}`, { queue: step.queue, extension: step.extension });
      }
    }
  } else {
    for (const queue of DISPATCH_QUEUE_NUMBERS) {
      const extension = operation.targetPlan[queue];
      if (!extension) continue;
      const pendingAdd = operation.steps.some(
        (step) =>
          step.action === "add" &&
          step.queue === queue &&
          step.extension === extension &&
          step.stepIndex >= operation.currentStep &&
          step.status !== "confirmed",
      );
      if (!pendingAdd) expected.set(`${queue}:${extension}`, { queue, extension });
    }
  }

  const actual = new Map<string, ViptelQueueStatus["members"][number]>();
  for (const status of snapshot.queueStatuses) {
    for (const member of status.members) actual.set(`${status.queue}:${member.extension}`, member);
  }
  if (actual.size !== expected.size || [...actual.keys()].some((key) => !expected.has(key))) {
    throw new MutationError("Živý stav radov už nezodpovedá presnému priebehu prvotného bootstrapu.", 409);
  }
  for (const [key, member] of actual) {
    if (member.paused || member.inUse || !member.dynamic) {
      throw new MutationError(`Bootstrap členstvo ${key} musí byť dynamické, nepozastavené a mimo hovoru.`, 409);
    }
  }

  const anchorKey = `${operation.fallback.queue}:${operation.fallback.extension}`;
  if (operation.status !== "rolling_back" && operation.currentStep > 0 && !actual.has(anchorKey)) {
    throw new MutationError("Bezpečnostná kotva posledného obsadeného radu sa počas prvotného bootstrapu stratila.", 409);
  }
  if (operation.status === "rolling_back") {
    const pendingAnchor = operation.steps.find(
      (step) => step.queue === operation.fallback.queue && step.extension === operation.fallback.extension && step.status !== "confirmed",
    );
    if (pendingAnchor && pendingAnchor.stepIndex !== operation.steps.length - 1) {
      throw new MutationError("Rollback prvotného bootstrapu musí odstrániť bezpečnostnú kotvu ako poslednú.", 409);
    }
  }
}

export function validateEmptyDispatchBootstrapRecoverySnapshot(
  snapshot: EmptyBootstrapProviderSnapshot,
  operation: DispatchRoutingOperation,
) {
  if (!operation.initialBootstrap) {
    throw new MutationError("Routing operácia nie je označená ako prvotný bootstrap.", 409);
  }
  assertEmptyDispatchBootstrapOperationShape(operation);
  const requiredExtensions = operation.assignmentGuards.map((guard) => guard.extension);
  assertCanonicalDispatchProviderSnapshot(snapshot, requiredExtensions);
  if (snapshot.queueStatuses.some((status) => status.waitingCalls > 0)) {
    throw new MutationError("Prvotný bootstrap nemožno obnoviť, kým v rade čaká hovor.", 409);
  }
  assertNoLiveBootstrapCalls(snapshot.activeCalls);
  for (const extension of requiredExtensions) {
    if (snapshot.extensions.find((candidate) => candidate.extension === extension)?.isRegistered !== true) {
      throw new MutationError(`Klapka ${extension} musí zostať registrovaná aj počas obnovy bootstrapu.`, 409);
    }
  }

  const plannedPairs = new Set<string>();
  const plannedByQueue = new Map<DispatchQueueNumber, string>();
  for (const queue of DISPATCH_QUEUE_NUMBERS) {
    const extension = operation.targetPlan[queue];
    if (extension) {
      plannedPairs.add(`${queue}:${extension}`);
      plannedByQueue.set(queue, extension);
    }
  }
  for (const step of operation.steps) {
    plannedPairs.add(`${step.queue}:${step.extension}`);
    const existing = plannedByQueue.get(step.queue);
    if (existing && existing !== step.extension) {
      throw new MutationError("Metadata bootstrapu obsahujú konfliktné klapky pre rovnaký rad.", 409);
    }
    plannedByQueue.set(step.queue, step.extension);
  }

  const actualPairs: string[] = [];
  for (const status of snapshot.queueStatuses) {
    for (const member of status.members) {
      const key = `${status.queue}:${member.extension}`;
      actualPairs.push(key);
      if (!plannedPairs.has(key) || member.paused || member.inUse || !member.dynamic) {
        throw new MutationError("Živý stav radov obsahuje neočakávané alebo nedostupné členstvo; bootstrap ostáva zablokovaný.", 409);
      }
    }
  }
  if (actualPairs.length > 0 && !actualPairs.includes(`${operation.fallback.queue}:${operation.fallback.extension}`)) {
    throw new MutationError("Čiastočný bootstrap stratil bezpečnostnú kotvu posledného obsadeného radu.", 409);
  }
  const safePrefix = (["603", "602", "601"] as const)
    .flatMap((queue) => {
      const extension = plannedByQueue.get(queue);
      return extension ? [`${queue}:${extension}`] : [];
    });
  const expectedPrefix = new Set(safePrefix.slice(0, actualPairs.length));
  if (
    actualPairs.length > safePrefix.length ||
    actualPairs.some((pair) => !expectedPrefix.has(pair))
  ) {
    throw new MutationError("Čiastočný bootstrap nezodpovedá presnému bezpečnému poradiu od posledného obsadeného radu.", 409);
  }
}

export function assertEmptyDispatchBootstrapOperationShape(operation: DispatchRoutingOperation) {
  if (!operation.initialBootstrap) {
    throw new MutationError("Routing operácia nie je označená ako prvotný bootstrap.", 409);
  }
  if (DISPATCH_QUEUE_NUMBERS.some((queue) => operation.previousPlan[queue] !== null)) {
    throw new MutationError("Prvotný bootstrap musí vychádzať z úplne prázdneho uloženého plánu.", 409);
  }
  const assignedTargets = DISPATCH_QUEUE_NUMBERS.filter((queue) => operation.targetPlan[queue] !== null);
  const rollingBack = assignedTargets.length === 0;
  if (!rollingBack) {
    const expectedFallback = initialBootstrapFallback(operation.targetPlan);
    if (
      operation.fallback.queue !== expectedFallback.queue ||
      operation.fallback.extension !== expectedFallback.extension
    ) {
      throw new MutationError("Bezpečnostná kotva bootstrapu nezodpovedá poslednému obsadenému radu.", 409);
    }
  } else if (!isDispatchQueue(operation.fallback.queue)) {
    throw new MutationError("Rollback prvotného bootstrapu nemá platnú bezpečnostnú kotvu.", 409);
  }
  if (operation.status === "applying" && rollingBack) {
    throw new MutationError("Aplikovanie prvotného bootstrapu nemá úplný cieľový plán.", 409);
  }
  if (operation.status === "rolling_back" && !rollingBack) {
    throw new MutationError("Rollback prvotného bootstrapu nemá úplne prázdny cieľový plán.", 409);
  }

  const expectedAction = rollingBack ? "remove" : "add";
  const fallbackIndex = DISPATCH_QUEUE_NUMBERS.indexOf(operation.fallback.queue);
  const selectedPrefix = DISPATCH_QUEUE_NUMBERS.slice(0, fallbackIndex + 1);
  const expectedOrder: readonly DispatchQueueNumber[] = rollingBack
    ? selectedPrefix
    : [...selectedPrefix].reverse();
  const rank = new Map(expectedOrder.map((queue, index) => [queue, index]));
  const seenQueues = new Set<DispatchQueueNumber>();
  let previousRank = -1;
  for (const [index, step] of operation.steps.entries()) {
    const stepRank = rank.get(step.queue);
    if (
      step.stepIndex !== index ||
      step.action !== expectedAction ||
      step.commandType !== `queue.${expectedAction}` ||
      stepRank === undefined ||
      stepRank <= previousRank ||
      seenQueues.has(step.queue)
    ) {
      throw new MutationError("Kroky prvotného bootstrapu majú neplatné poradie alebo typ.", 409);
    }
    if (!rollingBack && operation.targetPlan[step.queue] !== step.extension) {
      throw new MutationError("Krok prvotného bootstrapu nezodpovedá cieľovej klapke radu.", 409);
    }
    if (rollingBack && step.queue === operation.fallback.queue && step.extension !== operation.fallback.extension) {
      throw new MutationError("Rollback bootstrapu odkazuje na inú bezpečnostnú kotvu.", 409);
    }
    seenQueues.add(step.queue);
    previousRank = stepRank;
  }
  if ((operation.status === "applying" || operation.status === "rolling_back") && operation.steps.length === 0) {
    throw new MutationError("Rozpracovanému prvotnému bootstrapu chýbajú provider kroky.", 409);
  }
  assertRoutingAssignmentGuardCoverage(operation);
}

function initialBootstrapFallback(plan: DispatchPriorityPlan): {
  queue: DispatchQueueNumber;
  extension: string;
} {
  let emptySeen = false;
  let fallback: { queue: DispatchQueueNumber; extension: string } | undefined;
  for (const queue of DISPATCH_QUEUE_NUMBERS) {
    const extension = plan[queue];
    if (!extension) {
      emptySeen = true;
      continue;
    }
    if (emptySeen) {
      throw new MutationError("Prvé nastavenie musí obsadiť poradie súvislo od prvého radu 601.", 400);
    }
    fallback = { queue, extension };
  }
  if (!fallback) {
    throw new MutationError("Prvé nastavenie potrebuje aspoň jedného operátora v rade 601.", 400);
  }
  return fallback;
}

function assertNoLiveBootstrapCalls(calls: ViptelActiveCall[]) {
  const live = calls.filter((call) => !["ended", "failed", "missed", "abandoned_queue"].includes(call.status));
  if (live.length > 0) {
    throw new MutationError("Prvotný bootstrap je povolený iba bez aktívnych VIPTel hovorov.", 409);
  }
}

export function validateDispatchStepObservedState(statuses: ViptelQueueStatus[], step: DispatchRoutingStep) {
  assertCanonicalDispatchQueueMembers(statuses);
  const status = statuses.find((candidate) => candidate.queue === step.queue);
  if (!status) throw new MutationError(`VIPTel nevrátil aktuálny stav radu ${step.queue}.`, 409);
  validateQueueActionObservedState(status, step.action, step.extension);
}

function validateQueueActionObservedState(
  status: ViptelQueueStatus,
  action: ViptelQueueAgentAction,
  extension: string,
) {
  const member = status.members.find((candidate) => candidate.extension === extension);
  const valid = action === "add"
    ? !member
    : action === "remove"
      ? Boolean(member?.dynamic)
      : action === "pause"
        ? Boolean(member && !member.paused)
        : Boolean(member?.paused);
  if (!valid) {
    throw new MutationError(
      `Aktuálny stav členstva ${status.queue}/${extension} už nezodpovedá kroku ${action}; zásah bol zastavený.`,
      409,
    );
  }
}

async function assertOldestDispatchAvailabilityCommand(
  client: AdminClient,
  organizationId: string,
  commandId: string,
  queue: DispatchQueueNumber,
  extension: string,
) {
  const result = await client
    .from("motorist_telephony_commands")
    .select("id, request_payload, created_at")
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .in("command_type", [...QUEUE_COMMAND_TYPES])
    .in("status", [...NON_TERMINAL_COMMAND_STATUSES])
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(100);
  if (result.error) throw new DispatchRoutingCommandRejected("Poradie príkazov dostupnosti sa nepodarilo overiť.");
  const matching = (result.data ?? []).filter((candidate) => {
    const candidatePayload = jsonRecord(candidate.request_payload);
    return readString(candidatePayload.queue) === queue &&
      readString(candidatePayload.extension) === extension &&
      Object.keys(jsonRecord(candidatePayload.routingAvailability)).length > 0;
  });
  if (matching[0]?.id !== commandId) {
    throw new DispatchRoutingCommandRejected("Novší alebo duplicitný príkaz dostupnosti bol odmietnutý; spracuje sa iba najstarší.");
  }
  if ((result.data ?? []).length >= 100) {
    throw new DispatchRoutingCommandRejected("Poradie dostupnosti je príliš dlhé na bezpečné automatické spracovanie.");
  }
}

export async function compareAndSetDispatchRoutingState(client: AdminClient, root: RootQueue, state: DispatchRoutingState) {
  assertNoActiveWorkplaceOwnerTransition(root.metadata);
  const metadata = { ...jsonRecord(root.metadata), [ROUTING_METADATA_KEY]: state };
  const result = await client
    .from("motorist_telephony_queues")
    .update({ metadata: toJson(metadata) })
    .eq("id", root.id)
    .eq("updated_at", root.updated_at)
    .select("id, external_id, line_id, metadata, updated_at")
    .maybeSingle();
  throwQueryError(result.error, "Plán priorít sa nepodarilo uložiť.");
  if (!result.data) throw new MutationError("Plán priorít medzitým zmenila iná požiadavka.", 409);
  return result.data;
}

async function enqueueCurrentOperationStep(client: AdminClient, organizationId: string, operation: DispatchRoutingOperation) {
  const step = operation.steps[operation.currentStep];
  if (!step) throw new Error("Aktuálny krok routing operácie chýba.");
  const authorityDigest = await requireAuthorizedRoutingOperation(client, organizationId, operation);
  await requireRoutingOperationProgress(client, organizationId, operation, false);
  const businessPayload = {
    queue: step.queue,
    extension: step.extension,
    action: step.action,
    routingOperation: {
      operationId: operation.operationId,
      authorityDigest,
      revision: operation.targetRevision,
      stepIndex: step.stepIndex,
      fallback: { queue: operation.fallback.queue, extension: operation.fallback.extension },
      ...(operation.initialBootstrap ? { initialBootstrap: true } : {}),
    },
  };
  const authorized = authorizeViptelMutationCommand({
    commandId: step.commandId,
    commandType: step.commandType,
    executionTarget: "listener_rest",
    extensionId: step.extensionId,
    idempotencyKey: step.idempotencyKey,
    organizationId,
    queueId: step.queueId,
    requestPayload: businessPayload,
    requestedBy: operation.actorProfileId,
  });
  const result = await client.from("motorist_telephony_commands").insert({
    id: step.commandId,
    organization_id: organizationId,
    provider: PROVIDER,
    command_type: step.commandType,
    requested_by: operation.actorProfileId,
    queue_id: step.queueId,
    extension_id: step.extensionId,
    request_payload: authorized.requestPayload,
    status: "queued",
    idempotency_key: step.idempotencyKey,
  });
  if (result.error && !/duplicate|unique/i.test(result.error.message)) throw new Error(result.error.message);
}

async function assertNoBlockingQueueCommands(client: AdminClient, organizationId: string, excludeId?: string) {
  const result = await client
    .from("motorist_telephony_commands")
    .select("id, command_type, status, request_payload")
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .in("command_type", [...QUEUE_COMMAND_TYPES])
    .in("status", [...NON_TERMINAL_COMMAND_STATUSES])
    .order("created_at", { ascending: true })
    .limit(500);
  throwQueryError(result.error, "Rozpracované telekomunikačné príkazy sa nepodarilo overiť.");
  const blocking = blockingDispatchQueueCommands(result.data ?? [], excludeId);
  if (blocking.length > 0) throw new MutationError("Najprv treba dokončiť alebo zosúladiť staršie príkazy radov 601–603.", 409);
  if ((result.data ?? []).length >= 500) throw new MutationError("Príliš veľa čakajúcich príkazov; routing ostáva bezpečne zablokovaný.", 409);
}

async function assertNoPendingTelephonyCommands(client: AdminClient, organizationId: string, excludeId?: string) {
  const result = await client
    .from("motorist_telephony_commands")
    .select("id, command_type, status")
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .in("status", [...NON_TERMINAL_COMMAND_STATUSES])
    .order("created_at", { ascending: true })
    .limit(500);
  throwQueryError(result.error, "Rozpracované telekomunikačné príkazy sa nepodarilo overiť.");
  const blocking = (result.data ?? []).filter((command) =>
    command.id !== excludeId && !isReadOnlyTelephonyCommand(command.command_type),
  );
  if (blocking.length > 0) {
    throw new MutationError("Prvotný bootstrap vyžaduje prázdnu frontu telekomunikačných príkazov.", 409);
  }
  if ((result.data ?? []).length >= 500) {
    throw new MutationError("Fronta telekomunikačných príkazov je príliš veľká na bezpečný bootstrap.", 409);
  }
}

async function assertCurrentOperationStepRecoverable(
  client: AdminClient,
  organizationId: string,
  operation: DispatchRoutingOperation,
) {
  const step = operation.steps[operation.currentStep];
  if (!step) throw new MutationError("Aktuálny krok obnovy priorít chýba.", 409);
  const result = await client
    .from("motorist_telephony_commands")
    .select("id, status, command_type, request_payload")
    .eq("id", step.commandId)
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .maybeSingle();
  throwQueryError(result.error, "Aktuálny príkaz obnovy priorít sa nepodarilo overiť.");
  assertDispatchOperationCurrentCommandRecoverable(operation, result.data);
}

export function assertDispatchOperationCurrentCommandRecoverable(
  operation: DispatchRoutingOperation,
  command: RecoveryCommand | null,
) {
  if (!command) return;
  const step = operation.steps[operation.currentStep];
  const tag = jsonRecord(command.request_payload).routingOperation;
  const tagRecord = jsonRecord(tag);
  const matches = Boolean(step) &&
    command.id === step.commandId &&
    command.command_type === step.commandType &&
    readString(tagRecord.operationId) === operation.operationId &&
    readInteger(tagRecord.stepIndex) === operation.currentStep;
  if (!matches) {
    throw new MutationError("Aktuálny príkaz nezodpovedá uloženej routing operácii; obnova ostáva zablokovaná.", 409);
  }
  if (command.status !== "failed" && command.status !== "confirmed_by_event") {
    throw new MutationError("Aktuálny routing príkaz ešte nie je terminálny; obnova ho nesmie predbehnúť.", 409);
  }
}

async function assertNoUnresolvedDelivery(client: AdminClient, organizationId: string, operationId: string) {
  const result = await client
    .from("motorist_telephony_commands")
    .select("id, status, request_payload, provider_response")
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .in("command_type", [...QUEUE_COMMAND_TYPES])
    .eq("status", "failed")
    .limit(500);
  throwQueryError(result.error, "Neisté doručenie príkazov sa nepodarilo overiť.");
  const uncertain = hasUnresolvedDispatchDelivery(result.data ?? [], operationId);
  if (uncertain) throw new MutationError("Najprv zosúlaď neistý krok s aktuálnym stavom VIPTel.", 409);
}

export function blockingDispatchQueueCommands(
  commands: Array<Pick<CommandRow, "id" | "request_payload">>,
  excludeId?: string,
) {
  return commands.filter((command) => {
    if (command.id === excludeId) return false;
    return Boolean(readDispatchQueue(jsonRecord(command.request_payload).queue));
  });
}

export function hasUnresolvedDispatchDelivery(
  commands: Array<Pick<CommandRow, "request_payload" | "provider_response">>,
  operationId: string,
) {
  return commands.some((command) => {
    const tag = jsonRecord(jsonRecord(command.request_payload).routingOperation);
    return readString(tag.operationId) === operationId && jsonRecord(command.provider_response).deliveryUncertain === true;
  });
}

async function reconcileUncertainCurrentStep(
  client: AdminClient,
  organizationId: string,
  operation: DispatchRoutingOperation,
) {
  const step = operation.steps[operation.currentStep];
  if (!step) return false;
  const commandResult = await client
    .from("motorist_telephony_commands")
    .select("id, status, provider_response, request_payload, updated_at")
    .eq("id", step.commandId)
    .eq("organization_id", organizationId)
    .eq("status", "failed")
    .maybeSingle();
  throwQueryError(commandResult.error, "Neistý krok sa nepodarilo načítať.");
  const command = commandResult.data;
  const response = jsonRecord(command?.provider_response);
  if (!command || response.deliveryUncertain !== true) return false;
  const bridged = await requestViptelProviderSnapshot(organizationId, operation.actorProfileId, { maxAgeMs: 2_000 });
  const snapshot = { extensions: bridged.extensions, queueStatuses: bridged.queueStatuses };
  assertCanonicalDispatchProviderSnapshot(snapshot);
  const member = snapshot.queueStatuses
    .find((status) => status.queue === step.queue)
    ?.members.find((candidate) => candidate.extension === step.extension);
  const applied = step.action === "remove"
    ? !member
    : step.action === "pause"
      ? Boolean(member?.paused)
      : step.action === "unpause"
        ? Boolean(member && !member.paused)
        : Boolean(member);
  const updated = await client
    .from("motorist_telephony_commands")
    .update({
      provider_response: toJson({
        ...response,
        deliveryUncertain: false,
        reconciledActual: { applied, queue: step.queue, extension: step.extension },
        reconciledAt: new Date().toISOString(),
      }),
    })
    .eq("id", command.id)
    .eq("updated_at", command.updated_at)
    .select("id")
    .maybeSingle();
  throwQueryError(updated.error, "Výsledok neistého kroku sa nepodarilo zosúladiť.");
  if (!updated.data) throw new MutationError("Neistý krok medzitým zmenila iná požiadavka.", 409);
  return true;
}

async function degradeOperation(client: AdminClient, root: RootQueue, operationId: string, reason: string) {
  const state = parseDispatchRoutingState(root.metadata);
  const operation = state.operation;
  if (!operation || operation.operationId !== operationId) return root;
  return compareAndSetDispatchRoutingState(client, root, {
    ...state,
    operation: {
      ...operation,
      status: "degraded",
      lastError: reason.slice(0, 500),
      updatedAt: new Date().toISOString(),
    },
  });
}

function publicStep(step: DispatchRoutingStep) {
  return {
    stepIndex: step.stepIndex,
    action: step.action,
    queue: step.queue,
    extension: step.extension,
  };
}

async function writeAudit(
  client: AdminClient,
  actor: MotoristActor,
  action: string,
  entityId: string | null,
  afterPayload: unknown,
) {
  return writeOperationAudit(client, actor.organizationId, actor.profileId, action, entityId, afterPayload);
}

async function writeOperationAudit(
  client: AdminClient,
  organizationId: string,
  actorProfileId: string,
  action: string,
  entityId: string | null,
  afterPayload: unknown,
) {
  const result = await client.from("motorist_audit_log").insert({
    organization_id: organizationId,
    actor_profile_id: actorProfileId,
    action,
    entity_type: "motorist_telephony_queues",
    entity_id: entityId,
    source: "web",
    after_payload: toJson(afterPayload),
  });
  throwQueryError(result.error, "Audit zmeny telekomunikačného smerovania sa nepodarilo zapísať.");
}

async function assertNoHistoricalRoutingAuthority(client: AdminClient, organizationId: string) {
  const result = await client
    .from("motorist_audit_log")
    .select("id, action")
    .eq("organization_id", organizationId)
    .eq("entity_type", "motorist_telephony_queues")
    .in("action", [ROUTING_OPERATION_AUTHORIZED_ACTION, ROUTING_PLAN_COMMITTED_ACTION])
    .limit(1);
  if (result.error) {
    throw new MutationError("Históriu prvotného routing bootstrapu sa nepodarilo bezpečne overiť.", 500);
  }
  if ((result.data ?? []).length > 0) {
    throw new MutationError(
      "Prvotný routing bootstrap už bol v tejto organizácii použitý; vyžaduje sa riadené zosúladenie.",
      409,
    );
  }
}

type RoutingProgress = {
  confirmedCount: number;
  currentStepConfirmed: boolean;
};

async function requireRoutingOperationProgress(
  client: AdminClient,
  organizationId: string,
  operation: DispatchRoutingOperation,
  allowCurrentConfirmation: boolean,
): Promise<RoutingProgress> {
  const authorityDigest = dispatchRoutingOperationAuthorityDigest(organizationId, operation);
  const result = await client
    .from("motorist_audit_log")
    .select("id, after_payload")
    .eq("organization_id", organizationId)
    .eq("action", ROUTING_STEP_CONFIRMED_ACTION)
    .eq("entity_type", "motorist_telephony_queues")
    .eq("entity_id", operation.operationId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(100);
  if (result.error) throw new MutationError("Nemenný priebeh routing operácie sa nepodarilo overiť.", 500);
  if ((result.data ?? []).length >= 100) {
    throw new MutationError("Nemenný priebeh routing operácie prekročil bezpečný limit.", 409);
  }

  const confirmed = new Set<number>();
  for (const row of result.data ?? []) {
    const proof = jsonRecord(jsonRecord(row.after_payload).routing_step_confirmation);
    if (proof.authorityDigest !== authorityDigest) continue;
    const parsedStepIndex = readInteger(proof.stepIndex);
    const stepIndex = parsedStepIndex ?? -1;
    const step = operation.steps[stepIndex];
    if (
      proof.schemaVersion !== ROUTING_AUTHORITY_SCHEMA_VERSION ||
      proof.organizationId !== organizationId ||
      proof.operationId !== operation.operationId ||
      !step ||
      proof.commandId !== step.commandId ||
      proof.commandType !== step.commandType ||
      proof.queue !== step.queue ||
      proof.extension !== step.extension ||
      confirmed.has(stepIndex)
    ) {
      throw new MutationError("Nemenný priebeh routing operácie obsahuje neplatné potvrdenie kroku.", 409);
    }
    confirmed.add(stepIndex);
  }

  for (let index = 0; index < confirmed.size; index += 1) {
    if (!confirmed.has(index)) {
      throw new MutationError("Nemenné potvrdenia routing krokov netvoria súvislé poradie.", 409);
    }
  }
  const expectedStateConfirmed = operation.releasePending ? operation.steps.length : operation.currentStep;
  for (const step of operation.steps) {
    const expectedStatus = step.stepIndex < expectedStateConfirmed ? "confirmed" : "pending";
    if (step.status !== expectedStatus) {
      throw new MutationError("Stav routing krokov nezodpovedá nemennému priebehu operácie.", 409);
    }
  }
  if (operation.releasePending) {
    if (confirmed.size !== operation.steps.length) {
      throw new MutationError("Uvoľnenie routing operácie nemá potvrdené všetky provider kroky.", 409);
    }
    return { confirmedCount: confirmed.size, currentStepConfirmed: true };
  }

  const minimum = operation.currentStep;
  const maximum = allowCurrentConfirmation ? operation.currentStep + 1 : operation.currentStep;
  if (confirmed.size < minimum || confirmed.size > maximum) {
    throw new MutationError("Uložený krok routing operácie nezodpovedá nemenným provider potvrdeniam.", 409);
  }
  return {
    confirmedCount: confirmed.size,
    currentStepConfirmed: confirmed.has(operation.currentStep),
  };
}

async function writeRoutingStepConfirmation(
  client: AdminClient,
  organizationId: string,
  operation: DispatchRoutingOperation,
  authorityDigest: string,
) {
  const step = operation.steps[operation.currentStep];
  if (!step) throw new MutationError("Potvrdzovaný routing krok chýba.", 409);
  const proof = {
    schemaVersion: ROUTING_AUTHORITY_SCHEMA_VERSION,
    authorityDigest,
    organizationId,
    operationId: operation.operationId,
    stepIndex: step.stepIndex,
    commandId: step.commandId,
    commandType: step.commandType,
    queue: step.queue,
    extension: step.extension,
  };
  const result = await client.from("motorist_audit_log").insert({
    id: deterministicRoutingAuditId("step-confirmed", authorityDigest, String(step.stepIndex)),
    organization_id: organizationId,
    actor_profile_id: operation.actorProfileId,
    action: ROUTING_STEP_CONFIRMED_ACTION,
    entity_type: "motorist_telephony_queues",
    entity_id: operation.operationId,
    source: "viptel_listener",
    after_payload: toJson({ routing_step_confirmation: proof }),
  }).select("id").single();
  if (result.error) {
    if (/duplicate|unique|23505/i.test(`${result.error.message} ${"code" in result.error ? result.error.code : ""}`)) {
      const progress = await requireRoutingOperationProgress(client, organizationId, operation, true);
      if (progress.currentStepConfirmed) return;
    }
    throw new MutationError("Nemenné potvrdenie routing kroku sa nepodarilo zapísať.", 500);
  }
  if (!result.data) throw new MutationError("Nemenné potvrdenie routing kroku sa po zápise nenašlo.", 500);
}

function deterministicRoutingAuditId(...parts: string[]) {
  const hex = createHash("sha256")
    .update("motorist.telephony.routing-audit.v1")
    .update("\u0000")
    .update(parts.join("\u0000"))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function authorizeRoutingOperation(
  client: AdminClient,
  organizationId: string,
  operation: DispatchRoutingOperation,
) {
  const intent = routingOperationIntent(organizationId, operation);
  const digest = dispatchRoutingOperationAuthorityDigest(organizationId, operation);
  const result = await client.from("motorist_audit_log").insert({
    organization_id: organizationId,
    actor_profile_id: operation.actorProfileId,
    action: ROUTING_OPERATION_AUTHORIZED_ACTION,
    entity_type: "motorist_telephony_queues",
    entity_id: operation.operationId,
    source: "web",
    after_payload: toJson({
      routing_operation_authority: {
        schemaVersion: ROUTING_AUTHORITY_SCHEMA_VERSION,
        digest,
        intent,
      },
    }),
  }).select("id").single();
  throwQueryError(result.error, "Nemennú autorizáciu routing operácie sa nepodarilo zapísať.");
  if (!result.data) throw new MutationError("Nemenná autorizácia routing operácie sa po zápise nenašla.", 500);
  return digest;
}

async function requireAuthorizedRoutingOperation(
  client: AdminClient,
  organizationId: string,
  operation: DispatchRoutingOperation,
) {
  const result = await client
    .from("motorist_audit_log")
    .select("id, action, entity_id, after_payload, created_at")
    .eq("organization_id", organizationId)
    .eq("entity_type", "motorist_telephony_queues")
    .in("action", [ROUTING_OPERATION_AUTHORIZED_ACTION, ROUTING_PLAN_COMMITTED_ACTION])
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(2);
  if (result.error) throw new MutationError("Nemennú autorizáciu routing operácie sa nepodarilo overiť.", 500);
  const rows = result.data ?? [];
  if (rows.length > 1 && rows[0]?.created_at === rows[1]?.created_at) {
    throw new MutationError("Nemenná autorizácia routing operácie má nejednoznačné poradie.", 409);
  }
  const head = rows[0];
  const stored = jsonRecord(jsonRecord(head?.after_payload).routing_operation_authority);
  const intent = routingOperationIntent(organizationId, operation);
  const digest = dispatchRoutingOperationAuthorityDigest(organizationId, operation);
  if (
    !head ||
    head.action !== ROUTING_OPERATION_AUTHORIZED_ACTION ||
    head.entity_id !== operation.operationId ||
    stored.schemaVersion !== ROUTING_AUTHORITY_SCHEMA_VERSION ||
    stored.digest !== digest ||
    canonicalJson(stored.intent) !== canonicalJson(intent)
  ) {
    throw new MutationError("Routing operácia nezodpovedá nemennej serverovej autorizácii.", 409);
  }
  return digest;
}

async function writeCommittedRoutingPlan(
  client: AdminClient,
  organizationId: string,
  actorProfileId: string,
  root: Pick<RootQueue, "id">,
  state: Pick<DispatchRoutingState, "currentPlan" | "revision">,
  operationId: string,
) {
  const proof = {
    schemaVersion: ROUTING_AUTHORITY_SCHEMA_VERSION,
    organizationId,
    rootId: root.id,
    operationId,
    revision: state.revision,
    currentPlan: canonicalPlan(state.currentPlan),
    digest: dispatchRoutingCommittedPlanDigest(organizationId, root.id, state),
  };
  const result = await client.from("motorist_audit_log").insert({
    organization_id: organizationId,
    actor_profile_id: actorProfileId,
    action: ROUTING_PLAN_COMMITTED_ACTION,
    entity_type: "motorist_telephony_queues",
    entity_id: root.id,
    source: "viptel_listener",
    after_payload: toJson({ routing_plan_commit: proof }),
  }).select("id").single();
  throwQueryError(result.error, "Nemenný potvrdený routing plán sa nepodarilo zapísať.");
  if (!result.data) throw new MutationError("Nemenný potvrdený routing plán sa po zápise nenašiel.", 500);
}

async function requireCommittedRoutingPlan(
  client: AdminClient,
  organizationId: string,
  root: Pick<RootQueue, "id">,
  state: Pick<DispatchRoutingState, "currentPlan" | "revision">,
) {
  const result = await client
    .from("motorist_audit_log")
    .select("id, action, entity_id, after_payload, created_at")
    .eq("organization_id", organizationId)
    .eq("entity_type", "motorist_telephony_queues")
    .in("action", [ROUTING_OPERATION_AUTHORIZED_ACTION, ROUTING_PLAN_COMMITTED_ACTION])
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(2);
  if (result.error) throw new MutationError("Nemenný potvrdený routing plán sa nepodarilo overiť.", 500);
  const rows = result.data ?? [];
  if (rows.length > 1 && rows[0]?.created_at === rows[1]?.created_at) {
    throw new MutationError("Nemenný potvrdený routing plán má nejednoznačné poradie.", 409);
  }
  const head = rows[0];
  const stored = jsonRecord(jsonRecord(head?.after_payload).routing_plan_commit);
  const expectedPlan = canonicalPlan(state.currentPlan);
  const expectedDigest = dispatchRoutingCommittedPlanDigest(organizationId, root.id, state);
  if (
    !head ||
    head.action !== ROUTING_PLAN_COMMITTED_ACTION ||
    head.entity_id !== root.id ||
    stored.schemaVersion !== ROUTING_AUTHORITY_SCHEMA_VERSION ||
    stored.organizationId !== organizationId ||
    stored.rootId !== root.id ||
    stored.revision !== state.revision ||
    stored.digest !== expectedDigest ||
    JSON.stringify(stored.currentPlan) !== JSON.stringify(expectedPlan)
  ) {
    throw new MutationError("Aktuálny routing plán nezodpovedá nemennému potvrdenému auditu.", 409);
  }
  return expectedDigest;
}

function routingOperationIntent(organizationId: string, operation: DispatchRoutingOperation) {
  return {
    schemaVersion: ROUTING_AUTHORITY_SCHEMA_VERSION,
    organizationId,
    operationId: operation.operationId,
    actorProfileId: operation.actorProfileId,
    baseRevision: operation.baseRevision,
    targetRevision: operation.targetRevision,
    previousPlan: canonicalPlan(operation.previousPlan),
    targetPlan: canonicalPlan(operation.targetPlan),
    steps: operation.steps.map((step) => ({
      stepIndex: step.stepIndex,
      commandId: step.commandId,
      idempotencyKey: step.idempotencyKey,
      commandType: step.commandType,
      action: step.action,
      queue: step.queue,
      queueId: step.queueId,
      extension: step.extension,
      extensionId: step.extensionId,
    })),
    fallback: {
      queue: operation.fallback.queue,
      queueId: operation.fallback.queueId,
      extension: operation.fallback.extension,
      extensionId: operation.fallback.extensionId,
    },
    affectedExtensions: [...operation.affectedExtensions].sort(),
    assignmentGuards: [...operation.assignmentGuards]
      .sort((left, right) => left.extensionId.localeCompare(right.extensionId))
      .map((guard) => ({
        claimId: guard.claimId,
        extension: guard.extension,
        extensionId: guard.extensionId,
        generation: guard.generation,
        lifecycleEpoch: guard.lifecycleEpoch,
        profileId: guard.profileId,
        routingOperationId: guard.routingOperationId,
      })),
    ...(operation.rootMetadataGuard ? {
      rootMetadataGuard: {
        key: operation.rootMetadataGuard.key,
        digest: operation.rootMetadataGuard.digest,
        authorityId: operation.rootMetadataGuard.authorityId,
      },
    } : {}),
    createdAt: operation.createdAt,
    initialBootstrap: Boolean(operation.initialBootstrap),
  };
}

function canonicalPlan(plan: DispatchPriorityPlan): DispatchPriorityPlan {
  return { "601": plan["601"], "602": plan["602"], "603": plan["603"] };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  throw new MutationError("Chránené metadata priorít nie sú platný JSON.", 409);
}

function readDispatchQueue(value: unknown): DispatchQueueNumber | undefined {
  const text = readString(value);
  return text && isDispatchQueue(text) ? text : undefined;
}

function isDispatchQueue(value: string): value is DispatchQueueNumber {
  return (DISPATCH_QUEUE_NUMBERS as readonly string[]).includes(value);
}

function readQueueAction(value: unknown): ViptelQueueAgentAction | undefined {
  const text = readString(value);
  return text && ["add", "remove", "pause", "unpause"].includes(text) ? text as ViptelQueueAgentAction : undefined;
}

function readNumeric(value: unknown) {
  const text = readString(value);
  return text && /^\d{1,8}$/.test(text) ? text : undefined;
}

function readString(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function readInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}

function safeError(error: unknown) {
  return error instanceof Error ? error.message : "Neznáma chyba telekomunikačného smerovania.";
}

function throwQueryError(error: { message: string } | null, message: string): asserts error is null {
  if (error) throw new Error(`${message} ${error.message}`);
}
