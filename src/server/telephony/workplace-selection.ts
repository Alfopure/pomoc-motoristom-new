import "server-only";

import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import {
  requireActiveWorkplaceLease,
  resolveOwnedTelephonyExtension,
  type WorkplaceLeaseFence,
} from "@/server/telephony-access";
import {
  claimSelfServiceTelephonyExtension,
  refreshTelephonyPresence,
  releaseSelfServiceTelephonyExtension,
} from "@/server/telephony-extensions";
import {
  assertWorkplacePriorityDraftWriteUnlocked,
  releaseOccupiedWorkplace,
  takeOverOccupiedWorkplace,
} from "@/server/telephony/workplace-admin-actions";
import {
  DISPATCH_QUEUE_NUMBERS,
  dispatchRoutingRootMetadataDigest,
  parseDispatchRoutingState,
  previewOrStartDispatchRoutingPlan,
  previewOrStartEmptyDispatchRoutingPlan,
  previewOrStartPartialDispatchRoutingPlan,
  recoverDispatchRoutingOperation,
  type DispatchPriorityPlan,
  type DispatchQueueNumber,
  type DispatchRoutingOperation,
  type DispatchRoutingState,
} from "@/server/telephony/dispatch-routing";
import {
  assertTelephonyLiveMutationEnabled,
  workplaceAdminTakeoverGateStatus,
} from "@/server/telephony/live-mutation-gate";
import { configuredPersonalExtensions } from "@/server/telephony/personal-extension-config";
import {
  authorizeWorkplacePriorityDraft,
  parseWorkplacePriorityDraft,
  requireLatestWorkplacePriorityDraftAuthority,
  workplaceDraftAuthorityId,
  type WorkplaceDraftAuthority,
} from "@/server/telephony/workplace-draft-authority";
import { readAssignmentLifecycle } from "@/server/telephony/assignment-lifecycle";
import { hasActiveAssignmentTransitionMetadata } from "@/server/telephony/assignment-interlock";
import {
  readWorkplaceLease,
  toWorkplaceLeaseClientRef,
  workplaceLeaseFreshness,
  workplaceSeatOwnershipVersion,
  type WorkplaceLease,
} from "@/server/telephony/workplace-lease";
import {
  canProfileUseWorkplaceHotdesk,
  workplaceHotdeskCapability,
} from "@/server/telephony/workplace-capability";
import {
  cancelDynamicWorkplaceChange,
  confirmDynamicWorkplaceChange,
  leaveDynamicWorkplaceSeat,
  recoverExpiredWorkplaceOperations,
  selectDynamicWorkplaceSeat,
} from "@/server/telephony/workplace-handoff";
import { createWorkplaceOperationRepository } from "@/server/telephony/workplace-operation-repository";
import { findBootstrappedWorkplaceExtensionIds } from "@/server/telephony/workplace-runtime-state";
import { assertWorkplaceTakeoverReservation } from "@/server/telephony/workplace-takeover-service";

type AdminClient = SupabaseClient<Database>;
type ExtensionRow = Pick<
  Database["public"]["Tables"]["motorist_telephony_extensions"]["Row"],
  "extension" | "id" | "is_registered" | "metadata" | "profile_id"
> & { workplace_seat_generation?: string | null };
type RootQueue = Pick<
  Database["public"]["Tables"]["motorist_telephony_queues"]["Row"],
  "external_id" | "id" | "metadata" | "updated_at"
>;
type RoutingCommandRow = Pick<
  Database["public"]["Tables"]["motorist_telephony_commands"]["Row"],
  "command_type" | "id" | "provider_response" | "request_payload" | "status"
>;

const PROVIDER = "viptel";
const DRAFT_KEY = "workplacePriorityDraft";
const DRAFT_SCHEMA_VERSION = 1;

export type WorkplaceSeatStatus =
  | "free" | "mine" | "stale" | "active" | "transitioning" | "unknown"
  | "available" | "occupied" | "unavailable";
export type WorkplacePriorityStatus = "mine" | "available" | "occupied" | "pending_mine" | "pending_occupied" | "locked";
export type WorkplacePrioritySelectionEffect = "claim" | "swap" | "replace" | "mine";
export type WorkplaceRoutingStatusState = "collecting" | "ready" | "activating" | "active" | "blocked";

export type WorkplacePriorityDraft = {
  schemaVersion: 1;
  baseRevision: number;
  selections: DispatchPriorityPlan;
  selectedBy: Record<DispatchQueueNumber, string | null>;
  updatedAt: string;
  authority?: WorkplaceDraftAuthority;
};

export type WorkplaceSelectionSnapshot = {
  checkedAt: string;
  selection: {
    seatId?: string | null;
    extension: string | null;
    queue: DispatchQueueNumber | null;
  };
  lease?: WorkplaceLeaseResponse;
  seats: Array<{
    seatId?: string;
    extension: string;
    status: WorkplaceSeatStatus;
    canSelect?: boolean;
    reasonCode?: string;
    reason?: string;
    owner?: { profileId: string; profileName?: string };
    heartbeatFresh?: boolean;
    priority?: DispatchQueueNumber | null;
    outboundOnly?: boolean;
    version?: string;
    profileId?: string;
    profileName?: string;
    registered?: boolean;
    management?: {
      takeover: "allowed" | "blocked";
      release: "allowed" | "blocked";
      reason?: string;
      refreshable?: boolean;
    };
  }>;
  priorities: Array<{
    queue: DispatchQueueNumber;
    order: 1 | 2 | 3;
    activeExtension: string | null;
    selectedExtension: string | null;
    status: WorkplacePriorityStatus;
    selectionEffect: WorkplacePrioritySelectionEffect;
    profileId?: string;
    profileName?: string;
    willDisplace?: {
      extension: string;
      profileId?: string;
      profileName?: string;
    };
  }>;
  routingStatus: {
    state: WorkplaceRoutingStatusState;
    selectedCount: number;
    capacityCount: 3;
    operationId?: string;
    canRecover?: boolean;
    message: string;
  };
};

export type WorkplaceMutationAction =
  | {
      action: "select_seat";
      extension: unknown;
      browserInstanceId: string;
      idempotencyKey: string;
      expectedVersion?: string;
    }
  | {
      action: "leave_seat";
      browserInstanceId: string;
      idempotencyKey: string;
      expectedVersion?: string;
    }
  | {
      action: "confirm_seat_change";
      browserInstanceId: string;
      idempotencyKey: string;
      operationId: string;
    }
  | {
      action: "cancel_seat_change";
      browserInstanceId: string;
      idempotencyKey: string;
      operationId: string;
    }
  | { action: "claim_seat"; extension: unknown }
  | { action: "release_seat" }
  | { action: "takeover_seat"; extension: unknown }
  | { action: "release_occupied_seat"; extension: unknown }
  | { action: "claim_priority"; queue: unknown; leaseFence?: WorkplaceLeaseFence }
  | { action: "recover_priority"; operationId: string; leaseFence: WorkplaceLeaseFence }
  | { action: "release_priority"; leaseFence?: WorkplaceLeaseFence };

export type WorkplaceMutationResult = {
  state: "confirmed" | "disconnect_required" | "draft" | "pending";
  noOp?: true;
  message: string;
  operationId?: string;
  lease?: WorkplaceLeaseResponse;
  resumeSecret?: string;
};

export type WorkplaceHotdeskMutationResponse = {
  result: WorkplaceMutationResult;
  lease?: WorkplaceLeaseResponse;
  resumeSecret?: string;
};

export type WorkplaceLeaseResponse = {
  leaseId: string;
  seatId: string;
  extension: string;
  assignmentGeneration: string;
  leaderEpoch: number;
  leaseVersion: number;
  expiresAt: string;
  heartbeatIntervalMs: number;
};

export type WorkplaceDependencies = {
  client?: AdminClient;
  now?: () => string;
  claimSeat?: typeof claimSelfServiceTelephonyExtension;
  releaseSeat?: typeof releaseSelfServiceTelephonyExtension;
  takeoverSeat?: typeof takeOverOccupiedWorkplace;
  releaseOccupiedSeat?: typeof releaseOccupiedWorkplace;
  previewApply?: typeof previewOrStartDispatchRoutingPlan;
  previewBootstrap?: typeof previewOrStartEmptyDispatchRoutingPlan;
  previewPartialApply?: typeof previewOrStartPartialDispatchRoutingPlan;
  recoverPriority?: typeof recoverDispatchRoutingOperation;
  verifyPriorityLease?: (
    actor: MotoristActor,
    fence: WorkplaceLeaseFence,
  ) => Promise<{ id: string; extension: string }>;
  resolveOwnedExtension?: typeof resolveOwnedTelephonyExtension;
  loadSelectionState?: typeof loadWorkplaceSelectionState;
  loadRoutingCommand?: typeof loadCurrentWorkplaceRoutingCommand;
  refreshPresence?: typeof refreshTelephonyPresence;
  refreshSelection?: typeof getWorkplaceSelection;
  assertTakeoverReservation?: typeof assertWorkplaceTakeoverReservation;
  selectDynamicSeat?: (
    actor: MotoristActor,
    input: Extract<WorkplaceMutationAction, { action: "select_seat" }>,
  ) => Promise<WorkplaceHotdeskMutationResponse>;
  leaveDynamicSeat?: (
    actor: MotoristActor,
    input: Extract<WorkplaceMutationAction, { action: "leave_seat" }>,
  ) => Promise<WorkplaceHotdeskMutationResponse>;
  confirmDynamicSeatChange?: (
    actor: MotoristActor,
    input: Extract<WorkplaceMutationAction, { action: "confirm_seat_change" }>,
  ) => Promise<WorkplaceHotdeskMutationResponse>;
  cancelDynamicSeatChange?: (
    actor: MotoristActor,
    input: Extract<WorkplaceMutationAction, { action: "cancel_seat_change" }>,
  ) => Promise<WorkplaceHotdeskMutationResponse>;
};

export async function getWorkplaceSelection(
  actor: MotoristActor,
  dependencies: Pick<WorkplaceDependencies, "client" | "now"> = {},
): Promise<WorkplaceSelectionSnapshot> {
  const client = dependencies.client ?? createSupabaseAdminClient();
  await recoverExpiredWorkplaceOperations(
    { organizationId: actor.organizationId, recoveryOwner: `request:${actor.profileId}` },
    { client },
  );
  const state = await loadWorkplaceSelectionState(client, actor);
  state.currentRoutingCommand = await loadCurrentWorkplaceRoutingCommand(client, actor, state.routing.operation);
  return buildWorkplaceSelectionSnapshot(
    actor,
    state,
    state.databaseNow ?? (dependencies.now ?? (() => new Date().toISOString()))(),
  );
}

export async function mutateWorkplaceSelection(
  actor: MotoristActor,
  input: WorkplaceMutationAction,
  dependencies: WorkplaceDependencies = {},
): Promise<{
  result: WorkplaceMutationResult;
  workplace?: WorkplaceSelectionSnapshot;
  warning?: string;
  lease?: WorkplaceLeaseResponse;
  resumeSecret?: string;
}> {
  assertTelephonyLiveMutationEnabled(`workplace.${input.action}`);
  const client = dependencies.client ?? createSupabaseAdminClient();
  let result: WorkplaceMutationResult;
  let hotdeskResult: WorkplaceHotdeskMutationResponse | undefined;

  if (input.action === "select_seat") {
    await (dependencies.assertTakeoverReservation ?? assertWorkplaceTakeoverReservation)(
      actor,
      input.extension,
      { client },
    );
    hotdeskResult = await (dependencies.selectDynamicSeat ?? selectDynamicWorkplaceSeat)(actor, input);
    result = hotdeskResult.result;
  } else if (input.action === "leave_seat") {
    assertHotdeskRuntimeAllowed();
    hotdeskResult = await (dependencies.leaveDynamicSeat ?? leaveDynamicWorkplaceSeat)(actor, input);
    result = hotdeskResult.result;
  } else if (input.action === "confirm_seat_change") {
    assertHotdeskRuntimeAllowed();
    hotdeskResult = await (dependencies.confirmDynamicSeatChange ?? confirmDynamicWorkplaceChange)(actor, input);
    result = hotdeskResult.result;
  } else if (input.action === "cancel_seat_change") {
    assertHotdeskRuntimeAllowed();
    hotdeskResult = await (dependencies.cancelDynamicSeatChange ?? cancelDynamicWorkplaceChange)(actor, input);
    result = hotdeskResult.result;
  } else if (input.action === "claim_seat") {
    await assertLegacyWorkplaceOwnershipAllowed(client, actor.organizationId);
    const claimed = await (dependencies.claimSeat ?? claimSelfServiceTelephonyExtension)(actor, input.extension);
    result = {
      state: "confirmed",
      ...(claimed.noOp ? { noOp: true as const } : {}),
      message: claimed.noOp
        ? `Pracovné miesto ${claimed.extension} už používaš.`
        : `Pracovné miesto ${claimed.extension} je priradené.`,
    };
  } else if (input.action === "release_seat") {
    await assertLegacyWorkplaceOwnershipAllowed(client, actor.organizationId);
    await assertActorHasNoPriorityDraft(client, actor);
    const released = await (dependencies.releaseSeat ?? releaseSelfServiceTelephonyExtension)(actor);
    result = {
      state: "confirmed",
      ...(released.noOp ? { noOp: true as const } : {}),
      message: released.noOp ? "Nemáš pridelené pracovné miesto." : "Pracovné miesto je uvoľnené.",
    };
  } else if (input.action === "takeover_seat") {
    await assertLegacyWorkplaceOwnershipAllowed(client, actor.organizationId);
    const taken = await (dependencies.takeoverSeat ?? takeOverOccupiedWorkplace)(
      actor,
      input.extension,
      { client, now: dependencies.now },
    );
    result = {
      state: "confirmed",
      ...(taken.noOp ? { noOp: true as const } : {}),
      message: taken.preservedQueue
        ? taken.noOp
          ? `Pracovné miesto ${taken.extension} už používaš v priorite ${priorityOrder(taken.preservedQueue)}.`
          : `Pracovné miesto ${taken.extension} je prevzaté a zostáva v priorite ${priorityOrder(taken.preservedQueue)}.`
        : taken.noOp
          ? `Pracovné miesto ${taken.extension} už používaš.`
          : `Pracovné miesto ${taken.extension} je prevzaté.`,
    };
  } else if (input.action === "release_occupied_seat") {
    await assertLegacyWorkplaceOwnershipAllowed(client, actor.organizationId);
    const released = await (dependencies.releaseOccupiedSeat ?? releaseOccupiedWorkplace)(
      actor,
      input.extension,
      { client, now: dependencies.now },
    );
    result = {
      state: "confirmed",
      message: `Pracovné miesto ${released.extension} je uvoľnené.`,
    };
  } else if (input.action === "claim_priority") {
    await assertPriorityLease(actor, input.leaseFence, dependencies);
    result = await claimWorkplacePriority(actor, readQueue(input.queue), { ...dependencies, client });
  } else if (input.action === "recover_priority") {
    result = await recoverWorkplacePriority(actor, input, { ...dependencies, client });
  } else {
    await assertPriorityLease(actor, input.leaseFence, dependencies);
    result = await releaseWorkplacePriority(actor, { ...dependencies, client });
  }

  let warning: string | undefined;
  if (input.action === "confirm_seat_change" && result.state === "confirmed") {
    try {
      // Confirmation has already committed the ownership change. Persist a
      // fresh provider view before constructing the canonical workplace
      // snapshot so a released, unregistered seat cannot remain "unknown"
      // until a browser happens to request a later provider refresh.
      await (dependencies.refreshPresence ?? refreshTelephonyPresence)(actor);
    } catch {
      // This is post-commit convergence, never a reason to discard or roll
      // back the authoritative operation result. The exact confirm may be
      // replayed safely, while the UI can truthfully show the recovery notice.
      warning = "Zmena pracovného miesta je potvrdená, ale stav registrácie VIPTel sa nepodarilo uložiť. Obnov stav; potvrdenú zmenu neopakuj.";
    }
  }

  let workplace: WorkplaceSelectionSnapshot | undefined;
  try {
    workplace = await (dependencies.refreshSelection ?? getWorkplaceSelection)(actor, {
      client,
      now: dependencies.now,
    });
  } catch (error) {
    if (!hotdeskResult) throw error;
    // Ownership/lease mutation is already authoritative. Never discard its
    // operation id, lease or one-time resume secret because an unrelated
    // routing draft makes the convenience snapshot temporarily unreadable.
    const snapshotWarning = "Pracovné miesto bolo uložené, ale aktuálny prehľad sa nepodarilo obnoviť. Obnov stránku; telefónna relácia zostáva platná.";
    warning = warning ? `${warning} ${snapshotWarning}` : snapshotWarning;
  }
  return {
    result,
    ...(workplace ? { workplace } : {}),
    ...(warning ? { warning } : {}),
    ...(hotdeskResult?.lease ? { lease: hotdeskResult.lease } : {}),
    ...(hotdeskResult?.resumeSecret ? { resumeSecret: hotdeskResult.resumeSecret } : {}),
  };
}

async function assertPriorityLease(
  actor: MotoristActor,
  fence: WorkplaceLeaseFence | undefined,
  dependencies: WorkplaceDependencies,
) {
  const owned = await (dependencies.resolveOwnedExtension ?? resolveOwnedTelephonyExtension)(actor);
  await requireActiveWorkplaceLease(actor, owned, fence, {
    client: dependencies.client,
    requireFence: true,
  });
  return owned;
}

async function recoverWorkplacePriority(
  actor: MotoristActor,
  input: Extract<WorkplaceMutationAction, { action: "recover_priority" }>,
  dependencies: WorkplaceDependencies & { client: AdminClient },
): Promise<WorkplaceMutationResult> {
  const owned = dependencies.verifyPriorityLease
    ? await dependencies.verifyPriorityLease(actor, input.leaseFence)
    : await assertPriorityLease(actor, input.leaseFence, dependencies);
  const state = await (dependencies.loadSelectionState ?? loadWorkplaceSelectionState)(dependencies.client, actor);
  const operation = state.routing.operation;
  if (!operation || operation.operationId !== input.operationId) {
    throw new MutationError(
      "Táto zmena poradia už nie je aktuálna. Obnov pracovisko.",
      409,
      "priority_recovery_operation_changed",
    );
  }
  state.currentRoutingCommand = await (dependencies.loadRoutingCommand ?? loadCurrentWorkplaceRoutingCommand)(
    dependencies.client,
    actor,
    operation,
  );
  const recovery = evaluateWorkplacePriorityRecovery(
    actor,
    state,
    owned.id,
    owned.extension,
    state.databaseNow ?? (dependencies.now ?? (() => new Date().toISOString()))(),
  );
  if (!recovery.owned) {
    throw new MutationError(
      "Obnoviť môžeš iba zmenu poradia svojho aktuálneho pracovného miesta.",
      403,
      "priority_recovery_not_owned",
    );
  }
  if (recovery.inProgress) {
    return {
      state: "pending",
      noOp: true,
      operationId: operation.operationId,
      message: "Obnova poradia už prebieha. Čakám na potvrdenie VIPTel.",
    };
  }
  if (recovery.deliveryUncertain) {
    throw new MutationError(
      "Výsledok príkazu vo VIPTel nie je jednoznačný. Túto zmenu musí najprv zosúladiť správca.",
      409,
      "priority_recovery_reconcile_required",
    );
  }
  if (!recovery.canRecover) {
    throw new MutationError(
      "Túto zmenu poradia zatiaľ nemožno bezpečne obnoviť. Obnov pracovisko.",
      409,
      "priority_recovery_not_ready",
    );
  }
  const overview = await (dependencies.recoverPriority ?? recoverDispatchRoutingOperation)(actor, "resume");
  const pending = Boolean(overview.operation);
  return {
    state: pending ? "pending" : "confirmed",
    operationId: operation.operationId,
    message: pending
      ? "Obnova poradia bola spustená. Čakám na potvrdenie VIPTel."
      : "Poradie zvonenia je obnovené a potvrdené.",
  };
}

function assertHotdeskRuntimeAllowed() {
  const capability = workplaceHotdeskCapability();
  if (!capability.runtimeEnabled) {
    throw new MutationError(
      "Správa aktívnych pracovísk nie je v tomto prostredí bezpečne povolená.",
      503,
      "hotdesk_disabled",
    );
  }
}

async function assertLegacyWorkplaceOwnershipAllowed(client: AdminClient, organizationId: string) {
  const capability = workplaceHotdeskCapability();
  if (!capability.runtimeEnabled) {
    const seats = await client
      .from("motorist_telephony_extensions")
      .select("id, metadata")
      .eq("organization_id", organizationId)
      .eq("provider", PROVIDER)
      .eq("active", true)
      .in("extension", configuredPersonalExtensions());
    if (seats.error) throw new MutationError("Režim pracovísk sa nepodarilo bezpečne overiť.", 500);
    const markerCandidates = (seats.data ?? []).flatMap((seat) =>
      readAssignmentLifecycle(jsonRecord(seat.metadata).assignmentLifecycle)?.assignmentMode === "workplace_claim"
        ? [seat.id]
        : []);
    if (markerCandidates.length === 0) return;
    const bootstrapped = await findBootstrappedWorkplaceExtensionIds(client, organizationId, {
      extensionIds: markerCandidates,
    });
    if (bootstrapped.size === 0) return;
  }
  throw new MutationError(
    "Starý spôsob priraďovania pracoviska je po zapnutí dynamických miest zablokovaný. Obnov stránku.",
    409,
    "hotdesk_legacy_action_blocked",
  );
}

async function claimWorkplacePriority(
  actor: MotoristActor,
  queue: DispatchQueueNumber,
  dependencies: WorkplaceDependencies & { client: AdminClient },
): Promise<WorkplaceMutationResult> {
  const owned = await (dependencies.resolveOwnedExtension ?? resolveOwnedTelephonyExtension)(actor);
  const state = await loadWorkplaceSelectionState(dependencies.client, actor);
  assertRoutingIdle(state.routing);
  let currentDraft = mutableWorkplacePriorityDraft(
    state,
    (dependencies.now ?? (() => new Date().toISOString()))(),
  );
  const actorQueueBeforeCompaction = queueForSelection(currentDraft.selections, owned.extension);
  if (workplaceHotdeskCapability().runtimeEnabled) {
    currentDraft = compactCanonicalFreeWorkplacePriorities(state, currentDraft);
  }
  const compactedActorQueue = queueForSelection(currentDraft.selections, owned.extension);
  const effectiveQueue = actorQueueBeforeCompaction === queue && compactedActorQueue
    ? compactedActorQueue
    : queue;
  queue = effectiveQueue;
  assertDynamicPriorityDisplacementAllowed(state, currentDraft, effectiveQueue, owned.extension);
  const { draft, displacedExtension } = applyWorkplacePriorityClaim(currentDraft, {
    actorExtension: owned.extension,
    actorProfileId: actor.profileId,
    ownerByExtension: state.ownerByExtension,
    queue: effectiveQueue,
    updatedAt: (dependencies.now ?? (() => new Date().toISOString()))(),
  });
  assertDraftOwnership(draft, state);
  assertPriorityPrefix(draft.selections);
  assertSelfServiceFallbackBeforePersist(state, state.routing.currentPlan, draft.selections);

  const unchanged = samePlan(draft.selections, state.routing.currentPlan);
  const persistedDraft = !sameDraft(draft, state.draft)
    ? await saveWorkplacePriorityDraft(dependencies.client, actor, state.root, draft)
    : draft;
  if (unchanged) {
    return { state: "confirmed", noOp: true, message: `Priorita ${priorityOrder(queue)} je už aktívna.` };
  }
  const partial = !completePlan(draft.selections);
  await startDraftRoutingOperation(actor, state.routing, persistedDraft, dependencies, partial);
  return {
    state: "pending",
    message: displacedExtension && displacedExtension !== owned.extension
      ? `Zmena priority ${priorityOrder(queue)} sa odoslala do VIPTel; pôvodný operátor sa presunie podľa nového plánu.`
      : partial
        ? `Priorita ${priorityOrder(queue)} sa aktivuje vo VIPTel. Ďalší operátori sa môžu pridať neskôr.`
        : `Zmena priority ${priorityOrder(queue)} sa odoslala do VIPTel. Čakám na potvrdenie poskytovateľa.`,
  };
}

/**
 * Self-service may choose an empty slot or the actor's current slot. A foreign
 * seat is never silently displaced—even when stale; the actor must first take
 * over that seat so ownership and priority remain one coherent operation.
 * Manager reordering remains available through the separate management flow.
 */
export function assertDynamicPriorityDisplacementAllowed(
  state: LoadedWorkplaceState,
  draft: WorkplacePriorityDraft,
  queue: DispatchQueueNumber,
  actorExtension: string,
) {
  if (!workplaceHotdeskCapability().runtimeEnabled) return;
  const displacedNumber = draft.selections[queue];
  if (!displacedNumber || displacedNumber === actorExtension) return;
  if (isCanonicalFreeSeat(state, displacedNumber)) return;
  throw new MutationError(
    `Priorita ${priorityOrder(queue)} už patrí inému pracovnému miestu. Najprv prevezmi dané miesto alebo použi správu poradia.`,
    409,
    "priority_slot_active",
  );
}

async function releaseWorkplacePriority(
  actor: MotoristActor,
  dependencies: WorkplaceDependencies & { client: AdminClient },
): Promise<WorkplaceMutationResult> {
  const owned = await (dependencies.resolveOwnedExtension ?? resolveOwnedTelephonyExtension)(actor);
  const state = await loadWorkplaceSelectionState(dependencies.client, actor);
  assertRoutingIdle(state.routing);
  const draft = mutableWorkplacePriorityDraft(
    state,
    (dependencies.now ?? (() => new Date().toISOString()))(),
  );
  const queue = DISPATCH_QUEUE_NUMBERS.find((candidate) => draft.selections[candidate] === owned.extension);
  if (!queue) return { state: "confirmed", noOp: true, message: "Pracovné miesto nie je vo vybranom poradí." };
  draft.selections[queue] = null;
  draft.selectedBy[queue] = null;
  draft.updatedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  assertPriorityPrefix(draft.selections);
  assertSelfServiceFallbackBeforePersist(state, state.routing.currentPlan, draft.selections);
  const persistedDraft = await saveWorkplacePriorityDraft(dependencies.client, actor, state.root, draft);
  const providerMutationStarted = !emptyPlan(state.routing.currentPlan) && !samePlan(draft.selections, state.routing.currentPlan);
  if (providerMutationStarted) {
    await startDraftRoutingOperation(actor, state.routing, persistedDraft, dependencies, true);
  }
  return {
    state: providerMutationStarted ? "pending" : "draft",
    message: providerMutationStarted
      ? `Uvoľnenie priority ${priorityOrder(queue)} sa odoslalo do VIPTel. Pracovné miesto uvoľni až po potvrdení zmeny.`
      : `Rozpracovaná priorita ${priorityOrder(queue)} je uvoľnená. VIPTel zatiaľ nemal aktívny plán.`,
  };
}

export async function startDraftRoutingOperation(
  actor: MotoristActor,
  routing: DispatchRoutingState,
  draft: WorkplacePriorityDraft,
  dependencies: WorkplaceDependencies,
  allowPartial = false,
) {
  const slots = DISPATCH_QUEUE_NUMBERS.map((queue) => ({ queue, extension: draft.selections[queue] }));
  const authorityId = workplaceDraftAuthorityId(draft);
  if (!authorityId) {
    throw new MutationError("Aktuálnemu výberu priorít chýba serverový dôkaz.", 409);
  }
  const rootMetadataGuard = {
    key: "workplacePriorityDraft" as const,
    digest: dispatchRoutingRootMetadataDigest("workplacePriorityDraft", draft),
    authorityId,
  };
  if (emptyPlan(routing.currentPlan)) {
    const preview = await (dependencies.previewBootstrap ?? previewOrStartEmptyDispatchRoutingPlan)(actor, {
      baseRevision: routing.revision,
      slots,
      dryRun: true,
      rootMetadataGuard,
    });
    await (dependencies.previewBootstrap ?? previewOrStartEmptyDispatchRoutingPlan)(actor, {
      baseRevision: routing.revision,
      slots,
      dryRun: false,
      previewDigest: preview.previewDigest,
      rootMetadataGuard,
    });
    return;
  }

  const unchangedFallbackQueue = (["603", "602", "601"] as const).find(
    (queue) => routing.currentPlan[queue] && routing.currentPlan[queue] === draft.selections[queue],
  );
  // When the committed plan contains only audited free placeholders there is
  // no live fallback to preserve. Use the first real target as a make-before-
  // break anchor; dispatch-routing admits it only under its zero-waiting-call,
  // registered-target controlled-window proof.
  const fallbackQueue = unchangedFallbackQueue ?? DISPATCH_QUEUE_NUMBERS.find(
    (queue) => Boolean(draft.selections[queue]),
  );
  const fallbackExtension = fallbackQueue
    ? unchangedFallbackQueue
      ? routing.currentPlan[fallbackQueue]
      : draft.selections[fallbackQueue]
    : null;
  if (!fallbackQueue || !fallbackExtension) {
    throw new MutationError(
      "Táto zmena by naraz zasiahla všetky tri priority bez nezávislej zálohy. Vyber jednoduchú výmenu dvoch miest alebo použi správu priorít.",
      409,
    );
  }
  const apply = allowPartial
    ? dependencies.previewPartialApply ?? previewOrStartPartialDispatchRoutingPlan
    : dependencies.previewApply ?? previewOrStartDispatchRoutingPlan;
  const preview = await apply(actor, {
    baseRevision: routing.revision,
    slots,
    fallback: { queue: fallbackQueue, extension: fallbackExtension },
    dryRun: true,
    rootMetadataGuard,
  });
  await apply(actor, {
    baseRevision: routing.revision,
    slots,
    fallback: { queue: fallbackQueue, extension: fallbackExtension },
    dryRun: false,
    previewDigest: preview.previewDigest,
    rootMetadataGuard,
  });
}

export type LoadedWorkplaceState = {
  root: RootQueue;
  routing: DispatchRoutingState;
  draft?: WorkplacePriorityDraft;
  extensions: ExtensionRow[];
  ownerByExtension: Map<string, string>;
  profileNames: Map<string, string>;
  leases?: Map<string, WorkplaceLease>;
  transitioningExtensionIds?: Set<string>;
  currentRoutingCommand?: RoutingCommandRow | null;
  databaseNow?: string;
};

export async function loadCurrentWorkplaceRoutingCommand(
  client: AdminClient,
  actor: MotoristActor,
  operation: DispatchRoutingOperation | undefined,
): Promise<RoutingCommandRow | null> {
  const step = operation?.steps[operation.currentStep];
  if (!operation || !step) return null;
  const result = await client
    .from("motorist_telephony_commands")
    .select("id, status, command_type, request_payload, provider_response")
    .eq("id", step.commandId)
    .eq("organization_id", actor.organizationId)
    .eq("provider", PROVIDER)
    .maybeSingle();
  if (result.error) {
    throw new MutationError("Aktuálny príkaz poradia sa nepodarilo načítať.", 500);
  }
  return result.data as RoutingCommandRow | null;
}

export async function loadWorkplaceSelectionState(
  client: AdminClient,
  actor: MotoristActor,
): Promise<LoadedWorkplaceState> {
  const hotdesk = workplaceHotdeskCapability();
  // Keep the flag-off read path deployable before the additive hot-desk
  // migration. PostgREST rejects a SELECT that names a column which does not
  // exist yet even when the caller never reads that field.
  const [extensionsResult, queuesResult, profilesResult, leasesResult, resourceClaimsResult, databaseNow] = await Promise.all([
    (!hotdesk.runtimeEnabled
      ? client
          .from("motorist_telephony_extensions")
          .select("id, extension, profile_id, is_registered, metadata")
      : client
          .from("motorist_telephony_extensions")
          .select("id, extension, profile_id, is_registered, metadata, workplace_seat_generation"))
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
    client
      .from("motorist_profiles")
      .select("id, display_name")
      .eq("organization_id", actor.organizationId)
      .eq("active", true),
    !hotdesk.runtimeEnabled
      ? Promise.resolve({ data: [], error: null })
      : client
          .from("motorist_workplace_leases")
          .select("*")
          .eq("organization_id", actor.organizationId)
          .in("state", ["active", "ending"]),
    !hotdesk.runtimeEnabled
      ? Promise.resolve({ data: [], error: null })
      : client
          .from("motorist_workplace_resource_claims")
          .select("resource_id, operation_id")
          .eq("organization_id", actor.organizationId)
          .eq("resource_type", "extension")
          .not("operation_id", "is", null),
    !hotdesk.runtimeEnabled
      ? Promise.resolve(undefined)
      : createWorkplaceOperationRepository(client).databaseNow().catch(() => {
          throw new MutationError("Databázový čas pracovísk sa nepodarilo overiť.", 500);
        }),
  ]);
  if (extensionsResult.error) throw new MutationError("Pracovné miesta sa nepodarilo načítať.", 500);
  if (queuesResult.error) throw new MutationError("Priority zvonenia sa nepodarilo načítať.", 500);
  if (profilesResult.error) throw new MutationError("Mená operátorov sa nepodarilo načítať.", 500);
  if (leasesResult.error) throw new MutationError("Relácie pracovísk sa nepodarilo načítať.", 500);
  if (resourceClaimsResult.error) throw new MutationError("Rozpracované zmeny pracovísk sa nepodarilo načítať.", 500);
  const roots = (queuesResult.data ?? []).filter((queue) => queue.external_id === "601");
  if (roots.length !== 1 || (queuesResult.data ?? []).length !== DISPATCH_QUEUE_NUMBERS.length) {
    throw new MutationError("Katalóg priorít 601–603 nie je úplný a jednoznačný.", 409);
  }
  const root = roots[0] as RootQueue;
  const routing = parseDispatchRoutingState(root.metadata);
  const draft = readWorkplacePriorityDraft(root.metadata);
  const extensions = (extensionsResult.data ?? []) as ExtensionRow[];
  const markerCandidates = !hotdesk.runtimeEnabled
    ? extensions.flatMap((extension) =>
        readAssignmentLifecycle(jsonRecord(extension.metadata).assignmentLifecycle)?.assignmentMode === "workplace_claim"
          ? [extension.id]
          : [])
    : [];
  const bootstrappedWhileRuntimeOff = markerCandidates.length > 0
    ? await findBootstrappedWorkplaceExtensionIds(client, actor.organizationId, {
        extensionIds: markerCandidates,
      })
    : new Set<string>();
  if (!hotdesk.runtimeEnabled && bootstrappedWhileRuntimeOff.size > 0) {
    throw new MutationError(
      "Dynamické pracoviská ešte nie sú bezpečne vyprázdnené. Obnov runtime relácií alebo dokonči riadené vyradenie.",
      503,
      "hotdesk_runtime_disabled",
    );
  }
  const parsedLeases = (leasesResult.data ?? []).map((row) => {
    const lease = readWorkplaceLease(row);
    if (!lease) throw new MutationError("Uložená relácia pracoviska má neplatný formát.", 409);
    return lease;
  });
  const leases = new Map<string, WorkplaceLease>();
  for (const lease of parsedLeases) {
    if (leases.has(lease.extensionId)) throw new MutationError("Pracovné miesto má viac aktívnych relácií.", 409);
    leases.set(lease.extensionId, lease);
  }
  const ownerByExtension = new Map(
    extensions.flatMap((extension) => extension.profile_id ? [[extension.extension, extension.profile_id] as const] : []),
  );
  if (draft && draft.baseRevision > routing.revision) {
    throw new MutationError("Rozpracovaný výber priorít odkazuje na budúcu revíziu.", 409);
  }
  // A committed manager revision supersedes older self-service drafts. Their
  // historical owners may legitimately have changed in the meantime, so only
  // a draft that can still affect this routing head is checked against the
  // current seat ownership map.
  const state: LoadedWorkplaceState = {
    root,
    routing,
    draft,
    extensions,
    ownerByExtension,
    profileNames: new Map((profilesResult.data ?? []).map((profile) => [profile.id, profile.display_name])),
    leases,
    transitioningExtensionIds: new Set((resourceClaimsResult.data ?? []).map((claim) => claim.resource_id)),
    ...(databaseNow ? { databaseNow } : {}),
  };
  if (draft?.baseRevision === routing.revision) {
    await requireLatestWorkplacePriorityDraftAuthority(client, draft, {
      organizationId: actor.organizationId,
      rootQueueId: root.id,
    });
    try {
      assertDraftOwnership(draft, state);
    } catch (error) {
      if (!hotdesk.runtimeEnabled || !samePlan(draft.selections, routing.currentPlan)) throw error;
      // A seat handoff can change selectedBy immediately after the exact same
      // plan was committed. The signed draft is then redundant, not a second
      // routing authority. Ignore only that exact-plan copy; a differing draft
      // remains fail-closed and must still match current ownership.
      state.draft = undefined;
    }
  }
  return state;
}

export function buildWorkplaceSelectionSnapshot(
  actor: MotoristActor,
  state: LoadedWorkplaceState,
  checkedAt: string,
): WorkplaceSelectionSnapshot {
  const draftApplicable = state.draft?.baseRevision === state.routing.revision;
  const desired = draftApplicable ? state.draft?.selections as DispatchPriorityPlan : state.routing.currentPlan;
  const actorExtension = state.extensions.find((extension) => extension.profile_id === actor.profileId)?.extension ?? null;
  const selectedQueue = actorExtension
    ? DISPATCH_QUEUE_NUMBERS.find((queue) => desired[queue] === actorExtension) ?? null
    : null;
  const actorCurrentQueue = actorExtension
    ? DISPATCH_QUEUE_NUMBERS.find((queue) => desired[queue] === actorExtension)
    : undefined;
  const planPending = !samePlan(desired, state.routing.currentPlan);
  const selectedCount = Object.values(desired).filter(Boolean).length;
  const actorSeat = state.extensions.find((extension) => extension.profile_id === actor.profileId);
  const routingStatus = routingStatusFor(actor, state, desired, selectedCount, actorSeat, checkedAt);
  const firstEmptyPriorityIndex = DISPATCH_QUEUE_NUMBERS.findIndex((queue) => !desired[queue]);
  const leases = state.leases ?? new Map<string, WorkplaceLease>();
  const transitioningExtensionIds = state.transitioningExtensionIds ?? new Set<string>();
  const actorLease = actorSeat ? leases.get(actorSeat.id) : undefined;
  const hotdesk = workplaceHotdeskCapability();
  const actorCanCreateClaim = canProfileUseWorkplaceHotdesk(hotdesk, actor.profileId);
  const claimBlockedReason = hotdesk.runtimeEnabled && !actorCanCreateClaim
    ? !hotdesk.claimsEnabled
      ? "Nové obsadzovanie pracovných miest je dočasne pozastavené. Aktívne miesto môžeš ďalej používať alebo opustiť."
      : hotdesk.enabled
        ? "Tento účet nemá povolené obsadzovanie pracovísk."
        : "Nové obsadzovanie pracovných miest nie je v tomto prostredí bezpečne povolené."
    : undefined;

  return {
    checkedAt,
    selection: {
      ...(hotdesk.runtimeEnabled ? { seatId: actorSeat?.id ?? null } : {}),
      extension: actorExtension,
      queue: selectedQueue,
    },
    ...(actorSeat && actorLease
      ? { lease: toWorkplaceLeaseClientRef(actorLease, { extension: actorSeat.extension, seatId: actorSeat.id }) }
      : {}),
    seats: configuredPersonalExtensions().map((extensionNumber) => {
      const extension = state.extensions.find((candidate) => candidate.extension === extensionNumber);
      const profileId = extension?.profile_id ?? undefined;
      const lease = extension ? leases.get(extension.id) : undefined;
      const lifecycle = readAssignmentLifecycle(jsonRecord(extension?.metadata).assignmentLifecycle);
      const canonical = Boolean(
        extension?.workplace_seat_generation && lifecycle?.assignmentMode === "workplace_claim" &&
        lifecycle.extensionId === extension.id && lifecycle.extension === extension.extension &&
        lifecycle.profileId === (extension.profile_id ?? null),
      );
      const freshness = lease ? workplaceLeaseFreshness(lease, checkedAt) : undefined;
      const transitioning = Boolean(
        extension && (
          hasActiveAssignmentTransitionMetadata(extension.metadata) || transitioningExtensionIds.has(extension.id)
        ) || freshness === "ending",
      );
      const status: WorkplaceSeatStatus = !hotdesk.runtimeEnabled
        ? profileId === actor.profileId
          ? "mine"
          : profileId
            ? "occupied"
            : extension?.is_registered === false
              ? "available"
              : "unavailable"
        : !extension || !canonical || (!profileId && lease)
          ? "unknown"
          : transitioning
            ? "transitioning"
            // An owner with no live lease is the ordinary aftermath of an
            // operator whose browser went away: the sweeper reaps the lease and
            // deliberately never touches ownership, so the seat is left owned
            // and leaseless. That is the same situation as an expired lease
            // below and must stay takeable. Classifying it "unknown" made every
            // swept seat unselectable by anyone -- including its own owner --
            // which is precisely the stuck-in-your-workstation dead end.
            : profileId && !lease
              ? "stale"
            : profileId === actor.profileId
              ? "mine"
              : !profileId && extension.is_registered === false
                ? "free"
                : !profileId && extension.is_registered === true
                  ? "stale"
                : profileId && lease && freshness === "expired" &&
                    (extension.is_registered === true || extension.is_registered === false)
                  ? "stale"
                  : profileId && lease && freshness === "expired"
                    ? "unknown"
                  : profileId && lease
                    ? "active"
                    : "unknown";
      const priority = queueForSelection(desired, extensionNumber);
      const reasonCode = seatReasonCode(status, extension?.is_registered);
      const selectableSeat = status === "free" || status === "stale";
      const reason = selectableSeat && claimBlockedReason
        ? claimBlockedReason
        : seatReason(status, extension?.is_registered, Boolean(profileId));
      return {
        ...(extension ? { seatId: extension.id } : {}),
        extension: extensionNumber,
        status,
        canSelect: status === "mine" || (actorCanCreateClaim && selectableSeat),
        reasonCode,
        reason,
        priority,
        outboundOnly: priority === null,
        version: seatVersion(extension, lease),
        ...(profileId ? { profileId, profileName: state.profileNames.get(profileId) } : {}),
        ...(profileId ? { owner: { profileId, profileName: state.profileNames.get(profileId) } } : {}),
        ...(lease ? { heartbeatFresh: freshness === "fresh" } : {}),
        ...(extension?.is_registered === null || extension?.is_registered === undefined
          ? {}
          : { registered: extension.is_registered }),
        ...(profileId && profileId !== actor.profileId && (actor.role === "admin" || actor.role === "manager")
          ? { management: workplaceSeatManagement(actor, state, extension) }
          : {}),
      };
    }),
    priorities: DISPATCH_QUEUE_NUMBERS.map((queue, index) => {
      const selectedExtension = desired[queue];
      const profileId = selectedExtension ? state.ownerByExtension.get(selectedExtension) : undefined;
      const mine = Boolean(actorExtension && selectedExtension === actorExtension);
      const selectedSeatIsFree = Boolean(selectedExtension && isCanonicalFreeSeat(state, selectedExtension));
      const status: WorkplacePriorityStatus = !selectedExtension
        ? (!actorCurrentQueue && index === firstEmptyPriorityIndex ? "available" : "locked")
        : selectedSeatIsFree
          ? "available"
        : planPending || state.routing.operation
          ? mine ? "pending_mine" : "pending_occupied"
          : mine ? "mine" : "occupied";
      const selectionEffect: WorkplacePrioritySelectionEffect = mine
        ? "mine"
        : selectedSeatIsFree
          ? "replace"
        : selectedExtension
          ? actorCurrentQueue ? "swap" : "replace"
          : "claim";
      return {
        queue,
        order: (index + 1) as 1 | 2 | 3,
        activeExtension: state.routing.currentPlan[queue],
        selectedExtension,
        status,
        selectionEffect,
        ...(profileId ? { profileId, profileName: state.profileNames.get(profileId) } : {}),
        ...(selectedExtension && !mine && !selectedSeatIsFree
          ? {
              willDisplace: {
                extension: selectedExtension,
                ...(profileId ? { profileId, profileName: state.profileNames.get(profileId) } : {}),
              },
            }
          : {}),
      };
    }),
    routingStatus,
  };
}

function workplaceSeatManagement(
  actor: MotoristActor,
  state: LoadedWorkplaceState,
  seat: ExtensionRow | undefined,
): NonNullable<WorkplaceSelectionSnapshot["seats"][number]["management"]> {
  const extension = seat?.extension ?? "";
  const registered = seat?.is_registered;
  if (actor.role !== "admin" && actor.role !== "manager") {
    return {
      takeover: "blocked",
      release: "blocked",
      reason: "Cudzie pracovisko môže spravovať iba administrátor alebo manažér.",
    };
  }
  const lifecycle = readAssignmentLifecycle(jsonRecord(seat?.metadata).assignmentLifecycle);
  if (
    !lifecycle || lifecycle.state !== "assigned" || lifecycle.assignmentMode !== "workplace_claim" ||
    lifecycle.extensionId !== seat?.id || lifecycle.extension !== extension || lifecycle.profileId !== seat?.profile_id
  ) {
    return {
      takeover: "blocked",
      release: "blocked",
      reason: "Miesto nie je technicky nastavené ako zdieľané pracovisko. Vyžaduje bezpečnú prípravu SIP/VIPTel správcom.",
    };
  }
  if (!workplaceAdminTakeoverGateStatus().enabled) {
    return {
      takeover: "blocked",
      release: "blocked",
      reason: "Bezpečné prevzatie pracoviska zatiaľ nie je v tomto prostredí zapnuté.",
    };
  }
  if (state.extensions.some((candidate) => candidate.profile_id === actor.profileId)) {
    return {
      takeover: "blocked",
      release: "blocked",
      reason: "Najprv uvoľni svoje aktuálne pracovné miesto.",
    };
  }
  if (state.routing.operation) {
    return {
      takeover: "blocked",
      release: "blocked",
      reason: "VIPTel práve potvrdzuje zmenu poradia. Počkaj na jej dokončenie.",
      refreshable: true,
    };
  }
  const applicableDraft = state.draft?.baseRevision === state.routing.revision ? state.draft : undefined;
  if (applicableDraft && !samePlan(applicableDraft.selections, state.routing.currentPlan)) {
    return {
      takeover: "blocked",
      release: "blocked",
      reason: "Najprv dokonči alebo obnov rozpracovanú zmenu poradia.",
      refreshable: true,
    };
  }
  if (registered !== false) {
    return {
      takeover: "blocked",
      release: "blocked",
      reason: registered === true
        ? "Telefón je stále pripojený vo VIPTel."
        : "Živý stav telefónu nie je potvrdený. Obnov stav.",
      refreshable: true,
    };
  }
  const inCommittedPlan = Object.values(state.routing.currentPlan).includes(extension);
  const inApplicableDraft = Boolean(applicableDraft && Object.values(applicableDraft.selections).includes(extension));
  return {
    takeover: "allowed",
    release: inCommittedPlan || inApplicableDraft ? "blocked" : "allowed",
    ...(inCommittedPlan || inApplicableDraft
      ? { reason: "Miesto je súčasťou poradia. Prevezmi ho, aby poradie zostalo funkčné." }
      : {}),
  };
}

export type WorkplacePriorityRecoveryEvaluation = {
  blocked: boolean;
  canRecover: boolean;
  deliveryUncertain: boolean;
  inProgress: boolean;
  owned: boolean;
  reason?: string;
};

export function evaluateWorkplacePriorityRecovery(
  actor: MotoristActor,
  state: LoadedWorkplaceState,
  ownedExtensionId?: string,
  ownedExtension?: string,
  checkedAt = new Date().toISOString(),
): WorkplacePriorityRecoveryEvaluation {
  const operation = state.routing.operation;
  if (!operation) {
    return { blocked: false, canRecover: false, deliveryUncertain: false, inProgress: false, owned: false };
  }
  const seat = ownedExtensionId && ownedExtension
    ? state.extensions.find((candidate) =>
        candidate.id === ownedExtensionId && candidate.extension === ownedExtension &&
        candidate.profile_id === actor.profileId)
    : state.extensions.find((candidate) => candidate.profile_id === actor.profileId);
  const actorExtension = seat?.extension;
  const actorExtensionId = seat?.id;
  const lease = actorExtensionId ? state.leases?.get(actorExtensionId) : undefined;
  const hasCurrentLease = Boolean(
    lease && lease.profileId === actor.profileId && workplaceLeaseFreshness(lease, checkedAt) === "fresh",
  );
  const guard = operation.assignmentGuards.find((candidate) =>
    candidate.extensionId === actorExtensionId &&
    candidate.extension === actorExtension &&
    candidate.profileId === actor.profileId);
  const belongsToPlan = Boolean(actorExtension && (
    Object.values(operation.previousPlan).includes(actorExtension) ||
    Object.values(operation.targetPlan).includes(actorExtension)
  ));
  const owned = Boolean(
    seat && hasCurrentLease && guard && belongsToPlan &&
    operation.actorProfileId === actor.profileId &&
    operation.rootMetadataGuard?.key === DRAFT_KEY,
  );
  const step = operation.steps[operation.currentStep];
  const command = state.currentRoutingCommand;
  const tag = jsonRecord(jsonRecord(command?.request_payload).routingOperation);
  const commandMatches = Boolean(
    step && command &&
    command.id === step.commandId &&
    command.command_type === step.commandType &&
    readString(tag.operationId) === operation.operationId &&
    readInteger(tag.stepIndex) === operation.currentStep,
  );
  const commandFailed = commandMatches && command?.status === "failed";
  // The provider event may durably confirm the command immediately before the
  // listener advances the routing root. If the process stops in that window,
  // waiting for another (possibly never repeated) provider event would leave
  // the workplace in an endless activating state. Existing dispatch recovery
  // already validates this terminal command and rebuilds from a fresh provider
  // snapshot, so expose that exact crash window as blocked and recoverable.
  const commandConfirmedButNotAdvanced = commandMatches && command?.status === "confirmed_by_event";
  const inProgress = Boolean(commandMatches && ["queued", "sent", "accepted"].includes(command?.status ?? ""));
  const response = jsonRecord(command?.provider_response);
  const deliveryUncertain = Boolean(commandFailed && response.deliveryUncertain === true);
  const blocked = operation.status === "degraded" || commandFailed || commandConfirmedButNotAdvanced;
  const reason = typeof response.error === "string" && response.error.trim()
    ? response.error.trim()
    : commandConfirmedButNotAdvanced
      ? "VIPTel krok je potvrdený, ale dokončenie poradia sa prerušilo."
      : operation.lastError;
  return {
    blocked,
    canRecover: Boolean(
      owned && (commandConfirmedButNotAdvanced || (commandFailed && !deliveryUncertain)),
    ),
    deliveryUncertain,
    inProgress,
    owned,
    ...(reason ? { reason } : {}),
  };
}

function routingStatusFor(
  actor: MotoristActor,
  state: LoadedWorkplaceState,
  desired: DispatchPriorityPlan,
  selectedCount: number,
  actorSeat: ExtensionRow | undefined,
  checkedAt: string,
): WorkplaceSelectionSnapshot["routingStatus"] {
  const operation = state.routing.operation;
  if (operation) {
    const recovery = evaluateWorkplacePriorityRecovery(
      actor,
      state,
      actorSeat?.id,
      actorSeat?.extension,
      checkedAt,
    );
    return {
      state: recovery.blocked ? "blocked" : "activating",
      selectedCount,
      capacityCount: 3,
      operationId: operation.operationId,
      ...(recovery.canRecover ? { canRecover: true } : {}),
      message: recovery.blocked
        ? recovery.deliveryUncertain
          ? "Výsledok posledného kroku vo VIPTel nie je jednoznačný. Zmenu musí zosúladiť správca."
          : recovery.canRecover
            ? `${recovery.reason ? `${recovery.reason} ` : ""}Poradie môžeš bezpečne obnoviť.`
            : recovery.reason ?? "VIPTel zmenu nepotvrdil. Obnov stav alebo kontaktuj správcu."
        : "VIPTel práve potvrdzuje nové poradie. Pred ďalšou zmenou počkaj na dokončenie.",
    };
  }
  if (selectedCount > 0 && samePlan(desired, state.routing.currentPlan)) {
    const occupiedQueues = DISPATCH_QUEUE_NUMBERS.filter((queue) => Boolean(desired[queue]));
    const emptyQueues = DISPATCH_QUEUE_NUMBERS.filter((queue) => !desired[queue]);
    return {
      state: "active",
      selectedCount,
      capacityCount: 3,
      message: selectedCount === 3
        ? "Poradie 601 → 602 → 603 je potvrdené uloženým provider plánom."
        : `V uloženom poradí ${occupiedQueues.length === 1 ? "je obsadený rad" : "sú obsadené rady"} ${occupiedQueues.join(" a ")}. ${emptyQueues.length === 1 ? "Rad" : "Rady"} ${emptyQueues.join(" a ")} ${emptyQueues.length === 1 ? "je" : "sú"} bez operátora.`,
    };
  }
  if (selectedCount > 0) {
    return {
      state: "ready",
      selectedCount,
      capacityCount: 3,
      message: "Výber prvého operátora je uložený a pripravený na aktiváciu. Potvrď miesto a poradie ešte raz.",
    };
  }
  return {
    state: "collecting",
    selectedCount,
    capacityCount: 3,
    message: "Vyber prvé pracovné miesto. Ďalších operátorov môžeš pridať neskôr.",
  };
}

export function mutableWorkplacePriorityDraft(
  state: LoadedWorkplaceState,
  now: string,
): WorkplacePriorityDraft {
  if (state.draft && state.draft.baseRevision > state.routing.revision) {
    throw new MutationError("Rozpracovaný výber priorít odkazuje na budúcu revíziu.", 409);
  }
  if (state.draft?.baseRevision === state.routing.revision) return structuredClone(state.draft);
  return {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    baseRevision: state.routing.revision,
    selections: { ...state.routing.currentPlan },
    selectedBy: Object.fromEntries(DISPATCH_QUEUE_NUMBERS.map((queue) => [
      queue,
      state.routing.currentPlan[queue]
        ? state.ownerByExtension.get(state.routing.currentPlan[queue] as string) ?? null
        : null,
    ])) as WorkplacePriorityDraft["selectedBy"],
    updatedAt: now,
  };
}

export async function saveWorkplacePriorityDraft(
  client: AdminClient,
  actor: MotoristActor,
  root: RootQueue,
  draft: WorkplacePriorityDraft,
) {
  assertWorkplacePriorityDraftWriteUnlocked(root.metadata);
  const auditId = randomUUID();
  const authorized = authorizeWorkplacePriorityDraft(draft, {
    organizationId: actor.organizationId,
    rootQueueId: root.id,
  }, auditId);
  const previousMetadata = jsonRecord(root.metadata);
  const metadata = { ...previousMetadata, [DRAFT_KEY]: authorized.draft };
  const updated = await client
    .from("motorist_telephony_queues")
    .update({ metadata: toJson(metadata) })
    .eq("id", root.id)
    .eq("organization_id", actor.organizationId)
    .eq("provider", PROVIDER)
    .eq("external_id", "601")
    .eq("updated_at", root.updated_at)
    .select("id, updated_at")
    .maybeSingle();
  if (updated.error) throw new MutationError("Výber priority sa nepodarilo uložiť.", 500);
  if (!updated.data) throw new MutationError("Priority medzitým zmenil iný operátor. Obnov stav a skús to znova.", 409);
  const audit = await client.from("motorist_audit_log").insert({
    id: auditId,
    organization_id: actor.organizationId,
    actor_profile_id: actor.profileId,
    action: "telephony.workplace.priority.draft",
    entity_type: "motorist_telephony_queues",
    entity_id: root.id,
    source: "web",
    // The immutable row proves server provenance without copying selections or
    // profile identifiers into another payload.
    after_payload: toJson(authorized.auditPayload),
  });
  if (audit.error) {
    const rolledBack = await client
      .from("motorist_telephony_queues")
      .update({ metadata: toJson(previousMetadata) })
      .eq("id", root.id)
      .eq("organization_id", actor.organizationId)
      .eq("provider", PROVIDER)
      .eq("external_id", "601")
      .eq("updated_at", updated.data.updated_at)
      .select("id")
      .maybeSingle();
    if (rolledBack.error || !rolledBack.data) {
      throw new MutationError(
        "Serverový dôkaz výberu priorít zlyhal a bezpečný návrat sa nepotvrdil. Výber je zablokovaný do kontroly správcom.",
        500,
      );
    }
    throw new MutationError("Serverový dôkaz výberu priorít zlyhal; zmena bola bezpečne vrátená.", 500);
  }
  return authorized.draft;
}

async function assertActorHasNoPriorityDraft(client: AdminClient, actor: MotoristActor) {
  const owned = await resolveOwnedTelephonyExtension(actor).catch((error) => {
    if (error instanceof MutationError && error.status === 403) return undefined;
    throw error;
  });
  if (!owned) return;
  const state = await loadWorkplaceSelectionState(client, actor);
  const desired = state.draft?.baseRevision === state.routing.revision
    ? state.draft.selections
    : state.routing.currentPlan;
  if (Object.values(desired).includes(owned.extension)) {
    throw new MutationError("Pred uvoľnením pracovného miesta najprv uvoľni jeho prioritu zvonenia.", 409);
  }
}

function assertRoutingIdle(state: DispatchRoutingState) {
  if (state.operation) {
    throw new MutationError("Predchádzajúca zmena priorít ešte čaká na potvrdenie VIPTel.", 409);
  }
}

function assertDraftShape(draft: WorkplacePriorityDraft, owners: Map<string, string>) {
  const seen = new Set<string>();
  for (const queue of DISPATCH_QUEUE_NUMBERS) {
    const extension = draft.selections[queue];
    const selectedBy = draft.selectedBy[queue];
    if (!extension) {
      if (selectedBy !== null) throw new MutationError(`Prázdna priorita ${queue} má neplatného držiteľa.`, 409);
      continue;
    }
    if (!configuredPersonalExtensions().includes(extension) || seen.has(extension)) {
      throw new MutationError("Rozpracovaný výber priorít obsahuje neplatné alebo duplicitné pracovné miesto.", 409);
    }
    seen.add(extension);
    const owner = owners.get(extension);
    if ((selectedBy === null && owner !== undefined) ||
        (selectedBy !== null && owner !== selectedBy)) {
      throw new MutationError(`Držiteľ priority ${queue} nezodpovedá aktuálnemu pracovnému miestu.`, 409);
    }
  }
}

function assertDraftOwnership(draft: WorkplacePriorityDraft, state: LoadedWorkplaceState) {
  assertDraftShape(draft, state.ownerByExtension);
  for (const queue of DISPATCH_QUEUE_NUMBERS) {
    const extension = draft.selections[queue];
    if (extension && draft.selectedBy[queue] === null && !isCanonicalFreeSeat(state, extension)) {
      throw new MutationError(`Voľné pracovné miesto v priorite ${queue} nemá dôveryhodný stav.`, 409);
    }
  }
}

function isCanonicalFreeSeat(state: LoadedWorkplaceState, extensionNumber: string) {
  const seat = state.extensions.find((extension) => extension.extension === extensionNumber);
  if (!seat || seat.profile_id !== null || seat.is_registered !== false || state.leases?.has(seat.id)) return false;
  const lifecycle = readAssignmentLifecycle(jsonRecord(seat.metadata).assignmentLifecycle);
  return Boolean(
    seat.workplace_seat_generation && lifecycle?.state === "unassigned" &&
    lifecycle.assignmentMode === "workplace_claim" && lifecycle.extensionId === seat.id &&
    lifecycle.extension === seat.extension && lifecycle.profileId === null,
  );
}

export function applyWorkplacePriorityClaim(
  current: WorkplacePriorityDraft,
  input: {
    actorExtension: string;
    actorProfileId: string;
    ownerByExtension: Map<string, string>;
    queue: DispatchQueueNumber;
    updatedAt: string;
  },
) {
  const draft = structuredClone(current);
  delete draft.authority;
  const actorCurrentQueue = DISPATCH_QUEUE_NUMBERS.find(
    (candidate) => draft.selections[candidate] === input.actorExtension,
  );
  const displacedExtension = draft.selections[input.queue];
  if (actorCurrentQueue && actorCurrentQueue !== input.queue) {
    const displacedOwner = displacedExtension
      ? input.ownerByExtension.get(displacedExtension)
      : undefined;
    // Swap only staffed seats. A truly free seat is replaced, not moved into
    // the actor's old priority as a phantom occupied slot.
    draft.selections[actorCurrentQueue] = displacedOwner ? displacedExtension : null;
    draft.selectedBy[actorCurrentQueue] = displacedOwner ?? null;
  }
  draft.selections[input.queue] = input.actorExtension;
  draft.selectedBy[input.queue] = input.actorProfileId;
  draft.updatedAt = input.updatedAt;
  assertDraftShape(draft, input.ownerByExtension);
  return { draft, displacedExtension };
}

export function compactCanonicalFreeWorkplacePriorities(
  state: LoadedWorkplaceState,
  current: WorkplacePriorityDraft,
): WorkplacePriorityDraft {
  const retained = DISPATCH_QUEUE_NUMBERS.flatMap((queue) => {
    const extension = current.selections[queue];
    if (!extension || isCanonicalFreeSeat(state, extension)) return [];
    const selectedBy = state.ownerByExtension.get(extension);
    return selectedBy ? [{ extension, selectedBy }] : [];
  });
  const draft = structuredClone(current);
  delete draft.authority;
  for (const [index, queue] of DISPATCH_QUEUE_NUMBERS.entries()) {
    draft.selections[queue] = retained[index]?.extension ?? null;
    draft.selectedBy[queue] = retained[index]?.selectedBy ?? null;
  }
  assertDraftShape(draft, state.ownerByExtension);
  return draft;
}

export function readWorkplacePriorityDraft(metadata: unknown): WorkplacePriorityDraft | undefined {
  const raw = jsonRecord(metadata)[DRAFT_KEY];
  if (raw === undefined) return undefined;
  return parseWorkplacePriorityDraft(raw);
}

function readQueue(value: unknown): DispatchQueueNumber {
  if (value === "601" || value === "602" || value === "603") return value;
  throw new MutationError("Priorita musí byť 601, 602 alebo 603.", 400);
}

function priorityOrder(queue: DispatchQueueNumber) {
  return queue === "601" ? "1" : queue === "602" ? "2" : "3";
}

function queueForSelection(plan: DispatchPriorityPlan, extension: string): DispatchQueueNumber | null {
  return DISPATCH_QUEUE_NUMBERS.find((queue) => plan[queue] === extension) ?? null;
}

function seatReasonCode(status: WorkplaceSeatStatus, registered?: boolean | null) {
  if (status === "free") return "seat_free";
  if (status === "mine") return "seat_mine";
  if (status === "stale") return "seat_offline";
  if (status === "active") return registered ? "phone_registered" : "heartbeat_fresh";
  if (status === "transitioning") return "seat_transitioning";
  if (status === "unknown") return "seat_state_unknown";
  return status === "available" ? "seat_free" : status === "occupied" ? "seat_occupied" : "seat_unavailable";
}

function seatReason(status: WorkplaceSeatStatus, registered?: boolean | null, hasOwner = false) {
  if (status === "free" || status === "available") return "Pracovné miesto je voľné.";
  if (status === "mine") return "Toto je tvoje pracovné miesto.";
  if (status === "stale") return registered
    ? hasOwner
      ? "Pôvodný operátor je offline. Staré pripojenie telefónu sa pri obsadení automaticky vyčistí."
      : "Miesto nemá aktívneho vlastníka, ale VIPTel eviduje staré pripojenie. Pred obsadením ho bezpečne overíme a vyčistíme."
    : "Pôvodný operátor je offline; stav sa pred prevzatím znova overí vo VIPTel.";
  if (status === "active") return registered
    ? "Telefón operátora je pripojený. Miesto nemožno prevziať."
    : "Operátor má čerstvú reláciu pracoviska. Miesto nemožno prevziať.";
  if (status === "transitioning") return "Na pracovnom mieste práve prebieha bezpečná zmena.";
  if (status === "occupied") return "Pracovné miesto používa iný operátor.";
  return "Stav pracovného miesta nie je jednoznačne potvrdený.";
}

function seatVersion(extension: ExtensionRow | undefined, lease: WorkplaceLease | undefined) {
  return workplaceSeatOwnershipVersion({
    seatId: extension?.id,
    lifecycleEpoch: readAssignmentLifecycle(jsonRecord(extension?.metadata).assignmentLifecycle)?.epoch,
    lease,
  });
}

function completePlan(plan: DispatchPriorityPlan) {
  return DISPATCH_QUEUE_NUMBERS.every((queue) => Boolean(plan[queue]));
}

function assertPriorityPrefix(plan: DispatchPriorityPlan) {
  let emptySeen = false;
  for (const queue of DISPATCH_QUEUE_NUMBERS) {
    if (!plan[queue]) {
      emptySeen = true;
      continue;
    }
    if (emptySeen) {
      throw new MutationError("Najprv obsadíme prvé voľné poradie zvonenia.", 409);
    }
  }
}

function assertSelfServiceFallbackBeforePersist(
  state: LoadedWorkplaceState,
  currentPlan: DispatchPriorityPlan,
  targetPlan: DispatchPriorityPlan,
) {
  if (emptyPlan(currentPlan) || samePlan(currentPlan, targetPlan)) return;
  const staffedCurrent = DISPATCH_QUEUE_NUMBERS.filter((queue) => {
    const extension = currentPlan[queue];
    return Boolean(extension && state.ownerByExtension.has(extension) && !isCanonicalFreeSeat(state, extension));
  });
  // A retained route to an audited, unregistered free chair is not a live
  // fallback. Replacing that placeholder with the first real operator improves
  // coverage and must not be blocked by the last-staffed-operator guard.
  if (staffedCurrent.length === 0) return;
  const staffedCurrentExtensions = new Set(staffedCurrent
    .map((queue) => currentPlan[queue])
    .filter((extension): extension is string => Boolean(extension)));
  const staffedTargetExtensions = new Set(Object.values(targetPlan)
    .filter((extension): extension is string => Boolean(
      extension && state.ownerByExtension.has(extension) && !isCanonicalFreeSeat(state, extension),
    )));
  // Removing empty audited chairs and compacting the exact same staffed set is
  // not a replacement. The routing saga still applies it make-before-break,
  // while the operator is no longer stranded behind a phantom priority.
  if (
    staffedCurrentExtensions.size === staffedTargetExtensions.size &&
    [...staffedCurrentExtensions].every((extension) => staffedTargetExtensions.has(extension))
  ) return;
  const unchangedFallback = DISPATCH_QUEUE_NUMBERS.some(
    (queue) => staffedCurrent.includes(queue) && currentPlan[queue] === targetPlan[queue],
  );
  if (!unchangedFallback) {
    throw new MutationError(
      "Posledného operátora ani celé aktívne poradie nemožno vymeniť alebo uvoľniť bez nezmenenej zálohy. Najprv pridaj ďalšieho operátora; pracovný stav môžeš dovtedy prepnúť na Mimo radu.",
      409,
    );
  }
}

function emptyPlan(plan: DispatchPriorityPlan) {
  return DISPATCH_QUEUE_NUMBERS.every((queue) => plan[queue] === null);
}

function samePlan(left: DispatchPriorityPlan, right: DispatchPriorityPlan) {
  return DISPATCH_QUEUE_NUMBERS.every((queue) => left[queue] === right[queue]);
}

function sameDraft(left: WorkplacePriorityDraft, right?: WorkplacePriorityDraft) {
  return Boolean(
    right &&
    left.baseRevision === right.baseRevision &&
    samePlan(left.selections, right.selections) &&
    DISPATCH_QUEUE_NUMBERS.every((queue) => left.selectedBy[queue] === right.selectedBy[queue]),
  );
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}
