import "server-only";

import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database, Json } from "@/lib/supabase/database.types";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import {
  assertSystemFallbackRedirectAuthorized,
  isSystemFallbackRedirectPayload,
} from "./fallback-settings";
import {
  isConfiguredPersonalExtension,
  isLegacySeededProfileExtension,
} from "./personal-extension-config";
import { assertTelephonyLiveMutationEnabled } from "./live-mutation-gate";
import {
  readAssignmentLifecycle,
  requireImmutableAssignmentLifecycle,
  requireImmutableWorkplaceSeatLifecycle,
  type AssignmentLifecycle,
} from "./assignment-lifecycle";
import {
  requireActiveWorkplaceLease,
  type WorkplaceLeaseFence,
} from "@/server/telephony-access";
import { workplaceHotdeskCapability } from "./workplace-capability";
import { loadBootstrappedWorkplaceExtensions } from "./workplace-runtime-state";
import { loadTerminalAcceptedBrowserTransferCallIds } from "./command-interlock";

type AdminClient = SupabaseClient<Database>;
type ExtensionRow = Database["public"]["Tables"]["motorist_telephony_extensions"]["Row"];
type GuardedExtensionRow = Pick<
  ExtensionRow,
  "active" | "extension" | "id" | "metadata" | "profile_id" | "updated_at"
>;
type GuardedReleaseExtensionRow = GuardedExtensionRow & Pick<ExtensionRow, "workplace_seat_generation">;

const PROVIDER = "viptel";
const GENERATION_KEY = "assignmentGeneration";
const TRANSITION_KEY = "assignmentTransition";
const ACTION_CLAIM_KEY = "assignmentActionClaim";
export const ASSIGNMENT_ACTION_CLAIM_GRACE_MS = 120_000;
export const ASSIGNMENT_TRANSITION_LEASE_MS = 5 * 60_000;
export const ROUTING_ORPHAN_CLAIM_LEASE_MS = 120_000;
const ASSIGNMENT_ACTION_CLAIM_MAX_ATTEMPTS = 2;
const ASSIGNMENT_ACTION_RELEASE_MAX_ATTEMPTS = 2;

export type TelephonyAssignmentGuard = {
  claimId: string;
  extension: string;
  extensionId: string;
  generation: string;
  lifecycleEpoch: string;
  profileId: string | null;
  routingOperationId?: string;
  workplaceSeatGeneration?: string;
};

export type ExtensionActionKind =
  | "call.create"
  | "call.hangup"
  | "call.redirect"
  | "call.transfer.dtmf"
  | "call.transfer.sip_refer"
  | "dispatch.routing.apply"
  | "dispatch.routing.bootstrap_empty"
  | "dispatch.routing.recover"
  | "queue.availability"
  | "webphone.session.issue";

export type AssignmentTransition = {
  generation: string;
  transitionId: string;
  extension: GuardedExtensionRow;
};

export type WorkplaceAssignmentTransitionKind = "workplace_takeover" | "workplace_admin_release";
export type WorkplaceAssignmentTransitionPhase =
  | "locked"
  | "source_released"
  | "target_reserved"
  | "owner_switched"
  | "owner_cleared"
  | "audit_committed";

export type WorkplaceAssignmentTransition = ReturnType<typeof readAssignmentTransition> & {
  auditId: string;
  kind: WorkplaceAssignmentTransitionKind;
  phase: WorkplaceAssignmentTransitionPhase;
  preservedQueue: "601" | "602" | "603" | null;
  previousLifecycle: AssignmentLifecycle;
};

export class AssignmentInterlockRejected extends Error {}

/**
 * Claims the extension row with an updated_at CAS before a browser credential
 * or call action can be authorized. An assignment transition uses the same
 * CAS, so exactly one side can win a race without a schema change.
 */
export async function claimOwnedExtensionAction(
  actor: MotoristActor,
  extensionId: string,
  action: ExtensionActionKind,
  dependencies: {
    allowExactRoutingWebphoneSession?: boolean;
    client?: AdminClient;
    leaseFence?: WorkplaceLeaseFence;
    now?: () => string;
    randomId?: () => string;
  } = {},
) {
  assertTelephonyLiveMutationEnabled(action);
  const client = dependencies.client ?? createSupabaseAdminClient();
  const now = dependencies.now ?? (() => new Date().toISOString());
  const randomId = dependencies.randomId ?? randomUUID;
  let retryBaseline: GuardedExtensionRow | undefined;

  for (let attempt = 1; attempt <= ASSIGNMENT_ACTION_CLAIM_MAX_ATTEMPTS; attempt += 1) {
    const current = await client
      .from("motorist_telephony_extensions")
      .select("id, extension, profile_id, active, metadata, updated_at")
      .eq("id", extensionId)
      .eq("organization_id", actor.organizationId)
      .eq("provider", PROVIDER)
      .eq("profile_id", actor.profileId)
      .eq("active", true)
      .maybeSingle();

    if (current.error) {
      throw new MutationError("Vlastníctvo osobnej klapky sa nepodarilo bezpečne overiť.", 500);
    }
    if (!current.data) {
      if (retryBaseline) throw concurrentAssignmentMutation();
      throw new MutationError("Osobná klapka už nepatrí prihlásenému operátorovi.", 403);
    }
    if (!isConfiguredPersonalExtension(current.data.extension)) {
      if (retryBaseline) throw concurrentAssignmentMutation();
      throw new MutationError("Osobná klapka už nepatrí prihlásenému operátorovi.", 403);
    }
    if (retryBaseline && !isProviderOnlyAssignmentRowDrift(retryBaseline, current.data)) {
      throw concurrentAssignmentMutation();
    }

    const lifecycle = await requireImmutableAssignmentLifecycle(client, actor.organizationId, current.data, actor.profileId);
    await requireActiveWorkplaceLease(actor, current.data, dependencies.leaseFence, {
      assignmentLifecycle: lifecycle,
      client,
      requireFence: true,
    });

    const metadata = jsonRecord(current.data.metadata);
    if (hasActiveAssignmentTransition(metadata)) {
      throw new MutationError("Na osobnej klapke práve prebieha zmena priradenia. Obnov stav a skús to neskôr.", 409);
    }
    const claimedAt = now();
    const existingClaim = readActionClaim(metadata);
    if (existingClaim?.action.startsWith("dispatch.routing.")) {
      const routingClaim = await inspectRoutingClaim(
        client,
        actor.organizationId,
        current.data,
        existingClaim,
        claimedAt,
      );
      if (
        action === "webphone.session.issue" && dependencies.allowExactRoutingWebphoneSession === true &&
        dependencies.leaseFence !== undefined &&
        routingClaim.guard && routingClaim.operation &&
        selfServiceRoutingOperationAllowsWebphone(actor, current.data.extension, routingClaim.operation)
      ) {
        // The routing claim remains the sole extension-row interlock. Replacing
        // or releasing it here would let a browser restart corrupt the routing
        // operation. The active exact lease was verified above; revalidation
        // below binds the borrowed guard to the current row and lifecycle.
        try {
          await revalidateExtensionAssignmentGuard(client, actor.organizationId, routingClaim.guard);
        } catch {
          throw new MutationError(
            "Routing rezervácia pracovného miesta sa medzitým zmenila. Telefón zostal bezpečne odpojený.",
            409,
            "routing_webphone_guard_changed",
          );
        }
        return {
          ...current.data,
          assignmentGuard: routingClaim.guard,
          releaseAssignmentGuard: false as const,
        };
      }
      if (action === "webphone.session.issue" && dependencies.allowExactRoutingWebphoneSession === true) {
        throw new MutationError(
          "Osobnú klapku rezervuje iná alebo neúplná zmena poradia. Telefón zostal bezpečne odpojený.",
          409,
          "routing_webphone_guard_mismatch",
        );
      }
      if (routingClaim.blocks) {
        throw new MutationError("Osobnú klapku práve rezervuje zmena poradia radov. Akcia bola zastavená.", 409);
      }
    }

    const generation = readGeneration(metadata[GENERATION_KEY]) ?? randomId();
    const claimId = randomId();
    const nextMetadata = toJson({
      ...metadata,
      [GENERATION_KEY]: generation,
      [ACTION_CLAIM_KEY]: {
        action,
        claimId,
        claimedAt,
        generation,
        lifecycleEpoch: lifecycle.epoch,
        profileId: actor.profileId,
      },
    });
    const claimed = await client
      .from("motorist_telephony_extensions")
      .update({ metadata: nextMetadata })
      .eq("id", current.data.id)
      .eq("organization_id", actor.organizationId)
      .eq("provider", PROVIDER)
      .eq("updated_at", current.data.updated_at)
      .eq("profile_id", actor.profileId)
      .eq("active", true)
      .select("id, extension, profile_id, active, metadata, updated_at")
      .maybeSingle();

    if (claimed.error) {
      throw new MutationError("Bezpečnostný interlock osobnej klapky sa nepodarilo uložiť.", 500);
    }
    if (!claimed.data) {
      if (attempt === ASSIGNMENT_ACTION_CLAIM_MAX_ATTEMPTS) throw concurrentAssignmentMutation();
      retryBaseline = current.data;
      continue;
    }
    const storedMetadata = jsonRecord(claimed.data.metadata);
    const storedClaim = readActionClaim(storedMetadata);
    if (
      claimed.data.id !== current.data.id ||
      claimed.data.extension !== current.data.extension ||
      claimed.data.profile_id !== actor.profileId ||
      readGeneration(storedMetadata[GENERATION_KEY]) !== generation ||
      storedClaim?.claimId !== claimId
    ) {
      throw new MutationError("Uložený bezpečnostný interlock osobnej klapky sa nepodarilo potvrdiť.", 500);
    }

    if (dependencies.leaseFence) {
      await assertNoWorkplaceResourceClaimAfterAction(
        client,
        actor.organizationId,
        {
          claimId,
          extension: claimed.data.extension,
          extensionId: claimed.data.id,
          generation,
          lifecycleEpoch: lifecycle.epoch,
          profileId: actor.profileId,
        },
      );
    }

    return {
      ...claimed.data,
      releaseAssignmentGuard: true as const,
      assignmentGuard: {
        claimId,
        extension: claimed.data.extension,
        extensionId: claimed.data.id,
        generation,
        lifecycleEpoch: lifecycle.epoch,
        profileId: actor.profileId,
      } satisfies TelephonyAssignmentGuard,
    };
  }

  throw concurrentAssignmentMutation();
}

function concurrentAssignmentMutation() {
  return new MutationError("Priradenie klapky sa súbežne zmenilo. Akcia bola bezpečne zastavená.", 409);
}

function isProviderOnlyAssignmentRowDrift(previous: GuardedExtensionRow, current: GuardedExtensionRow) {
  return previous.updated_at !== current.updated_at &&
    previous.id === current.id &&
    previous.extension === current.extension &&
    previous.profile_id === current.profile_id &&
    previous.active === current.active &&
    jsonValuesEqual(previous.metadata, current.metadata);
}

/**
 * Closes the action-claim/workplace-claim interleaving: an operation acquired
 * the shared extension resource before this read, or its begin RPC will later
 * observe the action metadata claim. Both orders cannot proceed together.
 */
export async function assertNoWorkplaceResourceClaimAfterAction(
  client: AdminClient,
  organizationId: string,
  guard: TelephonyAssignmentGuard,
) {
  const resource = await client
    .from("motorist_workplace_resource_claims")
    .select("operation_id, claim_generation")
    .eq("organization_id", organizationId)
    .eq("resource_type", "extension")
    .eq("resource_id", guard.extensionId)
    .maybeSingle();
  if (resource.error) {
    await releaseExtensionAssignmentGuard(client, organizationId, guard);
    throw new MutationError("Spoločný zámok pracoviska sa nepodarilo overiť; telefonická akcia bola zrušená.", 500);
  }
  if (resource.data?.operation_id) {
    await releaseExtensionAssignmentGuard(client, organizationId, guard);
    throw new MutationError("Pracovné miesto práve mení vlastníka. Telefonická akcia bola bezpečne zrušená.", 409, "lease_transitioning");
  }
}

/** Starts a fail-closed assignment transition on the same CAS used by actions. */
export async function beginAssignmentTransition(
  client: AdminClient,
  actor: MotoristActor,
  extension: Pick<GuardedExtensionRow, "active" | "extension" | "id" | "metadata" | "profile_id" | "updated_at">,
  nextProfileId: string | null,
  dependencies: {
    now?: () => string;
    profileReservationPreviousExtension?: string | null;
    randomId?: () => string;
    workplaceTransition?: {
      auditId: string;
      kind: WorkplaceAssignmentTransitionKind;
      preservedQueue: "601" | "602" | "603" | null;
      previousLifecycle: AssignmentLifecycle;
    };
  } = {},
): Promise<AssignmentTransition> {
  const metadata = jsonRecord(extension.metadata);
  if (hasActiveAssignmentTransition(metadata)) {
    throw new MutationError("Na osobnej klapke už prebieha zmena priradenia. Obnov stav.", 409);
  }
  const randomId = dependencies.randomId ?? randomUUID;
  const transitionId = randomId();
  const generation = randomId();
  const startedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  const existingClaim = readActionClaim(metadata);
  const routingClaimBlocks = existingClaim?.action.startsWith("dispatch.routing.")
    ? await routingClaimBlocksTakeover(client, actor.organizationId, extension, existingClaim, startedAt)
    : false;
  if (routingClaimBlocks || readRecentActionClaim(metadata, startedAt)) {
    throw new MutationError(
      "Osobná klapka bola práve autorizovaná pre browser alebo telefonickú akciu. Počkaj na dokončenie bezpečnostnej lehoty a obnov živý stav.",
      409,
    );
  }
  const nextMetadata = toJson({
    ...metadata,
    [GENERATION_KEY]: generation,
    [TRANSITION_KEY]: {
      active: true,
      fromProfileId: extension.profile_id,
      generation,
      initiatedBy: actor.profileId,
      ...(nextProfileId !== null
        ? { profileReservationPreviousExtension: dependencies.profileReservationPreviousExtension ?? null }
        : {}),
      startedAt,
      toProfileId: nextProfileId,
      transitionId,
      ...(dependencies.workplaceTransition
        ? {
            auditId: dependencies.workplaceTransition.auditId,
            kind: dependencies.workplaceTransition.kind,
            phase: "locked",
            preservedQueue: dependencies.workplaceTransition.preservedQueue,
            previousLifecycle: dependencies.workplaceTransition.previousLifecycle,
          }
        : {}),
    },
  });
  return assignmentTransitionQuery(client, actor, extension, nextMetadata, transitionId, generation);
}

async function assignmentTransitionQuery(
  client: AdminClient,
  actor: MotoristActor,
  extension: Pick<GuardedExtensionRow, "active" | "extension" | "id" | "metadata" | "profile_id" | "updated_at">,
  nextMetadata: Json,
  transitionId: string,
  generation: string,
): Promise<AssignmentTransition> {
  let query = client
    .from("motorist_telephony_extensions")
    .update({ metadata: nextMetadata })
    .eq("id", extension.id)
    .eq("organization_id", actor.organizationId)
    .eq("provider", PROVIDER)
    .eq("updated_at", extension.updated_at)
    .eq("active", true);
  query = extension.profile_id === null
    ? query.is("profile_id", null)
    : query.eq("profile_id", extension.profile_id);
  const locked = await query
    .select("id, extension, profile_id, active, metadata, updated_at")
    .maybeSingle();
  if (locked.error) {
    throw new MutationError("Bezpečnostný interlock zmeny priradenia sa nepodarilo uložiť.", 500);
  }
  if (!locked.data) {
    throw new MutationError("Klapku súbežne použil operátor alebo zmenila iná požiadavka. Zmena bola zastavená.", 409);
  }
  const storedMetadata = jsonRecord(locked.data.metadata);
  if (
    locked.data.id !== extension.id ||
    locked.data.extension !== extension.extension ||
    locked.data.profile_id !== extension.profile_id ||
    readGeneration(storedMetadata[GENERATION_KEY]) !== generation ||
    readTransitionId(storedMetadata) !== transitionId
  ) {
    throw new MutationError("Uložený interlock zmeny priradenia sa nepodarilo potvrdiť.", 500);
  }
  return { extension: locked.data, generation, transitionId };
}

/**
 * Releases only the exact failed transition. The generation intentionally
 * remains advanced so every command authorized before the attempt stays stale.
 */
export async function releaseAssignmentTransition(
  client: AdminClient,
  actor: MotoristActor,
  transition: AssignmentTransition,
) {
  const first = await attemptAssignmentTransitionRelease(client, actor, transition);
  if (first === "released" || first === "already_released") return true;
  const refreshed = await readExactAssignmentTransition(client, actor.organizationId, transition);
  if (refreshed === "released") return true;
  if (!refreshed) return false;
  const retry = await attemptAssignmentTransitionRelease(client, actor, refreshed);
  if (retry === "released" || retry === "already_released") return true;
  const final = await readExactAssignmentTransition(client, actor.organizationId, transition);
  return final === "released";
}

export async function refreshAssignmentTransition(
  client: AdminClient,
  actor: MotoristActor,
  transition: AssignmentTransition,
) {
  const refreshed = await readExactAssignmentTransition(client, actor.organizationId, transition);
  if (!refreshed || refreshed === "released") {
    throw new MutationError("Assignment interlock sa počas bezpečnostnej kontroly zmenil. Obnov stav.", 409);
  }
  return refreshed;
}

/**
 * Takes ownership of an expired transition before recovery touches a profile
 * reservation. Advancing both transition identity and assignment generation
 * makes every pre-crash extension snapshot lose its final CAS.
 */
export async function claimStaleAssignmentTransitionRecovery(
  client: AdminClient,
  actor: MotoristActor,
  extension: GuardedExtensionRow,
  dependencies: { now?: () => string; randomId?: () => string } = {},
) {
  if (readWorkplaceAssignmentTransition(extension.metadata) || ["workplace_takeover", "workplace_admin_release"].includes(
    String(jsonRecord(jsonRecord(extension.metadata)[TRANSITION_KEY]).kind ?? ""),
  )) {
    throw new MutationError(
      "Workplace transition sa nesmie obnovovať legacy assignment recovery cestou.",
      409,
      "WORKPLACE_TRANSITION_RECOVERY_REQUIRED",
    );
  }
  const current = readAssignmentTransition(extension.metadata);
  const recoveryAt = (dependencies.now ?? (() => new Date().toISOString()))();
  if (!current || !assignmentTransitionIsStale(extension.metadata, recoveryAt)) {
    throw new MutationError("Assignment interlock ešte nie je pripravený na bezpečné zotavenie.", 409);
  }
  if (extension.profile_id !== current.fromProfileId) {
    throw new MutationError("Assignment interlock nezodpovedá aktuálnemu vlastníkovi klapky.", 409);
  }
  const randomId = dependencies.randomId ?? randomUUID;
  const transitionId = randomId();
  const generation = randomId();
  if (
    !readUuid(transitionId) ||
    !readUuid(generation) ||
    transitionId === generation ||
    (transitionId === current.transitionId && generation === current.generation)
  ) {
    throw new MutationError("Recovery interlock nevytvoril platnú novú identitu.", 500);
  }
  const metadata = jsonRecord(extension.metadata);
  const previousTransition = jsonRecord(metadata[TRANSITION_KEY]);
  const nextMetadata = toJson({
    ...metadata,
    [GENERATION_KEY]: generation,
    [TRANSITION_KEY]: {
      ...previousTransition,
      generation,
      recoveredBy: actor.profileId,
      recoveryOfTransitionId: current.transitionId,
      startedAt: recoveryAt,
      transitionId,
    },
  });
  const transition = await assignmentTransitionQuery(
    client,
    actor,
    extension,
    nextMetadata,
    transitionId,
    generation,
  );
  return { previous: current, recoveryAt, transition };
}

export function assignmentTransitionIsStale(metadata: unknown, nowValue: string) {
  const transition = readAssignmentTransition(metadata);
  if (!transition) return false;
  const startedAt = Date.parse(transition.startedAt);
  const now = Date.parse(nowValue);
  if (!Number.isFinite(startedAt) || !Number.isFinite(now) || now < startedAt) return false;
  return now - startedAt > ASSIGNMENT_TRANSITION_LEASE_MS;
}

export function hasActiveAssignmentTransitionMetadata(metadata: unknown) {
  return hasActiveAssignmentTransition(jsonRecord(metadata));
}

export function readAssignmentTransition(metadata: unknown) {
  const root = jsonRecord(metadata);
  const transition = jsonRecord(root[TRANSITION_KEY]);
  const transitionId = readUuid(transition.transitionId);
  const generation = readUuid(transition.generation);
  const startedAt = typeof transition.startedAt === "string" ? transition.startedAt : undefined;
  const initiatedBy = readUuid(transition.initiatedBy);
  const fromProfileId = readNullableUuid(transition.fromProfileId);
  const toProfileId = readNullableUuid(transition.toProfileId);
  const profileReservationPreviousExtension = readPreviousProfileExtension(
    transition.profileReservationPreviousExtension,
  );
  const recoveredBy = readOptionalUuid(transition.recoveredBy);
  const recoveryOfTransitionId = readOptionalUuid(transition.recoveryOfTransitionId);
  if ((transition.recoveredBy === undefined) !== (transition.recoveryOfTransitionId === undefined)) return undefined;
  if (
    (transition.recoveredBy !== undefined && !recoveredBy) ||
    (transition.recoveryOfTransitionId !== undefined && !recoveryOfTransitionId) ||
    recoveryOfTransitionId === transitionId
  ) return undefined;
  if (
    transition.active !== true ||
    !transitionId ||
    !generation ||
    !startedAt || !isExactIso(startedAt) ||
    !initiatedBy || transitionId === generation ||
    fromProfileId === undefined ||
    toProfileId === undefined ||
    (fromProfileId !== null && fromProfileId === toProfileId) ||
    profileReservationPreviousExtension === undefined ||
    readGeneration(root[GENERATION_KEY]) !== generation
  ) return undefined;
  return {
    fromProfileId,
    generation,
    initiatedBy,
    profileReservationPreviousExtension,
    ...(recoveredBy && recoveryOfTransitionId ? { recoveredBy, recoveryOfTransitionId } : {}),
    startedAt,
    toProfileId,
    transitionId,
  };
}

export function readWorkplaceAssignmentTransition(
  metadata: unknown,
): WorkplaceAssignmentTransition | undefined {
  const base = readAssignmentTransition(metadata);
  if (!base) return undefined;
  const transition = jsonRecord(jsonRecord(metadata)[TRANSITION_KEY]);
  const kind = transition.kind === "workplace_takeover" || transition.kind === "workplace_admin_release"
    ? transition.kind
    : undefined;
  const phase = readWorkplaceTransitionPhase(transition.phase);
  const auditId = readUuid(transition.auditId);
  const previousLifecycle = readAssignmentLifecycle(transition.previousLifecycle);
  const preservedQueue = transition.preservedQueue === null
    ? null
    : transition.preservedQueue === "601" || transition.preservedQueue === "602" || transition.preservedQueue === "603"
      ? transition.preservedQueue
      : undefined;
  if (
    !kind || !phase || !auditId || !previousLifecycle || preservedQueue === undefined ||
    auditId === base.transitionId || auditId === base.generation ||
    previousLifecycle.state !== "assigned" ||
    previousLifecycle.profileId !== base.fromProfileId ||
    previousLifecycle.assignmentMode !== "workplace_claim"
  ) return undefined;
  if (
    (kind === "workplace_takeover" && base.toProfileId === null) ||
    (kind === "workplace_admin_release" && (base.toProfileId !== null || preservedQueue !== null)) ||
    (kind === "workplace_takeover" && phase === "owner_cleared") ||
    (kind === "workplace_admin_release" && (phase === "target_reserved" || phase === "owner_switched"))
  ) return undefined;
  return { ...base, auditId, kind, phase, preservedQueue, previousLifecycle };
}

/**
 * Claims a stale workplace recovery with a fresh transition identity before
 * either profile reservation is inspected. The assignment generation stays
 * unchanged: it already fences all pre-handoff actions and is the lifecycle
 * epoch at the commit boundary.
 */
export async function claimStaleWorkplaceTransitionRecovery(
  client: AdminClient,
  actor: MotoristActor,
  extension: GuardedExtensionRow,
  dependencies: { now?: () => string; randomId?: () => string } = {},
) {
  const current = readWorkplaceAssignmentTransition(extension.metadata);
  const recoveryAt = (dependencies.now ?? (() => new Date().toISOString()))();
  if (!current || !assignmentTransitionIsStale(extension.metadata, recoveryAt)) {
    throw new MutationError("Workplace interlock ešte nie je pripravený na bezpečné zotavenie.", 409);
  }
  const transitionId = (dependencies.randomId ?? randomUUID)();
  if (
    !readUuid(transitionId) || transitionId === current.transitionId ||
    transitionId === current.generation || transitionId === current.auditId
  ) {
    throw new MutationError("Recovery workplace interlock nevytvoril platnú novú identitu.", 500);
  }
  const metadata = jsonRecord(extension.metadata);
  const previous = jsonRecord(metadata[TRANSITION_KEY]);
  const nextMetadata = toJson({
    ...metadata,
    [TRANSITION_KEY]: {
      ...previous,
      recoveredBy: actor.profileId,
      recoveryOfTransitionId: current.transitionId,
      startedAt: recoveryAt,
      transitionId,
    },
  });
  const claimed = await assignmentTransitionQuery(
    client,
    actor,
    extension,
    nextMetadata,
    transitionId,
    current.generation,
  );
  const parsed = readWorkplaceAssignmentTransition(claimed.extension.metadata);
  if (!parsed || parsed.transitionId !== transitionId) {
    throw new MutationError("Recovery workplace interlock sa po CAS nepodarilo potvrdiť.", 500);
  }
  return { previous: current, recoveryAt, transition: claimed, workplaceTransition: parsed };
}

function readWorkplaceTransitionPhase(value: unknown): WorkplaceAssignmentTransitionPhase | undefined {
  return value === "locked" ||
    value === "source_released" ||
    value === "target_reserved" ||
    value === "owner_switched" ||
    value === "owner_cleared" ||
    value === "audit_committed"
    ? value
    : undefined;
}

function isExactIso(value: string) {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function readPreviousProfileExtension(value: unknown) {
  if (value === undefined || value === null) return null;
  if (
    typeof value === "string" &&
    isLegacySeededProfileExtension(value)
  ) return value;
  return undefined;
}

async function attemptAssignmentTransitionRelease(
  client: AdminClient,
  actor: MotoristActor,
  transition: AssignmentTransition,
) {
  const metadata = jsonRecord(transition.extension.metadata);
  if (readTransitionId(metadata) !== transition.transitionId) {
    return hasActiveAssignmentTransition(metadata) ? "conflict" as const : "already_released" as const;
  }
  const nextMetadata = withoutAssignmentTransition(metadata);
  let query = client
    .from("motorist_telephony_extensions")
    .update({ metadata: toJson(nextMetadata) })
    .eq("id", transition.extension.id)
    .eq("organization_id", actor.organizationId)
    .eq("provider", PROVIDER)
    .eq("updated_at", transition.extension.updated_at)
    .eq("active", true);
  query = transition.extension.profile_id === null
    ? query.is("profile_id", null)
    : query.eq("profile_id", transition.extension.profile_id);
  const released = await query.select("id").maybeSingle();
  if (!released.error && released.data) return "released" as const;
  return "retry" as const;
}

async function readExactAssignmentTransition(
  client: AdminClient,
  organizationId: string,
  expected: AssignmentTransition,
): Promise<AssignmentTransition | "released" | null> {
  const current = await client
    .from("motorist_telephony_extensions")
    .select("id, extension, profile_id, active, metadata, updated_at")
    .eq("id", expected.extension.id)
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .maybeSingle();
  if (current.error || !current.data) return null;
  const currentMetadata = jsonRecord(current.data.metadata);
  if (readTransitionId(currentMetadata) !== expected.transitionId) {
    return hasActiveAssignmentTransition(currentMetadata) ? null : "released";
  }
  const stored = readAssignmentTransition(current.data.metadata);
  if (!stored || stored.transitionId !== expected.transitionId) return null;
  if (
    stored.generation !== expected.generation ||
    current.data.extension !== expected.extension.extension ||
    current.data.profile_id !== expected.extension.profile_id ||
    current.data.active !== true
  ) return null;
  return { extension: current.data, generation: stored.generation, transitionId: stored.transitionId };
}

export function withoutAssignmentTransition(metadata: unknown) {
  const root = jsonRecord(metadata);
  const next = { ...root };
  delete next[TRANSITION_KEY];
  return next;
}

/** Fails closed immediately before the listener performs a call provider write. */
export async function revalidateCallCommandAssignment(
  client: AdminClient,
  organizationId: string,
  command: Pick<
    Database["public"]["Tables"]["motorist_telephony_commands"]["Row"],
    "command_type" | "extension_id" | "request_payload" | "requested_by"
  > & { call_id?: string | null },
) {
  const payload = jsonRecord(command.request_payload);
  if (isSystemFallbackRedirectPayload(payload)) {
    try {
      if (!command.call_id) throw new Error("Záložnému presmerovaniu chýba hovor.");
      await assertSystemFallbackRedirectAuthorized(client, organizationId, {
        ...command,
        call_id: command.call_id,
      });
      return;
    } catch (error) {
      throw new AssignmentInterlockRejected(
        error instanceof Error ? error.message : "Záložné presmerovanie už nie je autorizované.",
      );
    }
  }
  const guard = parseAssignmentGuard(payload.assignmentGuard);
  if (!isCallCommand(command.command_type) || !guard || command.extension_id !== guard.extensionId || command.requested_by !== guard.profileId) {
    throw new AssignmentInterlockRejected("Call príkaz nemá platný bezpečnostný snapshot priradenia.");
  }
  await revalidateExtensionAssignmentGuard(client, organizationId, guard);
  if (command.command_type !== "call.redirect") return;

  if (payload.destinationKind === "phone") {
    const destination = readDialTarget(payload.destination);
    if (
      !destination ||
      payload.destinationExtension !== undefined ||
      payload.destinationExtensionId !== undefined ||
      payload.destinationLifecycleEpoch !== undefined ||
      payload.destinationProfileId !== undefined
    ) {
      throw new AssignmentInterlockRejected("Externý cieľ prepojenia nemá platný bezpečnostný snapshot.");
    }
    return;
  }

  const targetExtensionId = readUuid(payload.destinationExtensionId);
  const targetProfileId = readUuid(payload.destinationProfileId);
  const targetLifecycleEpoch = readUuid(payload.destinationLifecycleEpoch);
  const targetExtension = readNumeric(payload.destinationExtension);
  if (!targetExtensionId || !targetProfileId || !targetLifecycleEpoch || !targetExtension) {
    throw new AssignmentInterlockRejected("Cieľ prepojenia nemá platný nemenný assignment snapshot.");
  }
  const target = await client
    .from("motorist_telephony_extensions")
    .select("id, extension, profile_id, active, metadata")
    .eq("id", targetExtensionId)
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .eq("active", true)
    .maybeSingle();
  if (target.error || !target.data) {
    throw new AssignmentInterlockRejected("Cieľová osobná klapka už nie je aktívna.");
  }
  let lifecycleEpoch: string;
  try {
    lifecycleEpoch = (await requireImmutableAssignmentLifecycle(
      client,
      organizationId,
      target.data,
      targetProfileId,
    )).epoch;
  } catch (error) {
    throw new AssignmentInterlockRejected(
      error instanceof Error ? error.message : "Nemenný assignment audit cieľa bol odmietnutý.",
    );
  }
  if (
    target.data.extension !== targetExtension ||
    target.data.profile_id !== targetProfileId ||
    lifecycleEpoch !== targetLifecycleEpoch
  ) {
    throw new AssignmentInterlockRejected("Vlastník cieľovej klapky sa od autorizácie prepojenia zmenil.");
  }
}

export async function revalidateExtensionAssignmentGuard(
  client: AdminClient,
  organizationId: string,
  guard: TelephonyAssignmentGuard,
) {
  const current = guard.workplaceSeatGeneration
    ? await client
        .from("motorist_telephony_extensions")
        .select("id, extension, profile_id, active, metadata, workplace_seat_generation")
        .eq("id", guard.extensionId)
        .eq("organization_id", organizationId)
        .eq("provider", PROVIDER)
        .eq("active", true)
        .maybeSingle()
    : await client
        .from("motorist_telephony_extensions")
        .select("id, extension, profile_id, active, metadata")
        .eq("id", guard.extensionId)
        .eq("organization_id", organizationId)
        .eq("provider", PROVIDER)
        .eq("active", true)
        .maybeSingle();
  if (current.error) {
    throw new AssignmentInterlockRejected("Aktuálne vlastníctvo osobnej klapky sa nepodarilo overiť.");
  }
  const currentData = current.data as Pick<
    ExtensionRow,
    "active" | "extension" | "id" | "metadata" | "profile_id" | "workplace_seat_generation"
  > | null;
  let lifecycleEpoch: string | undefined;
  if (currentData) {
    try {
      lifecycleEpoch = (guard.profileId === null
        ? await requireImmutableWorkplaceSeatLifecycle(client, organizationId, currentData)
        : await requireImmutableAssignmentLifecycle(client, organizationId, currentData, guard.profileId)).epoch;
    } catch (error) {
      throw new AssignmentInterlockRejected(error instanceof Error ? error.message : "Nemenný assignment audit bol odmietnutý.");
    }
  }
  const metadata = jsonRecord(currentData?.metadata);
  const claim = jsonRecord(metadata[ACTION_CLAIM_KEY]);
  if (
    !currentData ||
    currentData.extension !== guard.extension ||
    currentData.profile_id !== guard.profileId ||
    readGeneration(metadata[GENERATION_KEY]) !== guard.generation ||
    readGeneration(claim.claimId) !== guard.claimId ||
    readGeneration(claim.generation) !== guard.generation ||
    readNullableUuid(claim.profileId) !== guard.profileId ||
    readUuid(claim.lifecycleEpoch) !== guard.lifecycleEpoch ||
    lifecycleEpoch !== guard.lifecycleEpoch ||
    readOptionalUuid(claim.routingOperationId) !== guard.routingOperationId ||
    (guard.workplaceSeatGeneration !== undefined &&
      currentData.workplace_seat_generation !== guard.workplaceSeatGeneration) ||
    hasActiveAssignmentTransition(metadata)
  ) {
    throw new AssignmentInterlockRejected("Vlastníctvo alebo generácia osobnej klapky sa od autorizácie príkazu zmenili.");
  }
}

/**
 * Reserves every extension used by a routing plan on the same extension-row
 * CAS as calls and assignment transitions. Returned guards must be persisted
 * in the operation/no-op input and revalidated before root CAS/provider work.
 */
export async function captureRoutingAssignmentGuards(
  client: AdminClient,
  organizationId: string,
  extensionIds: readonly string[],
  action: Extract<ExtensionActionKind, `dispatch.routing.${string}`>,
  routingOperationId: string,
  dependencies: { now?: () => string; randomId?: () => string } = {},
) {
  assertTelephonyLiveMutationEnabled(action);
  const ids = [...new Set(extensionIds)];
  if (ids.length === 0 || ids.some((id) => !readUuid(id))) {
    throw new MutationError("Routing plán nemá úplný zoznam osobných klapiek pre bezpečnostný interlock.", 409);
  }
  if (!readUuid(routingOperationId)) {
    throw new MutationError("Routing interlock nemá platný identifikátor operácie.", 409);
  }
  const now = dependencies.now ?? (() => new Date().toISOString());
  const randomId = dependencies.randomId ?? randomUUID;
  const result = await client
    .from("motorist_telephony_extensions")
    .select("id, extension, profile_id, active, metadata, updated_at")
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .eq("active", true)
    .in("id", ids);
  if (result.error) throw new MutationError("Klapky routing plánu sa nepodarilo uzamknúť.", 500);
  const rows = result.data ?? [];
  if (rows.length !== ids.length || ids.some((id) => rows.filter((row) => row.id === id).length !== 1)) {
    throw new MutationError("Routing plán odkazuje na neaktívnu alebo nejednoznačnú osobnú klapku.", 409);
  }

  const capturedAt = now();
  const lifecycleEpochs = new Map<string, string>();
  const capability = workplaceHotdeskCapability();
  const resourceBarrierExtensionIds = capability.runtimeEnabled
    ? new Set(rows.map((row) => row.id))
    : new Set<string>();
  const markerCandidates: string[] = [];
  const unassignedSeatIds = new Set<string>();
  for (const row of rows) {
    const metadata = jsonRecord(row.metadata);
    if (!isConfiguredPersonalExtension(row.extension) || hasActiveAssignmentTransition(metadata)) {
      throw new MutationError(`Klapka ${row.extension} nemá stabilného osobného vlastníka pre routing plán.`, 409);
    }
    const lifecycle = row.profile_id
      ? await requireImmutableAssignmentLifecycle(client, organizationId, row, row.profile_id)
      : await requireImmutableWorkplaceSeatLifecycle(client, organizationId, row);
    if (!row.profile_id) unassignedSeatIds.add(row.id);
    lifecycleEpochs.set(row.id, lifecycle.epoch);
    if (lifecycle.assignmentMode === "workplace_claim") {
      markerCandidates.push(row.id);
    }
    const existingClaim = readActionClaim(metadata);
    const routingClaimBlocks = existingClaim?.action.startsWith("dispatch.routing.")
      ? await routingClaimBlocksTakeover(client, organizationId, row, existingClaim, capturedAt)
      : false;
    if (routingClaimBlocks || readRecentActionClaim(metadata, capturedAt)) {
      throw new MutationError(`Klapka ${row.extension} bola práve použitá; routing plán bol bezpečne zastavený.`, 409);
    }
  }
  const seatGenerations = markerCandidates.length > 0
    ? await loadBootstrappedWorkplaceExtensions(client, organizationId, {
        extensionIds: markerCandidates,
      })
    : new Map<string, string>();
  if (markerCandidates.length > 0) {
    for (const id of seatGenerations.keys()) resourceBarrierExtensionIds.add(id);
  }
  for (const row of rows) {
    const lifecycleEpoch = lifecycleEpochs.get(row.id);
    if (!lifecycleEpoch) throw new MutationError(`Klapka ${row.extension} nemá nemenný lifecycle epoch.`, 409);
    if ((capability.runtimeEnabled || unassignedSeatIds.has(row.id)) && markerCandidates.includes(row.id) && !seatGenerations.has(row.id)) {
      throw new MutationError(`Pracovné miesto ${row.extension} ešte nemá bezpečný hot-desk bootstrap.`, 409, "workplace_bootstrap_required");
    }
  }

  const guards: TelephonyAssignmentGuard[] = [];
  try {
    for (const row of rows) {
      const profileId = row.profile_id;
      const metadata = jsonRecord(row.metadata);
      const generation = readGeneration(metadata[GENERATION_KEY]) ?? randomId();
      const claimId = randomId();
      const lifecycleEpoch = lifecycleEpochs.get(row.id);
      if (!lifecycleEpoch) throw new MutationError(`Klapka ${row.extension} nemá nemenný lifecycle epoch.`, 409);
      const nextMetadata = toJson({
        ...metadata,
        [GENERATION_KEY]: generation,
        [ACTION_CLAIM_KEY]: {
          action,
          claimId,
          claimedAt: capturedAt,
          generation,
          lifecycleEpoch,
          profileId,
          routingOperationId,
        },
      });
      let claimQuery = client
        .from("motorist_telephony_extensions")
        .update({ metadata: nextMetadata })
        .eq("id", row.id)
        .eq("organization_id", organizationId)
        .eq("provider", PROVIDER)
        .eq("updated_at", row.updated_at);
      claimQuery = profileId === null
        ? claimQuery.is("profile_id", null)
        : claimQuery.eq("profile_id", profileId);
      const claimed = await claimQuery
        .eq("active", true)
        .select("id")
        .maybeSingle();
      if (claimed.error) throw new MutationError("Routing interlock osobnej klapky sa nepodarilo uložiť.", 500);
      if (!claimed.data) {
        throw new MutationError("Klapku súbežne použil operátor alebo zmena priradenia; routing plán bol zastavený.", 409);
      }
      guards.push({
        claimId,
        extension: row.extension,
        extensionId: row.id,
        generation,
        lifecycleEpoch,
        profileId,
        routingOperationId,
        ...(seatGenerations.has(row.id)
          ? { workplaceSeatGeneration: seatGenerations.get(row.id) as string }
          : {}),
      });
    }
    // Second half of the ownership/routing handshake. A workplace operation
    // that acquired the durable extension resource first makes routing back
    // out before root/provider authority; the opposite order is rejected by
    // the workplace begin RPC when it observes this metadata claim.
    for (const guard of guards) {
      if (!resourceBarrierExtensionIds.has(guard.extensionId)) continue;
      await assertNoWorkplaceResourceClaimAfterAction(client, organizationId, guard);
    }
  } catch (error) {
    if (guards.length > 0) {
      try {
        await releaseRoutingAssignmentGuards(client, organizationId, guards);
      } catch {
        throw new MutationError(
          "Routing interlock sa uložil iba čiastočne a nepodarilo sa ho bezpečne uvoľniť. Klapky nepoužívaj a eskaluj ručné zotavenie.",
          409,
        );
      }
    }
    throw error;
  }
  return guards;
}

export async function revalidateRoutingAssignmentGuards(
  client: AdminClient,
  organizationId: string,
  guards: readonly TelephonyAssignmentGuard[],
) {
  if (guards.length === 0) throw new AssignmentInterlockRejected("Routing operácia nemá bezpečnostné snapshoty klapiek.");
  for (const guard of guards) {
    if (guard.profileId === null && !guard.workplaceSeatGeneration) {
      throw new AssignmentInterlockRejected("Prázdne pracovisko nemá stabilnú hot-desk generáciu.");
    }
    await revalidateExtensionAssignmentGuard(client, organizationId, guard);
  }
}

/** Clears only the exact routing claims after the root plan is terminal. */
export async function releaseRoutingAssignmentGuards(
  client: AdminClient,
  organizationId: string,
  guards: readonly TelephonyAssignmentGuard[],
) {
  for (const guard of guards) {
    await releaseExtensionAssignmentGuard(client, organizationId, guard);
  }
}

/**
 * Clears only the exact action claim captured by this guard. A newer action or
 * ownership generation wins the CAS and is never removed by an old retry.
 * Calling this repeatedly is safe, including after a lost release response.
 */
export async function releaseExtensionAssignmentGuard(
  client: AdminClient,
  organizationId: string,
  guard: TelephonyAssignmentGuard,
) {
  let retryBaseline: GuardedExtensionRow | undefined;

  for (let attempt = 1; attempt <= ASSIGNMENT_ACTION_RELEASE_MAX_ATTEMPTS; attempt += 1) {
    const current = guard.workplaceSeatGeneration
      ? await client
          .from("motorist_telephony_extensions")
          .select("id, extension, profile_id, active, metadata, updated_at, workplace_seat_generation")
          .eq("id", guard.extensionId)
          .eq("organization_id", organizationId)
          .eq("provider", PROVIDER)
          .maybeSingle()
      : await client
          .from("motorist_telephony_extensions")
          .select("id, extension, profile_id, active, metadata, updated_at")
          .eq("id", guard.extensionId)
          .eq("organization_id", organizationId)
          .eq("provider", PROVIDER)
          .maybeSingle();
    if (current.error) throw new AssignmentInterlockRejected("Assignment interlock sa po ukončení nepodarilo načítať.");
    const currentData = current.data as GuardedReleaseExtensionRow | null;
    if (!currentData || !assignmentActionClaimMatchesGuard(currentData, guard)) return;
    if (retryBaseline && !isProviderOnlyAssignmentRowDrift(retryBaseline, currentData)) {
      throw new AssignmentInterlockRejected("Assignment interlock sa počas uvoľnenia súbežne zmenil.");
    }

    const metadata = jsonRecord(currentData.metadata);
    const nextMetadata = { ...metadata };
    delete nextMetadata[ACTION_CLAIM_KEY];
    let query = client
      .from("motorist_telephony_extensions")
      .update({ metadata: toJson(nextMetadata) })
      .eq("id", guard.extensionId)
      .eq("organization_id", organizationId)
      .eq("provider", PROVIDER)
      .eq("updated_at", currentData.updated_at)
      .eq("active", true);
    query = guard.profileId === null
      ? query.is("profile_id", null)
      : query.eq("profile_id", guard.profileId);
    const released = await query.select("id").maybeSingle();
    if (released.error) throw new AssignmentInterlockRejected("Assignment interlock sa po ukončení nepodarilo uvoľniť.");
    if (released.data) return;
    retryBaseline = currentData;
  }

  const finalState = guard.workplaceSeatGeneration
    ? await client
        .from("motorist_telephony_extensions")
        .select("id, extension, profile_id, active, metadata, updated_at, workplace_seat_generation")
        .eq("id", guard.extensionId)
        .eq("organization_id", organizationId)
        .eq("provider", PROVIDER)
        .maybeSingle()
    : await client
        .from("motorist_telephony_extensions")
        .select("id, extension, profile_id, active, metadata, updated_at")
        .eq("id", guard.extensionId)
        .eq("organization_id", organizationId)
        .eq("provider", PROVIDER)
        .maybeSingle();
  const finalData = finalState.data as GuardedReleaseExtensionRow | null;
  if (finalState.error || (finalData && assignmentActionClaimMatchesGuard(finalData, guard))) {
    throw new AssignmentInterlockRejected("Assignment interlock zostal po ukončení aktívny.");
  }
}

function assignmentActionClaimMatchesGuard(
  extension: Pick<ExtensionRow, "active" | "extension" | "id" | "metadata" | "profile_id" | "workplace_seat_generation">,
  guard: TelephonyAssignmentGuard,
) {
  const metadata = jsonRecord(extension.metadata);
  const claim = jsonRecord(metadata[ACTION_CLAIM_KEY]);
  return extension.active === true &&
    extension.id === guard.extensionId &&
    extension.extension === guard.extension &&
    extension.profile_id === guard.profileId &&
    readGeneration(metadata[GENERATION_KEY]) === guard.generation &&
    readGeneration(claim.claimId) === guard.claimId &&
    readGeneration(claim.generation) === guard.generation &&
    readNullableUuid(claim.profileId) === guard.profileId &&
    readUuid(claim.lifecycleEpoch) === guard.lifecycleEpoch &&
    readOptionalUuid(claim.routingOperationId) === guard.routingOperationId &&
    (guard.workplaceSeatGeneration === undefined ||
      extension.workplace_seat_generation === guard.workplaceSeatGeneration) &&
    !hasActiveAssignmentTransition(metadata);
}

/** Releases a normal terminal command claim; routing owns its multi-seat release. */
export async function releaseTerminalCommandAssignmentGuard(
  client: AdminClient,
  organizationId: string,
  requestPayload: unknown,
) {
  const guard = parseAssignmentGuard(jsonRecord(requestPayload).assignmentGuard);
  if (!guard || guard.routingOperationId) return;
  await releaseExtensionAssignmentGuard(client, organizationId, guard);
}

/**
 * Repairs a lost terminal-response cleanup before a workplace handoff. It only
 * clears an exact non-routing guard that is durably present on a terminal
 * command and absent from every non-terminal command returned by the bounded
 * extension scan; the extension-row CAS remains the final authority.
 */
export async function reconcileTerminalExtensionAssignmentClaim(
  client: AdminClient,
  organizationId: string,
  extensionId: string,
  options: { providerIdleProven?: boolean; providerProofAt?: string } = {},
) {
  const extension = await client
    .from("motorist_telephony_extensions")
    .select("id, extension, profile_id, metadata")
    .eq("id", extensionId)
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .maybeSingle();
  if (extension.error || !extension.data) {
    throw new AssignmentInterlockRejected("Aktuálny assignment interlock sa nepodarilo načítať.");
  }
  const extensionRow = extension.data;
  const metadata = jsonRecord(extensionRow.metadata);
  const claim = readActionClaim(metadata);
  const generation = readGeneration(metadata[GENERATION_KEY]);
  if (!claim || claim.claimId === "invalid" || !generation || claim.routingOperationId) return;
  const commands = await client
    .from("motorist_telephony_commands")
    .select("id, call_id, command_type, status, provider_response, request_payload")
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .eq("extension_id", extensionId)
    .contains("request_payload", {
      assignmentGuard: { claimId: claim.claimId, generation },
    })
    .limit(3);
  if (commands.error || (commands.data?.length ?? 0) > 2) {
    throw new AssignmentInterlockRejected("Terminálny assignment interlock sa nepodarilo jednoznačne zosúladiť.");
  }
  const rows = (commands.data ?? []).flatMap((command) => {
    const guard = parseAssignmentGuard(jsonRecord(command.request_payload).assignmentGuard);
    return guard && !guard.routingOperationId && guard.claimId === claim.claimId &&
      guard.generation === generation && guard.extensionId === extensionRow.id &&
      guard.extension === extensionRow.extension && guard.profileId === extensionRow.profile_id
      ? [{ ...command, guard }]
      : [];
  });
  const inFlight = rows.filter(({ status }) => status === "queued" || status === "sent" || status === "accepted");
  if (inFlight.length > 0) {
    if (inFlight.length !== 1 || inFlight[0].status !== "accepted" || !options.providerIdleProven) return;
    let dtmfCanRelease = false;
    if (inFlight[0].command_type === "call.transfer.dtmf") {
      dtmfCanRelease = await hasImmutableTerminalDtmfDelivery(client, organizationId, inFlight[0]);
      if (!dtmfCanRelease) {
        // A browser can close after sending tones but before persisting its
        // delivery report. Once both the provider is idle and the exact call
        // is durably terminal, that accepted intent can no longer mutate a
        // live call and its assignment fence is safe to release.
        const terminalCallIds = await loadTerminalAcceptedBrowserTransferCallIds(
          client,
          organizationId,
          [inFlight[0]],
        );
        dtmfCanRelease = Boolean(inFlight[0].call_id && terminalCallIds.has(inFlight[0].call_id));
      }
    }
    const browserTransferCanRelease = inFlight[0].command_type === "call.transfer.sip_refer" || dtmfCanRelease;
    if (!browserTransferCanRelease) return;
    await releaseExtensionAssignmentGuard(client, organizationId, inFlight[0].guard);
    return;
  }
  for (const { guard, status } of rows) {
    if (status !== "failed" && status !== "confirmed_by_event") continue;
    await releaseExtensionAssignmentGuard(client, organizationId, guard);
    return;
  }
  if (rows.length === 0 && claim.action === "webphone.session.issue" && options.providerIdleProven) {
    const claimedAt = claim.claimedAt ? Date.parse(claim.claimedAt) : Number.NaN;
    const proofAt = options.providerProofAt ? Date.parse(options.providerProofAt) : Number.NaN;
    const claimRecord = jsonRecord(metadata[ACTION_CLAIM_KEY]);
    const guard = parseAssignmentGuard({
      ...claimRecord,
      extension: extensionRow.extension,
      extensionId: extensionRow.id,
    });
    if (guard && Number.isFinite(claimedAt) && Number.isFinite(proofAt) &&
        proofAt - claimedAt > ASSIGNMENT_ACTION_CLAIM_GRACE_MS) {
      await releaseExtensionAssignmentGuard(client, organizationId, guard);
    }
  }
}

async function hasImmutableTerminalDtmfDelivery(
  client: AdminClient,
  organizationId: string,
  command: {
    id: string;
    call_id: string | null;
    provider_response: Json | null;
    guard: TelephonyAssignmentGuard;
  },
) {
  const stored = jsonRecord(jsonRecord(command.provider_response).browserDtmfDelivery).outcome;
  if (stored === "complete" || stored === "partial") return true;
  if (!command.call_id) return false;
  const audit = await client
    .from("motorist_audit_log")
    .select("after_payload")
    .eq("organization_id", organizationId)
    .eq("action", "telephony.command.browser_dtmf.delivery")
    .eq("entity_type", "motorist_calls")
    .eq("entity_id", command.call_id)
    .contains("after_payload", {
      browser_dtmf_delivery: { commandId: command.id, extensionId: command.guard.extensionId },
    })
    .limit(2);
  if (audit.error || (audit.data?.length ?? 0) !== 1) return false;
  const outcome = jsonRecord(jsonRecord(audit.data?.[0]?.after_payload).browser_dtmf_delivery).delivery;
  const value = jsonRecord(outcome).outcome;
  return value === "complete" || value === "partial";
}

export function withAssignmentGuard(
  payload: Record<string, unknown>,
  guard: TelephonyAssignmentGuard,
) {
  return { ...payload, assignmentGuard: guard };
}

export function parseAssignmentGuard(value: unknown): TelephonyAssignmentGuard | undefined {
  const record = jsonRecord(value);
  const claimId = readGeneration(record.claimId);
  const extension = readNumeric(record.extension);
  const extensionId = readUuid(record.extensionId);
  const generation = readGeneration(record.generation);
  const lifecycleEpoch = readUuid(record.lifecycleEpoch);
  const profileId = readNullableUuid(record.profileId);
  const routingOperationId = readOptionalUuid(record.routingOperationId);
  const workplaceSeatGeneration = readOptionalUuid(record.workplaceSeatGeneration);
  if (record.routingOperationId !== undefined && !routingOperationId) return undefined;
  if (record.workplaceSeatGeneration !== undefined && !workplaceSeatGeneration) return undefined;
  if (profileId === null && !workplaceSeatGeneration) return undefined;
  return claimId && extension && extensionId && generation && lifecycleEpoch && profileId !== undefined
    ? {
        claimId,
        extension,
        extensionId,
        generation,
        lifecycleEpoch,
        profileId,
        routingOperationId,
        workplaceSeatGeneration,
      }
    : undefined;
}

function hasActiveAssignmentTransition(metadata: Record<string, unknown>) {
  const transition = jsonRecord(metadata[TRANSITION_KEY]);
  // Any active marker is a lock. A malformed marker cannot be recovered
  // automatically, but it must never be treated as an unlocked row.
  return transition.active === true;
}

function readTransitionId(metadata: Record<string, unknown>) {
  return readGeneration(jsonRecord(metadata[TRANSITION_KEY]).transitionId);
}

function readRecentActionClaim(metadata: Record<string, unknown>, nowValue: string) {
  const claim = readActionClaim(metadata);
  if (!claim) return undefined;
  const { action, claimId, claimedAt } = claim;
  const claimedAtMs = claimedAt ? Date.parse(claimedAt) : Number.NaN;
  const nowMs = Date.parse(nowValue);
  // This key is written only by this protocol. Malformed or future claims are
  // blocked rather than silently treated as stale.
  if (!Number.isFinite(claimedAtMs) || !Number.isFinite(nowMs)) {
    return { action, claimId };
  }
  const age = nowMs - claimedAtMs;
  return age < 0 || age <= ASSIGNMENT_ACTION_CLAIM_GRACE_MS ? { action, claimId } : undefined;
}

function readActionClaim(metadata: Record<string, unknown>) {
  const claim = jsonRecord(metadata[ACTION_CLAIM_KEY]);
  if (Object.keys(claim).length === 0) return undefined;
  const action = typeof claim.action === "string" && claim.action ? claim.action : "invalid";
  const claimId = readGeneration(claim.claimId) ?? "invalid";
  const claimedAt = typeof claim.claimedAt === "string" ? claim.claimedAt : undefined;
  const routingOperationId = readOptionalUuid(claim.routingOperationId);
  return { action, claimId, claimedAt, routingOperationId };
}

async function routingClaimBlocksTakeover(
  client: AdminClient,
  organizationId: string,
  extension: Pick<GuardedExtensionRow, "extension" | "id" | "profile_id">,
  claim: NonNullable<ReturnType<typeof readActionClaim>>,
  nowValue: string,
) {
  return (await inspectRoutingClaim(client, organizationId, extension, claim, nowValue)).blocks;
}

async function inspectRoutingClaim(
  client: AdminClient,
  organizationId: string,
  extension: Pick<GuardedExtensionRow, "extension" | "id" | "profile_id">,
  claim: NonNullable<ReturnType<typeof readActionClaim>>,
  nowValue: string,
): Promise<{
  blocks: boolean;
  guard?: TelephonyAssignmentGuard;
  operation?: Record<string, unknown>;
}> {
  if (!claim.routingOperationId || claim.claimId === "invalid") return { blocks: true };
  const root = await client
    .from("motorist_telephony_queues")
    .select("metadata")
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .eq("external_id", "601")
    .eq("active", true)
    .is("line_id", null)
    .maybeSingle();
  if (root.error || !root.data) {
    throw new MutationError("Koreňový routing stav sa nepodarilo overiť; interlock ostáva aktívny.", 409);
  }
  const routing = jsonRecord(jsonRecord(root.data.metadata).dispatchRouting);
  const operation = jsonRecord(routing.operation);
  const guards = Array.isArray(operation.assignmentGuards) ? operation.assignmentGuards : [];
  const matchingGuard = guards.map((value) => parseAssignmentGuard(value)).find((guard) => {
    return guard?.claimId === claim.claimId &&
      guard.routingOperationId === claim.routingOperationId &&
      guard.extensionId === extension.id &&
      guard.extension === extension.extension &&
      guard.profileId === extension.profile_id;
  });
  if (operation.operationId === claim.routingOperationId && matchingGuard) {
    return { blocks: true, guard: matchingGuard, operation };
  }

  const claimedAtMs = claim.claimedAt ? Date.parse(claim.claimedAt) : Number.NaN;
  const nowMs = Date.parse(nowValue);
  if (!Number.isFinite(claimedAtMs) || !Number.isFinite(nowMs)) return { blocks: true };
  const age = nowMs - claimedAtMs;
  return { blocks: age < 0 || age <= ROUTING_ORPHAN_CLAIM_LEASE_MS };
}

function selfServiceRoutingOperationAllowsWebphone(
  actor: MotoristActor,
  extension: string,
  operation: Record<string, unknown>,
) {
  const rootGuard = jsonRecord(operation.rootMetadataGuard);
  const previousPlan = jsonRecord(operation.previousPlan);
  const targetPlan = jsonRecord(operation.targetPlan);
  const operationStatus = operation.status;
  return operation.actorProfileId === actor.profileId &&
    readUuid(operation.operationId) !== undefined &&
    rootGuard.key === "workplacePriorityDraft" &&
    typeof rootGuard.digest === "string" && /^[a-f0-9]{64}$/.test(rootGuard.digest) &&
    readUuid(rootGuard.authorityId) !== undefined &&
    (operationStatus === "applying" || operationStatus === "degraded" || operationStatus === "rolling_back") &&
    [...Object.values(previousPlan), ...Object.values(targetPlan)].includes(extension);
}

function isCallCommand(value: string) {
  return ["call.create", "call.hangup", "call.redirect", "call.transfer.dtmf", "call.transfer.sip_refer"].includes(value);
}

function readGeneration(value: unknown) {
  return typeof value === "string" && /^[a-z0-9-]{8,128}$/i.test(value) ? value : undefined;
}

function readUuid(value: unknown) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}

function readNullableUuid(value: unknown): string | null | undefined {
  if (value === null) return null;
  return readUuid(value);
}

function readOptionalUuid(value: unknown): string | undefined {
  return value === undefined ? undefined : readUuid(value);
}

function readNumeric(value: unknown) {
  return typeof value === "string" && /^\d{1,8}$/.test(value) ? value : undefined;
}

function readDialTarget(value: unknown) {
  return typeof value === "string" && /^\d{2,18}$/.test(value) ? value : undefined;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && jsonValuesEqual(leftRecord[key], rightRecord[key]));
}

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}
