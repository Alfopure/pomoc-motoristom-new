import "server-only";

import { createHash, randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  ViptelActiveCall,
  ViptelExtension,
  ViptelQueueStatus,
} from "@/lib/integrations/viptel/client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import {
  hasBlockingExtensionCommand,
  loadTerminalAcceptedBrowserTransferCallIds,
} from "@/server/telephony/command-interlock";
import {
  assignmentTransitionIsStale,
  beginAssignmentTransition,
  claimStaleWorkplaceTransitionRecovery,
  hasActiveAssignmentTransitionMetadata,
  readWorkplaceAssignmentTransition,
  releaseAssignmentTransition,
  type AssignmentTransition,
  type WorkplaceAssignmentTransition,
  type WorkplaceAssignmentTransitionPhase,
} from "@/server/telephony/assignment-interlock";
import {
  assignedLifecycle,
  lifecycleAuditPayload,
  readAssignmentLifecycle,
  requireImmutableAssignmentLifecycle,
  unassignedLifecycle,
  type AssignmentLifecycle,
} from "@/server/telephony/assignment-lifecycle";
import {
  DISPATCH_QUEUE_NUMBERS,
  parseDispatchRoutingState,
  readApplicableWorkplacePriorityDraft,
  requireAssignmentSafeDispatchRoutingState,
  type DispatchPriorityPlan,
  type DispatchQueueNumber,
} from "@/server/telephony/dispatch-routing";
import {
  assertTelephonyLiveMutationEnabled,
  assertWorkplaceAdminTakeoverEnabled,
} from "@/server/telephony/live-mutation-gate";
import { configuredPersonalExtensions } from "@/server/telephony/personal-extension-config";
import {
  requestViptelProviderSnapshot,
  type ViptelProviderSnapshot,
} from "@/server/telephony/provider-snapshot-bridge";
import { requireLatestWorkplacePriorityDraftAuthority } from "@/server/telephony/workplace-draft-authority";
import {
  assertNoActiveWorkplaceOwnerTransition,
  WORKPLACE_OWNER_TRANSITION_KEY,
} from "@/server/telephony/workplace-owner-transition";

type AdminClient = SupabaseClient<Database>;
type ExtensionRow = Pick<
  Database["public"]["Tables"]["motorist_telephony_extensions"]["Row"],
  "active" | "extension" | "id" | "metadata" | "profile_id" | "updated_at"
>;
type ProfileRow = Pick<
  Database["public"]["Tables"]["motorist_profiles"]["Row"],
  "active" | "id" | "phone_extension" | "updated_at"
>;
type RootQueue = Pick<
  Database["public"]["Tables"]["motorist_telephony_queues"]["Row"],
  "external_id" | "id" | "line_id" | "metadata" | "updated_at"
>;

const PROVIDER = "viptel";
const DRAFT_KEY = "workplacePriorityDraft";
const NON_TERMINAL_COMMAND_STATUSES = ["queued", "sent", "accepted"] as const;
const COMMAND_SCAN_LIMIT = 501;
const ROOT_TRANSITION_KEY = WORKPLACE_OWNER_TRANSITION_KEY;

type WorkplaceRootLock = {
  auditId: string;
  cleanupAuditId: string;
  extension: string;
  extensionId: string;
  generation: string;
  kind: "workplace_takeover" | "workplace_admin_release";
  initiatedBy: string;
  root: RootQueue;
  transitionId: string;
};

export type WorkplaceAdminActionDependencies = {
  client?: AdminClient;
  now?: () => string;
  randomId?: () => string;
  requestProviderSnapshot?: (
    organizationId: string,
    requestedBy: string,
  ) => Promise<Pick<ViptelProviderSnapshot, "activeCalls" | "extensions" | "queueStatuses">>;
};

export type WorkplaceAdminActionResult = {
  id: string;
  extension: string;
  profile_id: string | null;
  preservedQueue: DispatchQueueNumber | null;
  noOp?: true;
};

/**
 * Hands an idle shared VIPTel workplace directly from its previous owner to
 * the authenticated manager/admin. Queue membership never changes.
 */
export async function takeOverOccupiedWorkplace(
  actor: MotoristActor,
  requestedExtension: unknown,
  dependencies: WorkplaceAdminActionDependencies = {},
): Promise<WorkplaceAdminActionResult> {
  assertWorkplaceAdminRole(actor);
  assertTelephonyLiveMutationEnabled("workplace.takeover");
  const client = dependencies.client ?? createSupabaseAdminClient();
  const extensionNumber = readConfiguredExtension(requestedExtension);
  const now = dependencies.now ?? (() => new Date().toISOString());
  const randomId = dependencies.randomId ?? randomUUID;
  const target = await loadTargetExtension(client, actor.organizationId, extensionNumber);
  await recoverOrRejectExistingWorkplaceTransition(client, actor, target, dependencies, now);
  assertWorkplaceAdminTakeoverEnabled("workplace.takeover");

  if (!target.profile_id) {
    throw new MutationError(`Pracovné miesto ${extensionNumber} je voľné. Použi bežné priradenie miesta.`, 409);
  }
  if (target.profile_id === actor.profileId) {
    const lifecycle = await requireImmutableAssignmentLifecycle(
      client,
      actor.organizationId,
      target,
      actor.profileId,
    );
    requireWorkplaceClaimLifecycle(lifecycle, extensionNumber);
    const profile = await loadProfile(client, actor.organizationId, actor.profileId, true);
    if (profile.phone_extension !== extensionNumber) {
      throw new MutationError("Vlastníctvo pracoviska nemá zhodnú profilovú rezerváciu.", 409);
    }
    const routing = await loadRoutingContext(client, actor, target, "takeover", {
      checkCommands: false,
      cleanupDraft: false,
    });
    return {
      id: target.id,
      extension: extensionNumber,
      profile_id: actor.profileId,
      preservedQueue: routing.queue,
      noOp: true,
    };
  }
  const sourceLifecycle = await requireImmutableAssignmentLifecycle(
    client,
    actor.organizationId,
    target,
    target.profile_id,
  );
  requireWorkplaceClaimLifecycle(sourceLifecycle, extensionNumber);

  const [source, recipient] = await Promise.all([
    loadProfile(client, actor.organizationId, target.profile_id, true),
    loadProfile(client, actor.organizationId, actor.profileId, true),
  ]);
  if (source.phone_extension !== extensionNumber) {
    throw new MutationError("Rezervácia pôvodného operátora nezodpovedá pracovnému miestu.", 409);
  }
  await assertRecipientHasNoWorkplace(client, actor, recipient, target.id);

  const routing = await loadRoutingContext(client, actor, target, "takeover", { cleanupDraft: false });
  const auditId = randomId();
  let transition = await beginAssignmentTransition(
    client,
    actor,
    target,
    actor.profileId,
    {
      now,
      profileReservationPreviousExtension: recipient.phone_extension,
      randomId,
      workplaceTransition: {
        auditId,
        kind: "workplace_takeover",
        preservedQueue: routing.queue,
        previousLifecycle: sourceLifecycle,
      },
    },
  );

  let rootLock: WorkplaceRootLock | undefined;
  try {
    rootLock = await acquireWorkplaceRootLock(client, actor, routing.root, transition, "workplace_takeover", auditId, randomId());
    const lockedRouting = await loadRoutingContext(client, actor, transition.extension, "takeover", {
      cleanupDraft: true,
      rootLock,
    });
    if (lockedRouting.queue !== routing.queue) {
      throw new MutationError("Poradie pracoviska sa po uzamknutí zmenilo. Prevzatie bolo zastavené.", 409);
    }
    const [lockedSource, lockedRecipient] = await Promise.all([
      loadProfile(client, actor.organizationId, source.id, true),
      loadProfile(client, actor.organizationId, recipient.id, true),
    ]);
    if (lockedSource.phone_extension !== extensionNumber) {
      throw new MutationError("Pôvodného operátora po uzamknutí súbežne zmenila iná požiadavka.", 409);
    }
    await assertRecipientHasNoWorkplace(client, actor, lockedRecipient, target.id);
    await assertFreshWorkplaceSafety(client, actor, transition.extension, lockedRouting.queue, dependencies);

    const sourceReleased = await updateProfileReservation(
      client,
      actor.organizationId,
      lockedSource,
      extensionNumber,
      null,
      "Pôvodnému operátorovi sa nepodarilo bezpečne uvoľniť pracovisko.",
    );
    transition = await advanceTransitionPhase(client, actor, transition, "source_released");

    const targetReserved = await updateProfileReservation(
      client,
      actor.organizationId,
      lockedRecipient,
      lockedRecipient.phone_extension,
      extensionNumber,
      "Pracovné miesto sa nepodarilo rezervovať novému operátorovi.",
    );
    transition = await advanceTransitionPhase(client, actor, transition, "target_reserved");

    const nextLifecycle = assignedLifecycle({
      assignedAt: now(),
      assignedBy: actor.profileId,
      assignmentMode: "workplace_claim",
      epoch: transition.generation,
      extension: extensionNumber,
      extensionId: target.id,
      profileId: actor.profileId,
    });
    transition = await commitTakeoverOwner(
      client,
      actor,
      transition,
      sourceLifecycle,
      nextLifecycle,
      sourceReleased,
      targetReserved,
    );
    await finishCommittedTakeover(client, actor, transition, sourceLifecycle, nextLifecycle, rootLock);
    return { id: target.id, extension: extensionNumber, profile_id: actor.profileId, preservedQueue: routing.queue };
  } catch (error) {
    if (error instanceof MutationError && error.code === "WORKPLACE_TRANSITION_RECOVERY_REQUIRED" && !rootLock) {
      throw error;
    }
    const current = await loadTransitionExtension(client, actor.organizationId, target.id);
    const stored = current ? readWorkplaceAssignmentTransition(current.metadata) : undefined;
    if (
      current &&
      stored?.transitionId === transition.transitionId &&
      (current.profile_id === actor.profileId || phaseIsCommitted(stored.phase))
    ) {
      try {
        const committedLifecycle = requireStoredTakeoverLifecycle(
          current,
          actor.profileId,
          transition.generation,
          stored.initiatedBy,
        );
        if (!rootLock) rootLock = await loadExactWorkplaceRootLock(client, actor, current, stored) ?? undefined;
        await finishCommittedTakeover(
          client,
          actor,
          transitionFromRow(current, stored),
          sourceLifecycle,
          committedLifecycle,
          rootLock,
        );
        return { id: target.id, extension: extensionNumber, profile_id: actor.profileId, preservedQueue: routing.queue };
      } catch {
        throw recoveryRequired("Prevzatie dosiahlo bod zmeny vlastníka, ale nedokončilo audit alebo uvoľnenie zámku.");
      }
    }
    const rolledBack = current && stored?.transitionId === transition.transitionId
      ? await rollbackPreCommitTakeover(client, actor, current, stored, rootLock)
      : false;
    if (!rolledBack) {
      throw recoveryRequired("Prevzatie zlyhalo pred zmenou vlastníka, ale pôvodné rezervácie sa nepodarilo jednoznačne obnoviť.");
    }
    throw error;
  }
}

/** Releases an idle occupied shared workplace only when no current/draft priority references it. */
export async function releaseOccupiedWorkplace(
  actor: MotoristActor,
  requestedExtension: unknown,
  dependencies: WorkplaceAdminActionDependencies = {},
): Promise<WorkplaceAdminActionResult> {
  assertWorkplaceAdminRole(actor);
  assertTelephonyLiveMutationEnabled("workplace.release_occupied");
  const client = dependencies.client ?? createSupabaseAdminClient();
  const extensionNumber = readConfiguredExtension(requestedExtension);
  const now = dependencies.now ?? (() => new Date().toISOString());
  const randomId = dependencies.randomId ?? randomUUID;
  const target = await loadTargetExtension(client, actor.organizationId, extensionNumber);
  await recoverOrRejectExistingWorkplaceTransition(client, actor, target, dependencies, now);
  assertWorkplaceAdminTakeoverEnabled("workplace.release_occupied");
  if (!target.profile_id) {
    return { id: target.id, extension: target.extension, profile_id: null, preservedQueue: null };
  }
  if (target.profile_id === actor.profileId) {
    throw new MutationError("Vlastné pracovisko uvoľni cez svoj bežný výber pracoviska.", 409);
  }
  const sourceLifecycle = await requireImmutableAssignmentLifecycle(
    client,
    actor.organizationId,
    target,
    target.profile_id,
  );
  requireWorkplaceClaimLifecycle(sourceLifecycle, extensionNumber);
  const source = await loadProfile(client, actor.organizationId, target.profile_id, true);
  if (source.phone_extension !== extensionNumber) {
    throw new MutationError("Rezervácia operátora nezodpovedá uvoľňovanému pracovisku.", 409);
  }
  const routing = await loadRoutingContext(client, actor, target, "release", { cleanupDraft: false });
  if (routing.queue) {
    throw new MutationError("Miesto je súčasťou poradia. Prevezmi ho, aby poradie zostalo funkčné.", 409);
  }

  const auditId = randomId();
  let transition = await beginAssignmentTransition(client, actor, target, null, {
    now,
    randomId,
    workplaceTransition: {
      auditId,
      kind: "workplace_admin_release",
      preservedQueue: null,
      previousLifecycle: sourceLifecycle,
    },
  });
  let rootLock: WorkplaceRootLock | undefined;
  try {
    rootLock = await acquireWorkplaceRootLock(client, actor, routing.root, transition, "workplace_admin_release", auditId, randomId());
    const lockedRouting = await loadRoutingContext(client, actor, transition.extension, "release", {
      cleanupDraft: true,
      rootLock,
    });
    if (lockedRouting.queue) {
      throw new MutationError("Miesto je súčasťou poradia. Prevezmi ho, aby poradie zostalo funkčné.", 409);
    }
    const lockedSource = await loadProfile(client, actor.organizationId, source.id, true);
    if (lockedSource.phone_extension !== extensionNumber) {
      throw new MutationError("Operátora po uzamknutí súbežne zmenila iná požiadavka.", 409);
    }
    await assertFreshWorkplaceSafety(client, actor, transition.extension, null, dependencies);
    await updateProfileReservation(
      client,
      actor.organizationId,
      lockedSource,
      extensionNumber,
      null,
      "Rezerváciu operátora sa nepodarilo uvoľniť.",
    );
    transition = await advanceTransitionPhase(client, actor, transition, "source_released");
    const nextLifecycle: AssignmentLifecycle = {
      ...unassignedLifecycle(sourceLifecycle, { unassignedAt: now(), unassignedBy: actor.profileId }),
      // Administrative release is a new fenced ownership generation. Keeping
      // the previous epoch would make a post-owner_cleared crash impossible to
      // distinguish and therefore impossible to recover safely.
      epoch: transition.generation,
    };
    transition = await commitReleasedOwner(client, actor, transition, nextLifecycle);
    await finishCommittedRelease(client, actor, transition, sourceLifecycle, nextLifecycle, rootLock);
    return { id: target.id, extension: extensionNumber, profile_id: null, preservedQueue: null };
  } catch (error) {
    if (error instanceof MutationError && error.code === "WORKPLACE_TRANSITION_RECOVERY_REQUIRED" && !rootLock) {
      throw error;
    }
    const current = await loadTransitionExtension(client, actor.organizationId, target.id);
    const stored = current ? readWorkplaceAssignmentTransition(current.metadata) : undefined;
    if (
      current &&
      stored?.transitionId === transition.transitionId &&
      (current.profile_id === null || phaseIsCommitted(stored.phase))
    ) {
      try {
        const committedLifecycle = requireStoredReleaseLifecycle(current, transition.generation, stored.initiatedBy);
        if (!rootLock) rootLock = await loadExactWorkplaceRootLock(client, actor, current, stored) ?? undefined;
        await finishCommittedRelease(
          client,
          actor,
          transitionFromRow(current, stored),
          sourceLifecycle,
          committedLifecycle,
          rootLock,
        );
        return { id: target.id, extension: extensionNumber, profile_id: null, preservedQueue: null };
      } catch {
        throw recoveryRequired("Uvoľnenie dosiahlo bod zmeny vlastníka, ale nedokončilo audit alebo bezpečnostný zámok.");
      }
    }
    const rolledBack = current && stored?.transitionId === transition.transitionId
      ? await rollbackPreCommitRelease(client, actor, current, stored, rootLock)
      : false;
    if (!rolledBack) {
      throw recoveryRequired("Uvoľnenie zlyhalo pred zmenou vlastníka, ale pôvodnú rezerváciu sa nepodarilo obnoviť.");
    }
    throw error;
  }
}

export class WorkplaceProviderRegisteredError extends MutationError {
  constructor(readonly extension: string) {
    super(
      `Telefón na pracovnom mieste ${extension} je stále pripojený vo VIPTel.`,
      409,
      "workplace_phone_registered",
    );
  }
}

export function assertExactWorkplaceProviderState(
  extension: string,
  expectedQueue: DispatchQueueNumber | null,
  live: {
    activeCalls: ViptelActiveCall[];
    extensions: ViptelExtension[];
    queueStatuses: ViptelQueueStatus[];
  },
  options: { allowOffline?: boolean; allowPaused?: boolean; allowRegistered?: boolean } = {},
) {
  const extensions = live.extensions.filter((candidate) => exactEndpoint(candidate.extension) === extension);
  if (extensions.length !== 1) {
    throw new MutationError(`VIPTel nevrátil jednoznačný stav pracovného miesta ${extension}.`, 409);
  }
  if (extensions[0].isRegistered === true && !options.allowRegistered) {
    throw new WorkplaceProviderRegisteredError(extension);
  }
  if (extensions[0].isRegistered !== true && extensions[0].isRegistered !== false) {
    throw new MutationError(`VIPTel nevrátil jednoznačný stav registrácie pracovného miesta ${extension}.`, 409);
  }
  if (live.activeCalls.some((call) => activeCallReferencesEndpoint(call, extension))) {
    throw new MutationError(`Na pracovnom mieste ${extension} práve prebieha alebo zvoní hovor.`, 409);
  }
  const completeQueues = live.queueStatuses.length === DISPATCH_QUEUE_NUMBERS.length &&
    DISPATCH_QUEUE_NUMBERS.every(
      (queue) => live.queueStatuses.filter((status) => status.queue === queue).length === 1,
    );
  if (!completeQueues) {
    throw new MutationError("VIPTel nevrátil jednoznačný živý stav radov 601–603.", 409);
  }
  const memberships = live.queueStatuses.flatMap((status) => status.members
    .filter((member) => exactEndpoint(member.extension) === extension)
    .map((member) => ({ member, queue: status.queue })));
  if (expectedQueue === null && memberships.length !== 0) {
    throw new MutationError(`Pracovné miesto ${extension} je vo VIPTel stále členom radu.`, 409);
  }
  if (
    expectedQueue !== null &&
    !(
      (memberships.length === 1 && memberships[0].queue === expectedQueue) ||
      (options.allowOffline === true && memberships.length === 0)
    )
  ) {
    throw new MutationError(`Členstvo pracoviska ${extension} vo VIPTel nezodpovedá presne priorite ${expectedQueue}.`, 409);
  }
  if (memberships.some(({ member }) => member.inUse)) {
    throw new MutationError(`Pracovné miesto ${extension} je vo VIPTel označené ako používané.`, 409);
  }
  if (!options.allowPaused && memberships.some(({ member }) => member.paused)) {
    throw new MutationError(
      `Pracovné miesto ${extension} je vo VIPTel pozastavené. Pred prevzatím ho správca musí vrátiť do aktívneho radu.`,
      409,
    );
  }
}

/** Called by every self-service draft writer before its root-row CAS. */
export function assertWorkplacePriorityDraftWriteUnlocked(metadata: unknown) {
  assertNoActiveWorkplaceOwnerTransition(metadata);
}

async function acquireWorkplaceRootLock(
  client: AdminClient,
  actor: MotoristActor,
  root: RootQueue,
  transition: AssignmentTransition,
  kind: WorkplaceRootLock["kind"],
  auditId: string,
  cleanupAuditId: string,
): Promise<WorkplaceRootLock> {
  assertWorkplacePriorityDraftWriteUnlocked(root.metadata);
  const metadata = jsonRecord(root.metadata);
  const workplaceTransition = readWorkplaceAssignmentTransition(transition.extension.metadata);
  if (!workplaceTransition) throw recoveryRequired("Extension zámok nemá platné workplace recovery údaje.");
  const lockPayload = {
    active: true,
    auditId,
    baseMetadataDigest: sha256(metadata),
    cleanupAuditId,
    extension: transition.extension.extension,
    extensionId: transition.extension.id,
    generation: transition.generation,
    kind,
    initiatedBy: workplaceTransition.initiatedBy,
    lockedAt: workplaceTransition.startedAt,
    transitionId: transition.transitionId,
  };
  const nextMetadata = toJson({ ...metadata, [ROOT_TRANSITION_KEY]: lockPayload });
  const update = await client
    .from("motorist_telephony_queues")
    .update({ metadata: nextMetadata })
    .eq("id", root.id)
    .eq("organization_id", actor.organizationId)
    .eq("provider", PROVIDER)
    .eq("external_id", "601")
    .eq("updated_at", root.updated_at)
    .eq("active", true)
    .is("line_id", null)
    .select("id, external_id, line_id, metadata, updated_at")
    .maybeSingle();
  const expected = {
    auditId,
    cleanupAuditId,
    extension: transition.extension.extension,
    extensionId: transition.extension.id,
    generation: transition.generation,
    kind,
    initiatedBy: lockPayload.initiatedBy,
    transitionId: transition.transitionId,
  };
  let lockedRoot = update.data as RootQueue | null;
  if (update.error || !lockedRoot) {
    const readback = await client
      .from("motorist_telephony_queues")
      .select("id, external_id, line_id, metadata, updated_at")
      .eq("id", root.id)
      .eq("organization_id", actor.organizationId)
      .eq("provider", PROVIDER)
      .eq("external_id", "601")
      .eq("active", true)
      .is("line_id", null)
      .maybeSingle();
    if (readback.error || !readback.data) {
      throw recoveryRequired("Výsledok zápisu root zámku je nejednoznačný.");
    }
    const candidate = { ...expected, root: readback.data as RootQueue } satisfies WorkplaceRootLock;
    try {
      assertRootLockMatches(candidate.root, candidate);
      lockedRoot = candidate.root;
    } catch {
      throw new MutationError(
        "Poradie sa súbežne zmenilo. Prevzatie bolo zastavené bez zmeny vlastníka.",
        update.error ? 500 : 409,
      );
    }
  }
  const lock: WorkplaceRootLock = {
    ...expected,
    root: lockedRoot,
  };
  assertRootLockMatches(lock.root, lock);
  return lock;
}

async function loadExactWorkplaceRootLock(
  client: AdminClient,
  actor: MotoristActor,
  extension: ExtensionRow,
  transition: WorkplaceAssignmentTransition,
) {
  const result = await client
    .from("motorist_telephony_queues")
    .select("id, external_id, line_id, metadata, updated_at")
    .eq("organization_id", actor.organizationId)
    .eq("provider", PROVIDER)
    .eq("external_id", "601")
    .eq("active", true)
    .is("line_id", null)
    .maybeSingle();
  if (result.error || !result.data) throw recoveryRequired("Root zámok poradia sa nepodarilo načítať.");
  const payload = readRootLockPayload(result.data.metadata);
  if (!payload && jsonRecord(jsonRecord(result.data.metadata)[ROOT_TRANSITION_KEY]).active !== true) return null;
  if (
    !payload || payload.auditId !== transition.auditId || payload.extension !== extension.extension ||
    payload.extensionId !== extension.id || payload.generation !== transition.generation ||
    payload.kind !== transition.kind || payload.initiatedBy !== transition.initiatedBy
  ) throw recoveryRequired("Root zámok poradia nezodpovedá zámku pracoviska.");
  return {
    auditId: payload.auditId,
    cleanupAuditId: payload.cleanupAuditId,
    extension: payload.extension,
    extensionId: payload.extensionId,
    generation: payload.generation,
    kind: payload.kind,
    initiatedBy: payload.initiatedBy,
    root: result.data as RootQueue,
    transitionId: payload.transitionId,
  } satisfies WorkplaceRootLock;
}

async function claimWorkplaceRootRecovery(
  client: AdminClient,
  actor: MotoristActor,
  expected: WorkplaceRootLock,
  recovered: WorkplaceAssignmentTransition,
  previousTransitionId: string,
  recoveryAt: string,
) {
  const metadata = jsonRecord(expected.root.metadata);
  const payload = readRootLockPayload(metadata);
  if (!payload || payload.transitionId !== previousTransitionId) {
    throw recoveryRequired("Root zámok poradia už zotavuje iná požiadavka.");
  }
  const nextMetadata = toJson({
    ...metadata,
    [ROOT_TRANSITION_KEY]: {
      ...jsonRecord(metadata[ROOT_TRANSITION_KEY]),
      recoveredAt: recoveryAt,
      recoveredBy: actor.profileId,
      recoveryOfTransitionId: previousTransitionId,
      transitionId: recovered.transitionId,
    },
  });
  const update = await client
    .from("motorist_telephony_queues")
    .update({ metadata: nextMetadata })
    .eq("id", expected.root.id)
    .eq("organization_id", actor.organizationId)
    .eq("provider", PROVIDER)
    .eq("external_id", "601")
    .eq("updated_at", expected.root.updated_at)
    .eq("active", true)
    .is("line_id", null)
    .select("id, external_id, line_id, metadata, updated_at")
    .maybeSingle();
  if (update.error || !update.data) {
    throw recoveryRequired("Root recovery zámok poradia sa nepodarilo získať.");
  }
  const next = {
    ...expected,
    root: update.data as RootQueue,
    transitionId: recovered.transitionId,
  } satisfies WorkplaceRootLock;
  assertRootLockMatches(next.root, next);
  return next;
}

async function releaseWorkplaceRootLock(client: AdminClient, actor: MotoristActor, expected: WorkplaceRootLock) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await client
      .from("motorist_telephony_queues")
      .select("id, external_id, line_id, metadata, updated_at")
      .eq("id", expected.root.id)
      .eq("organization_id", actor.organizationId)
      .eq("provider", PROVIDER)
      .eq("external_id", "601")
      .eq("active", true)
      .is("line_id", null)
      .maybeSingle();
    if (current.error || !current.data) throw recoveryRequired("Root zámok poradia sa nepodarilo pred uvoľnením načítať.");
    const payload = readRootLockPayload(current.data.metadata);
    if (!payload) {
      if (jsonRecord(jsonRecord(current.data.metadata)[ROOT_TRANSITION_KEY]).active === true) {
        throw recoveryRequired("Aktívny root zámok poradia má neplatné recovery údaje.");
      }
      return;
    }
    assertRootLockMatches(current.data as RootQueue, expected);
    const metadata = jsonRecord(current.data.metadata);
    const nextMetadata = { ...metadata };
    delete nextMetadata[ROOT_TRANSITION_KEY];
    const release = await client
      .from("motorist_telephony_queues")
      .update({ metadata: toJson(nextMetadata) })
      .eq("id", current.data.id)
      .eq("organization_id", actor.organizationId)
      .eq("provider", PROVIDER)
      .eq("external_id", "601")
      .eq("updated_at", current.data.updated_at)
      .eq("active", true)
      .is("line_id", null)
      .select("id")
      .maybeSingle();
    if (!release.error && release.data) return;
  }
  throw recoveryRequired("Root zámok poradia zostal po zásahu aktívny.");
}

function assertRootLockMatches(root: RootQueue, expected: WorkplaceRootLock) {
  const payload = readRootLockPayload(root.metadata);
  if (
    !payload || payload.auditId !== expected.auditId || payload.cleanupAuditId !== expected.cleanupAuditId ||
    payload.extension !== expected.extension || payload.extensionId !== expected.extensionId ||
    payload.generation !== expected.generation || payload.kind !== expected.kind || payload.initiatedBy !== expected.initiatedBy ||
    payload.transitionId !== expected.transitionId
  ) throw recoveryRequired("Root zámok poradia sa súbežne zmenil alebo je neplatný.");
}

function readRootLockPayload(metadata: unknown) {
  const value = jsonRecord(jsonRecord(metadata)[ROOT_TRANSITION_KEY]);
  const kind = value.kind === "workplace_takeover" || value.kind === "workplace_admin_release" ? value.kind : undefined;
  if (
    value.active !== true || !kind || typeof value.auditId !== "string" ||
    typeof value.cleanupAuditId !== "string" || typeof value.extension !== "string" ||
    typeof value.extensionId !== "string" || typeof value.generation !== "string" || typeof value.initiatedBy !== "string" ||
    typeof value.transitionId !== "string" || typeof value.baseMetadataDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.baseMetadataDigest)
  ) return undefined;
  return {
    auditId: value.auditId,
    cleanupAuditId: value.cleanupAuditId,
    extension: value.extension,
    extensionId: value.extensionId,
    generation: value.generation,
    initiatedBy: value.initiatedBy,
    kind,
    transitionId: value.transitionId,
  };
}

async function loadRoutingContext(
  client: AdminClient,
  actor: MotoristActor,
  extension: Pick<ExtensionRow, "extension" | "id">,
  intent: "takeover" | "release",
  options: { checkCommands?: boolean; cleanupDraft: boolean; rootLock?: WorkplaceRootLock },
) {
  const result = await client
    .from("motorist_telephony_queues")
    .select("id, external_id, line_id, metadata, updated_at")
    .eq("organization_id", actor.organizationId)
    .eq("provider", PROVIDER)
    .eq("active", true)
    .is("line_id", null)
    .in("external_id", [...DISPATCH_QUEUE_NUMBERS]);
  if (result.error) throw new MutationError("Plán priorít sa nepodarilo bezpečne overiť.", 500);
  const rows = (result.data ?? []) as RootQueue[];
  if (
    rows.length !== DISPATCH_QUEUE_NUMBERS.length ||
    DISPATCH_QUEUE_NUMBERS.some((queue) => rows.filter((row) => row.external_id === queue).length !== 1)
  ) {
    throw new MutationError("Katalóg priorít 601–603 nie je úplný a jednoznačný.", 409);
  }
  const root = rows.find((row) => row.external_id === "601") as RootQueue;
  if (options.rootLock) assertRootLockMatches(root, options.rootLock);
  const state = parseDispatchRoutingState(root.metadata);
  await requireAssignmentSafeDispatchRoutingState(client, actor.organizationId, root, state);
  if (state.operation) {
    throw new MutationError("Počas zmeny poradia nemožno pracovné miesto prevziať ani uvoľniť.", 409);
  }
  const applicableDraft = readApplicableWorkplacePriorityDraft(root.metadata, state.revision, {
    organizationId: actor.organizationId,
    rootQueueId: root.id,
  });
  if (applicableDraft) {
    await requireLatestWorkplacePriorityDraftAuthority(
      client,
      jsonRecord(root.metadata)[DRAFT_KEY],
      { organizationId: actor.organizationId, rootQueueId: root.id },
    );
    if (!samePlan(applicableDraft, state.currentPlan)) {
      throw new MutationError("Rozpracovaný výber priorít sa líši od aktívneho poradia. Najprv ho dokonči alebo obnov.", 409);
    }
    if (options.cleanupDraft) {
      if (!options.rootLock) throw recoveryRequired("Vyčistenie priorít nemá aktívny root zámok.");
      await cleanupRedundantWorkplaceDraft(client, actor, root, options.rootLock);
    }
  }
  const queue = DISPATCH_QUEUE_NUMBERS.find((candidate) => state.currentPlan[candidate] === extension.extension) ?? null;
  if (intent === "release" && queue) {
    throw new MutationError("Miesto je súčasťou poradia. Prevezmi ho, aby poradie zostalo funkčné.", 409);
  }
  if (options.checkCommands !== false) {
    await assertNoPendingExtensionCommands(client, actor.organizationId, extension.id, extension.extension);
  }
  return { queue, plan: state.currentPlan, root };
}

async function cleanupRedundantWorkplaceDraft(
  client: AdminClient,
  actor: MotoristActor,
  root: RootQueue,
  rootLock: WorkplaceRootLock,
) {
  const metadata = jsonRecord(root.metadata);
  const draft = metadata[DRAFT_KEY];
  const auditPayload = {
    before: { workplace_priority_draft: draft },
    after: {
      workplace_priority_draft: null,
      reason: "owner_handoff_same_committed_plan",
    },
  };
  const insert = await client.from("motorist_audit_log").insert({
    id: rootLock.cleanupAuditId,
    organization_id: actor.organizationId,
    actor_profile_id: rootLock.initiatedBy,
    action: "telephony.workplace.priority.draft.cleanup",
    entity_type: "motorist_telephony_queues",
    entity_id: root.id,
    source: "web",
    before_payload: toJson(auditPayload.before),
    after_payload: toJson(auditPayload.after),
  });
  const audit = await client
    .from("motorist_audit_log")
    .select("id, actor_profile_id, action, entity_type, entity_id, before_payload, after_payload")
    .eq("id", rootLock.cleanupAuditId)
    .eq("organization_id", actor.organizationId)
    .maybeSingle();
  if (
    audit.error || !audit.data || audit.data.id !== rootLock.cleanupAuditId ||
    audit.data.actor_profile_id !== rootLock.initiatedBy ||
    audit.data.action !== "telephony.workplace.priority.draft.cleanup" ||
    audit.data.entity_type !== "motorist_telephony_queues" || audit.data.entity_id !== root.id ||
    stableJson(audit.data.before_payload) !== stableJson(auditPayload.before) ||
    stableJson(audit.data.after_payload) !== stableJson(auditPayload.after)
  ) {
    throw recoveryRequired(insert.error
      ? "Audit vyčistenia redundantného výberu priorít sa nepodarilo zapísať ani potvrdiť."
      : "Audit vyčistenia redundantného výberu priorít sa nezhoduje.");
  }
  const nextMetadata = { ...metadata };
  delete nextMetadata[DRAFT_KEY];
  const update = await client
    .from("motorist_telephony_queues")
    .update({ metadata: toJson(nextMetadata) })
    .eq("id", root.id)
    .eq("organization_id", actor.organizationId)
    .eq("provider", PROVIDER)
    .eq("updated_at", root.updated_at)
    .select("id, updated_at")
    .maybeSingle();
  if (!update.error && update.data) {
    return { ...root, metadata: toJson(nextMetadata), updated_at: update.data.updated_at };
  }
  // A lost response after the root CAS is ambiguous. Read the complete row
  // back and continue only when it is exactly the state this transition wrote.
  const readback = await client
    .from("motorist_telephony_queues")
    .select("id, external_id, line_id, metadata, updated_at")
    .eq("id", root.id)
    .eq("organization_id", actor.organizationId)
    .eq("provider", PROVIDER)
    .eq("external_id", "601")
    .eq("active", true)
    .is("line_id", null)
    .maybeSingle();
  if (readback.error || !readback.data || stableJson(readback.data.metadata) !== stableJson(nextMetadata)) {
    throw new MutationError("Redundantný výber priorít sa súbežne zmenil. Obnov stav.", update.error ? 500 : 409);
  }
  const recovered = readback.data as RootQueue;
  assertRootLockMatches(recovered, rootLock);
  return recovered;
}

async function assertFreshWorkplaceSafety(
  client: AdminClient,
  actor: MotoristActor,
  extension: Pick<ExtensionRow, "extension" | "id">,
  expectedQueue: DispatchQueueNumber | null,
  dependencies: WorkplaceAdminActionDependencies,
) {
  let snapshot: Pick<ViptelProviderSnapshot, "activeCalls" | "extensions" | "queueStatuses">;
  try {
    snapshot = dependencies.requestProviderSnapshot
      ? await dependencies.requestProviderSnapshot(actor.organizationId, actor.profileId)
      : await requestViptelProviderSnapshot(actor.organizationId, actor.profileId, {
          maxAgeMs: 2_000,
          requireNewCapture: true,
        });
  } catch {
    throw new MutationError("Živý stav VIPTel sa nepodarilo overiť. Pracovné miesto zostalo bez zmeny.", 502);
  }
  assertExactWorkplaceProviderState(extension.extension, expectedQueue, snapshot, { allowOffline: true });
  await assertNoPendingExtensionCommands(client, actor.organizationId, extension.id, extension.extension);
}

async function assertNoPendingExtensionCommands(
  client: AdminClient,
  organizationId: string,
  extensionId: string,
  extension: string,
) {
  const result = await client
    .from("motorist_telephony_commands")
    .select("id, call_id, command_type, extension_id, request_payload, status")
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .in("status", [...NON_TERMINAL_COMMAND_STATUSES])
    .order("created_at", { ascending: true })
    .limit(COMMAND_SCAN_LIMIT);
  if (result.error) throw new MutationError("Rozpracované telekomunikačné príkazy sa nepodarilo overiť.", 500);
  if ((result.data?.length ?? 0) >= COMMAND_SCAN_LIMIT) {
    throw new MutationError("Fronta telekomunikačných príkazov je príliš veľká na bezpečné overenie.", 409);
  }
  const terminalBrowserTransferCallIds = await loadTerminalAcceptedBrowserTransferCallIds(client, organizationId, result.data ?? []);
  if (hasBlockingExtensionCommand(result.data ?? [], extensionId, extension, { terminalBrowserTransferCallIds })) {
    throw new MutationError(`Pracovné miesto ${extension} má rozpracovaný telekomunikačný príkaz.`, 409);
  }
}

async function commitTakeoverOwner(
  client: AdminClient,
  actor: MotoristActor,
  transition: AssignmentTransition,
  previousLifecycle: AssignmentLifecycle,
  nextLifecycle: AssignmentLifecycle,
  source: ProfileRow,
  target: ProfileRow,
) {
  const metadata = metadataWithPhase(transition.extension.metadata, "owner_switched", {
    assignmentAttestation: {
      assignedAt: nextLifecycle.assignedAt,
      assignedBy: actor.profileId,
      assignedToProfileId: actor.profileId,
      mode: "workplace_claim",
    },
    assignmentLifecycle: nextLifecycle,
    assignmentQuarantine: {
      active: false,
      previousProfileId: previousLifecycle.profileId,
      releasedAt: nextLifecycle.assignedAt,
      releasedBy: actor.profileId,
      sharingMode: "workplace_claim",
    },
  });
  const update = await client
    .from("motorist_telephony_extensions")
    .update({ profile_id: actor.profileId, metadata })
    .eq("id", transition.extension.id)
    .eq("organization_id", actor.organizationId)
    .eq("provider", PROVIDER)
    .eq("updated_at", transition.extension.updated_at)
    .eq("profile_id", previousLifecycle.profileId as string)
    .eq("active", true)
    .select("id, extension, profile_id, active, metadata, updated_at")
    .maybeSingle();
  if (update.error || !update.data) {
    throw new MutationError("Vlastníka pracoviska sa nepodarilo bezpečne prepnúť.", update.error ? 500 : 409);
  }
  if (source.phone_extension !== null || target.phone_extension !== transition.extension.extension) {
    throw new MutationError("Profilové rezervácie sa pred zmenou vlastníka nepodarilo potvrdiť.", 409);
  }
  return transitionFromStoredRow(update.data, transition);
}

async function commitReleasedOwner(
  client: AdminClient,
  actor: MotoristActor,
  transition: AssignmentTransition,
  nextLifecycle: AssignmentLifecycle,
) {
  const metadata = metadataWithPhase(transition.extension.metadata, "owner_cleared", {
    assignmentLifecycle: nextLifecycle,
    assignmentQuarantine: {
      active: false,
      extension: transition.extension.extension,
      previousProfileId: transition.extension.profile_id,
      releasedAt: nextLifecycle.unassignedAt,
      releasedBy: actor.profileId,
      sharingMode: "workplace_claim",
    },
  });
  const update = await client
    .from("motorist_telephony_extensions")
    .update({ profile_id: null, metadata })
    .eq("id", transition.extension.id)
    .eq("organization_id", actor.organizationId)
    .eq("provider", PROVIDER)
    .eq("updated_at", transition.extension.updated_at)
    .eq("profile_id", transition.extension.profile_id as string)
    .eq("active", true)
    .select("id, extension, profile_id, active, metadata, updated_at")
    .maybeSingle();
  if (update.error || !update.data) {
    throw new MutationError("Vlastníka pracoviska sa nepodarilo bezpečne uvoľniť.", update.error ? 500 : 409);
  }
  return transitionFromStoredRow(update.data, transition);
}

async function finishCommittedTakeover(
  client: AdminClient,
  actor: MotoristActor,
  transition: AssignmentTransition,
  previousLifecycle: AssignmentLifecycle,
  nextLifecycle: AssignmentLifecycle,
  rootLock?: WorkplaceRootLock,
) {
  let current = await loadTransitionExtension(client, actor.organizationId, transition.extension.id);
  const targetProfileId = readWorkplaceAssignmentTransition(current?.metadata)?.toProfileId;
  if (!current || !targetProfileId || current.profile_id !== targetProfileId) {
    throw recoveryRequired("Nového vlastníka nemožno potvrdiť.");
  }
  let stored = readWorkplaceAssignmentTransition(current.metadata);
  if (!stored || stored.transitionId !== transition.transitionId || stored.kind !== "workplace_takeover") {
    throw recoveryRequired("Metadata rozpracovaného prevzatia nie sú platné.");
  }
  await ensureAssignmentAudit(client, actor, current, stored, "telephony.extension.assign", {
    before: {
      extension: current.extension,
      profile_id: previousLifecycle.profileId,
      assignment_lifecycle: lifecycleAuditPayload(previousLifecycle),
    },
    after: {
      extension: current.extension,
      profile_id: targetProfileId,
      previous_profile_id: previousLifecycle.profileId,
      preserved_queue: stored.preservedQueue,
      sharing_mode: "workplace_claim",
      assignment_lifecycle: lifecycleAuditPayload(nextLifecycle),
    },
  });
  if (stored.phase !== "audit_committed") {
    const advanced = await advanceTransitionPhase(client, actor, transitionFromRow(current, stored), "audit_committed");
    current = advanced.extension;
    stored = readWorkplaceAssignmentTransition(current.metadata);
    if (!stored) throw recoveryRequired("Auditná fáza prevzatia sa neuložila.");
  }
  if (rootLock) await releaseWorkplaceRootLock(client, actor, rootLock);
  if (!await releaseAssignmentTransition(client, actor, transitionFromRow(current, stored))) {
    throw recoveryRequired("Audit je potvrdený, ale zámok prevzatia zostal aktívny.");
  }
}

async function finishCommittedRelease(
  client: AdminClient,
  actor: MotoristActor,
  transition: AssignmentTransition,
  previousLifecycle: AssignmentLifecycle,
  nextLifecycle: AssignmentLifecycle,
  rootLock?: WorkplaceRootLock,
) {
  let current = await loadTransitionExtension(client, actor.organizationId, transition.extension.id);
  if (!current || current.profile_id !== null) throw recoveryRequired("Uvoľnené pracovisko nemožno potvrdiť.");
  let stored = readWorkplaceAssignmentTransition(current.metadata);
  if (!stored || stored.transitionId !== transition.transitionId || stored.kind !== "workplace_admin_release") {
    throw recoveryRequired("Metadata rozpracovaného uvoľnenia nie sú platné.");
  }
  await ensureAssignmentAudit(client, actor, current, stored, "telephony.extension.unassign", {
    before: {
      extension: current.extension,
      profile_id: previousLifecycle.profileId,
      assignment_lifecycle: lifecycleAuditPayload(previousLifecycle),
    },
    after: {
      extension: current.extension,
      profile_id: null,
      sharing_mode: "workplace_claim",
      assignment_lifecycle: lifecycleAuditPayload(nextLifecycle),
    },
  });
  if (stored.phase !== "audit_committed") {
    const advanced = await advanceTransitionPhase(client, actor, transitionFromRow(current, stored), "audit_committed");
    current = advanced.extension;
    stored = readWorkplaceAssignmentTransition(current.metadata);
    if (!stored) throw recoveryRequired("Auditná fáza uvoľnenia sa neuložila.");
  }
  if (rootLock) await releaseWorkplaceRootLock(client, actor, rootLock);
  if (!await releaseAssignmentTransition(client, actor, transitionFromRow(current, stored))) {
    throw recoveryRequired("Audit je potvrdený, ale zámok uvoľnenia zostal aktívny.");
  }
}

async function ensureAssignmentAudit(
  client: AdminClient,
  actor: MotoristActor,
  extension: ExtensionRow,
  transition: WorkplaceAssignmentTransition,
  action: "telephony.extension.assign" | "telephony.extension.unassign",
  payload: { before: unknown; after: unknown },
) {
  const insert = await client.from("motorist_audit_log").insert({
    id: transition.auditId,
    organization_id: actor.organizationId,
    actor_profile_id: transition.initiatedBy,
    action,
    entity_type: "motorist_telephony_extensions",
    entity_id: extension.id,
    source: "web",
    before_payload: toJson(payload.before),
    after_payload: toJson(payload.after),
  });
  const readback = await client
    .from("motorist_audit_log")
    .select("id, actor_profile_id, action, entity_type, entity_id, before_payload, after_payload")
    .eq("id", transition.auditId)
    .eq("organization_id", actor.organizationId)
    .maybeSingle();
  if (
    readback.error ||
    !readback.data ||
    readback.data.id !== transition.auditId ||
    readback.data.actor_profile_id !== transition.initiatedBy ||
    readback.data.action !== action ||
    readback.data.entity_type !== "motorist_telephony_extensions" ||
    readback.data.entity_id !== extension.id ||
    stableJson(readback.data.before_payload) !== stableJson(payload.before) ||
    stableJson(readback.data.after_payload) !== stableJson(payload.after)
  ) {
    throw recoveryRequired(
      insert.error
        ? "Nemenný audit zmeny vlastníka sa nepodarilo zapísať ani potvrdiť."
        : "Nemenný audit zmeny vlastníka sa po zápise nezhoduje.",
    );
  }
}

async function advanceTransitionPhase(
  client: AdminClient,
  actor: MotoristActor,
  transition: AssignmentTransition,
  phase: WorkplaceAssignmentTransitionPhase,
) {
  const metadata = metadataWithPhase(transition.extension.metadata, phase);
  let query = client
    .from("motorist_telephony_extensions")
    .update({ metadata })
    .eq("id", transition.extension.id)
    .eq("organization_id", actor.organizationId)
    .eq("provider", PROVIDER)
    .eq("updated_at", transition.extension.updated_at)
    .eq("active", true);
  query = transition.extension.profile_id === null
    ? query.is("profile_id", null)
    : query.eq("profile_id", transition.extension.profile_id);
  const update = await query
    .select("id, extension, profile_id, active, metadata, updated_at")
    .maybeSingle();
  if (update.error || !update.data) {
    throw new MutationError("Fázu bezpečnej zmeny pracoviska sa nepodarilo uložiť.", update.error ? 500 : 409);
  }
  return transitionFromStoredRow(update.data, transition);
}

function metadataWithPhase(metadata: unknown, phase: WorkplaceAssignmentTransitionPhase, additions = {}) {
  const root = jsonRecord(metadata);
  const transition = jsonRecord(root.assignmentTransition);
  return toJson({
    ...root,
    ...additions,
    assignmentTransition: { ...transition, phase },
  });
}

async function rollbackPreCommitTakeover(
  client: AdminClient,
  actor: MotoristActor,
  extension: ExtensionRow,
  transition: WorkplaceAssignmentTransition,
  rootLock?: WorkplaceRootLock,
) {
  if (!transition.fromProfileId || !transition.toProfileId || extension.profile_id !== transition.fromProfileId) return false;
  const [source, target] = await Promise.all([
    loadProfile(client, actor.organizationId, transition.fromProfileId, false),
    loadProfile(client, actor.organizationId, transition.toProfileId, false),
  ]);
  let targetCurrent = target;
  if (target.phone_extension === extension.extension) {
    targetCurrent = await updateProfileReservation(
      client,
      actor.organizationId,
      target,
      extension.extension,
      transition.profileReservationPreviousExtension,
      "Cieľovú rezerváciu sa pri obnove nepodarilo vrátiť.",
    );
  } else if (target.phone_extension !== transition.profileReservationPreviousExtension) {
    return false;
  }
  let sourceCurrent = source;
  if (source.phone_extension === null) {
    sourceCurrent = await updateProfileReservation(
      client,
      actor.organizationId,
      source,
      null,
      extension.extension,
      "Pôvodnú rezerváciu sa pri obnove nepodarilo vrátiť.",
    );
  } else if (source.phone_extension !== extension.extension) {
    return false;
  }
  void targetCurrent;
  void sourceCurrent;
  if (rootLock) await releaseWorkplaceRootLock(client, actor, rootLock);
  return releaseAssignmentTransition(client, actor, transitionFromRow(extension, transition));
}

async function rollbackPreCommitRelease(
  client: AdminClient,
  actor: MotoristActor,
  extension: ExtensionRow,
  transition: WorkplaceAssignmentTransition,
  rootLock?: WorkplaceRootLock,
) {
  if (!transition.fromProfileId || extension.profile_id !== transition.fromProfileId) return false;
  const source = await loadProfile(client, actor.organizationId, transition.fromProfileId, false);
  if (source.phone_extension === null) {
    await updateProfileReservation(
      client,
      actor.organizationId,
      source,
      null,
      extension.extension,
      "Pôvodnú rezerváciu sa pri obnove nepodarilo vrátiť.",
    );
  } else if (source.phone_extension !== extension.extension) {
    return false;
  }
  if (rootLock) await releaseWorkplaceRootLock(client, actor, rootLock);
  return releaseAssignmentTransition(client, actor, transitionFromRow(extension, transition));
}

async function recoverOrRejectExistingWorkplaceTransition(
  client: AdminClient,
  actor: MotoristActor,
  extension: ExtensionRow,
  dependencies: WorkplaceAdminActionDependencies,
  now: () => string,
) {
  if (!hasActiveAssignmentTransitionMetadata(extension.metadata)) return;
  const transition = readWorkplaceAssignmentTransition(extension.metadata);
  if (!transition) {
    throw recoveryRequired("Aktívny zámok pracoviska má neplatné recovery údaje.");
  }
  if (!assignmentTransitionIsStale(extension.metadata, now())) {
    throw new MutationError("Na pracovnom mieste ešte prebieha bezpečná zmena. Počkaj a obnov stav.", 409);
  }
  assertPreviousLifecycleMatchesTransition(extension, transition);
  const existingRootLock = await loadExactWorkplaceRootLock(client, actor, extension, transition);
  const recovery = await claimStaleWorkplaceTransitionRecovery(client, actor, extension, {
    now,
    randomId: dependencies.randomId,
  });
  const recoveredExtension = recovery.transition.extension;
  const recoveredTransition = recovery.workplaceTransition;
  const rootLock = existingRootLock
    ? await claimWorkplaceRootRecovery(
        client,
        actor,
        existingRootLock,
        recoveredTransition,
        existingRootLock.transitionId,
        recovery.recoveryAt,
      )
    : undefined;
  if (recoveredTransition.kind === "workplace_takeover") {
    if (recoveredExtension.profile_id === recoveredTransition.toProfileId && phaseIsCommitted(recoveredTransition.phase)) {
      if (rootLock) {
        await loadRoutingContext(client, actor, recoveredExtension, "takeover", { cleanupDraft: true, rootLock });
      } else if (recoveredTransition.phase !== "audit_committed") {
        throw recoveryRequired("Root zámok zmizol pred potvrdením auditu prevzatia.");
      }
      const nextLifecycle = requireStoredTakeoverLifecycle(
        recoveredExtension,
        recoveredTransition.toProfileId as string,
        recoveredTransition.generation,
        recoveredTransition.initiatedBy,
      );
      await finishCommittedTakeover(
        client,
        actor,
        recovery.transition,
        recoveredTransition.previousLifecycle,
        nextLifecycle,
        rootLock,
      );
    } else if (!await rollbackPreCommitTakeover(
      client,
      actor,
      recoveredExtension,
      recoveredTransition,
      rootLock,
    )) {
      throw recoveryRequired("Prerušené prevzatie sa nepodarilo bezpečne vrátiť.");
    }
  } else if (recoveredExtension.profile_id === null && phaseIsCommitted(recoveredTransition.phase)) {
    if (!rootLock && recoveredTransition.phase !== "audit_committed") {
      throw recoveryRequired("Root zámok zmizol pred potvrdením auditu uvoľnenia.");
    }
    const nextLifecycle = requireStoredReleaseLifecycle(
      recoveredExtension,
      recoveredTransition.generation,
      recoveredTransition.initiatedBy,
    );
    await finishCommittedRelease(
      client,
      actor,
      recovery.transition,
      recoveredTransition.previousLifecycle,
      nextLifecycle,
      rootLock,
    );
  } else if (!await rollbackPreCommitRelease(
    client,
    actor,
    recoveredExtension,
    recoveredTransition,
    rootLock,
  )) {
    throw recoveryRequired("Prerušené uvoľnenie sa nepodarilo bezpečne vrátiť.");
  }
  throw new MutationError("Prerušená zmena pracoviska bola bezpečne obnovená. Obnov stav a akciu zopakuj.", 409);
}

function requireStoredTakeoverLifecycle(
  extension: ExtensionRow,
  profileId: string,
  generation: string,
  initiatedBy: string,
) {
  const lifecycle = readAssignmentLifecycle(jsonRecord(extension.metadata).assignmentLifecycle);
  if (
    !lifecycle || lifecycle.state !== "assigned" || lifecycle.assignmentMode !== "workplace_claim" ||
    lifecycle.profileId !== profileId || lifecycle.epoch !== generation || lifecycle.extensionId !== extension.id ||
    lifecycle.extension !== extension.extension || lifecycle.assignedBy !== initiatedBy
  ) throw recoveryRequired("Uložený lifecycle prevzatého pracoviska nie je jednoznačný.");
  return lifecycle;
}

function assertPreviousLifecycleMatchesTransition(
  extension: ExtensionRow,
  transition: WorkplaceAssignmentTransition,
) {
  const lifecycle = transition.previousLifecycle;
  if (
    lifecycle.state !== "assigned" || lifecycle.assignmentMode !== "workplace_claim" ||
    lifecycle.extensionId !== extension.id || lifecycle.extension !== extension.extension ||
    lifecycle.profileId !== transition.fromProfileId
  ) throw recoveryRequired("Pôvodný lifecycle v recovery zámku nezodpovedá pracovnému miestu.");
}

function requireStoredReleaseLifecycle(extension: ExtensionRow, generation: string, initiatedBy: string) {
  const lifecycle = readAssignmentLifecycle(jsonRecord(extension.metadata).assignmentLifecycle);
  if (
    !lifecycle || lifecycle.state !== "unassigned" || lifecycle.assignmentMode !== "workplace_claim" ||
    lifecycle.profileId !== null || lifecycle.epoch !== generation || lifecycle.extensionId !== extension.id ||
    lifecycle.extension !== extension.extension || lifecycle.unassignedBy !== initiatedBy
  ) throw recoveryRequired("Uložený lifecycle uvoľneného pracoviska nie je jednoznačný.");
  return lifecycle;
}

async function loadTargetExtension(client: AdminClient, organizationId: string, extension: string) {
  const result = await client
    .from("motorist_telephony_extensions")
    .select("id, extension, profile_id, active, metadata, updated_at")
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .eq("extension", extension)
    .eq("active", true)
    .maybeSingle();
  if (result.error) throw new MutationError("Pracovné miesto sa nepodarilo načítať.", 500);
  if (!result.data) throw new MutationError(`Pracovné miesto ${extension} nie je aktívne.`, 404);
  return result.data as ExtensionRow;
}

async function loadTransitionExtension(client: AdminClient, organizationId: string, id: string) {
  const result = await client
    .from("motorist_telephony_extensions")
    .select("id, extension, profile_id, active, metadata, updated_at")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .maybeSingle();
  return !result.error && result.data ? result.data as ExtensionRow : undefined;
}

async function loadProfile(client: AdminClient, organizationId: string, id: string, activeOnly: boolean) {
  let query = client
    .from("motorist_profiles")
    .select("id, phone_extension, active, updated_at")
    .eq("id", id)
    .eq("organization_id", organizationId);
  if (activeOnly) query = query.eq("active", true);
  const result = await query.maybeSingle();
  if (result.error) throw new MutationError("Profil operátora sa nepodarilo overiť.", 500);
  if (!result.data || (activeOnly && !result.data.active)) {
    throw new MutationError("Aktívny profil operátora sa nenašiel.", 404);
  }
  return result.data as ProfileRow;
}

async function assertRecipientHasNoWorkplace(
  client: AdminClient,
  actor: MotoristActor,
  profile: ProfileRow,
  targetExtensionId: string,
) {
  if (profile.phone_extension !== null) {
    throw new MutationError(`Najprv uvoľni svoje pracovné miesto ${profile.phone_extension}.`, 409);
  }
  const result = await client
    .from("motorist_telephony_extensions")
    .select("id, extension")
    .eq("organization_id", actor.organizationId)
    .eq("provider", PROVIDER)
    .eq("profile_id", actor.profileId)
    .eq("active", true)
    .neq("id", targetExtensionId)
    .limit(1)
    .maybeSingle();
  if (result.error) throw new MutationError("Existujúce pracovisko správcu sa nepodarilo overiť.", 500);
  if (result.data) throw new MutationError(`Najprv uvoľni svoje pracovné miesto ${result.data.extension}.`, 409);
}

async function updateProfileReservation(
  client: AdminClient,
  organizationId: string,
  profile: ProfileRow,
  expected: string | null,
  next: string | null,
  errorMessage: string,
) {
  let query = client
    .from("motorist_profiles")
    .update({ phone_extension: next })
    .eq("id", profile.id)
    .eq("organization_id", organizationId)
    .eq("updated_at", profile.updated_at)
    .eq("active", profile.active);
  query = expected === null ? query.is("phone_extension", null) : query.eq("phone_extension", expected);
  const result = await query.select("id, phone_extension, active, updated_at").maybeSingle();
  if (result.error || !result.data) {
    throw new MutationError(errorMessage, result.error ? 500 : 409);
  }
  return result.data as ProfileRow;
}

function transitionFromStoredRow(row: ExtensionRow, transition: AssignmentTransition): AssignmentTransition {
  const parsed = readWorkplaceAssignmentTransition(row.metadata);
  if (!parsed || parsed.transitionId !== transition.transitionId || parsed.generation !== transition.generation) {
    throw recoveryRequired("Fáza zmeny pracoviska nezodpovedá aktívnemu zámku.");
  }
  return { extension: row, generation: transition.generation, transitionId: transition.transitionId };
}

function transitionFromRow(row: ExtensionRow, transition: WorkplaceAssignmentTransition): AssignmentTransition {
  return { extension: row, generation: transition.generation, transitionId: transition.transitionId };
}

function assertWorkplaceAdminRole(actor: MotoristActor) {
  if (actor.role !== "admin" && actor.role !== "manager") {
    throw new MutationError("Pracovné miesto iného operátora môže spravovať iba administrátor alebo manažér.", 403);
  }
}

function requireWorkplaceClaimLifecycle(lifecycle: AssignmentLifecycle, extension: string) {
  if (lifecycle.assignmentMode !== "workplace_claim") {
    throw new MutationError(
      `Pracovné miesto ${extension} nepoužíva zdieľaný lifecycle workplace_claim. Vyžaduje servisné odovzdanie so zmenou SIP prístupu.`,
      409,
    );
  }
}

function readConfiguredExtension(value: unknown) {
  const extension = typeof value === "string" ? value.trim() : "";
  if (!configuredPersonalExtensions().includes(extension)) {
    throw new MutationError("Vyber platné pracovné miesto.", 400);
  }
  return extension;
}

function phaseIsCommitted(phase: WorkplaceAssignmentTransitionPhase) {
  return phase === "owner_switched" || phase === "owner_cleared" || phase === "audit_committed";
}

function activeCallReferencesEndpoint(call: ViptelActiveCall, extension: string) {
  if (["ended", "failed", "missed", "abandoned_queue"].includes(call.status)) return false;
  return [
    call.callerExtension,
    call.receivedExtension,
    call.destinationExtension,
    call.callerNumber,
    call.calledNumber,
  ].some((candidate) => exactEndpoint(candidate) === extension);
}

function exactEndpoint(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/^sip:/i, "").split("@")[0];
  return /^\d{1,20}$/.test(normalized) ? normalized : undefined;
}

function samePlan(left: DispatchPriorityPlan, right: DispatchPriorityPlan) {
  return DISPATCH_QUEUE_NUMBERS.every((queue) => left[queue] === right[queue]);
}

function stableJson(value: unknown) {
  return JSON.stringify(sortJson(value));
}

function sha256(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, sortJson(item)]));
}

function recoveryRequired(message: string) {
  return new MutationError(`${message} Pracovné miesto nepoužívaj a spusti bezpečné zotavenie.`, 409, "WORKPLACE_TRANSITION_RECOVERY_REQUIRED");
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}
