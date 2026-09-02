import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  type ViptelActiveCall,
  type ViptelClient,
  type ViptelExtension,
  type ViptelQueueStatus,
} from "@/lib/integrations/viptel/client";
import type { TelephonyExtensionSnapshot, TelephonyPresenceSnapshot } from "@/lib/telephony/presence";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import {
  hasBlockingExtensionCommand,
  loadTerminalAcceptedBrowserTransferCallIds,
} from "@/server/telephony/command-interlock";
import {
  DISPATCH_QUEUE_NUMBERS,
  parseDispatchRoutingState,
  readApplicableWorkplacePriorityDraft,
  requireAssignmentSafeDispatchRoutingState,
  type DispatchRoutingState,
} from "@/server/telephony/dispatch-routing";
import {
  configuredPersonalExtensions,
  isConfiguredPersonalExtension,
  isLegacySeededProfileExtension,
} from "@/server/telephony/personal-extension-config";
import { requestViptelProviderSnapshot } from "@/server/telephony/provider-snapshot-bridge";
import {
  beginAssignmentTransition,
  assignmentTransitionIsStale,
  claimStaleAssignmentTransitionRecovery,
  hasActiveAssignmentTransitionMetadata,
  readAssignmentTransition,
  refreshAssignmentTransition,
  releaseAssignmentTransition,
  withoutAssignmentTransition,
} from "@/server/telephony/assignment-interlock";
import {
  assignedLifecycle,
  assignmentProvisioningRequirement,
  lifecycleAuditPayload,
  readAssignmentLifecycle,
  requireImmutableAssignmentLifecycle,
  unassignedLifecycle,
  type AssignmentProvisioningRequirement,
} from "@/server/telephony/assignment-lifecycle";
import { assertTelephonyLiveMutationEnabled } from "@/server/telephony/live-mutation-gate";
import { requireLatestWorkplacePriorityDraftAuthority } from "@/server/telephony/workplace-draft-authority";
import { workplaceHotdeskCapability } from "@/server/telephony/workplace-capability";
import { findBootstrappedWorkplaceExtensionIds } from "@/server/telephony/workplace-runtime-state";

const PROVIDER = "viptel";
const SYNC_HEARTBEAT_MS = 60_000;
const PROVIDER_SYNC_CAS_ATTEMPTS = 3;
const NON_TERMINAL_COMMAND_STATUSES = ["queued", "sent", "accepted"] as const;
const COMMAND_SCAN_LIMIT = 501;

type AdminClient = SupabaseClient<Database>;
type ExtensionRow = Database["public"]["Tables"]["motorist_telephony_extensions"]["Row"];
type ProfileRow = Database["public"]["Tables"]["motorist_profiles"]["Row"];

class AssignmentReservationRecoveryRequired extends MutationError {
  constructor(message: string) {
    super(message, 409, "ASSIGNMENT_RESERVATION_RECOVERY_REQUIRED");
  }
}

type AssignmentDependencies = {
  client?: AdminClient;
  now?: () => string;
  randomId?: () => string;
  viptel?: Pick<ViptelClient, "getQueueStatus" | "listActiveCalls" | "listExtensions">;
};

export type ExtensionRotationAttestation = {
  mode: "rotated_handoff";
  rotationAttested: true;
  rotationReference: string;
};

export type ExtensionInitialProvisioningAttestation = {
  mode: "initial_provisioning";
  initialProvisioningAttested: true;
};

export type ExtensionWorkplaceClaimAttestation = {
  mode: "workplace_claim";
};

type ExtensionAssignmentAttestation =
  | ExtensionRotationAttestation
  | ExtensionInitialProvisioningAttestation
  | ExtensionWorkplaceClaimAttestation;

export async function refreshTelephonyPresence(
  actor: MotoristActor,
  options: { requireNewCapture?: boolean } = {},
): Promise<TelephonyPresenceSnapshot> {
  const snapshot = await requestViptelProviderSnapshot(actor.organizationId, actor.profileId, {
    maxAgeMs: 2_000,
    requireNewCapture: options.requireNewCapture === true,
  });
  const checkedAt = snapshot.capturedAt;
  const providerExtensions = snapshot.extensions;

  await synchronizeViptelExtensions(actor.organizationId, providerExtensions, checkedAt);
  const extensions = await loadTelephonyExtensions(actor.organizationId);

  return {
    actorProfileId: actor.profileId,
    canManageAssignments: actor.role === "manager" || actor.role === "admin",
    checkedAt,
    extensions,
    queues: snapshot.queues,
    queueStatuses: snapshot.queueStatuses,
  };
}

export async function listTelephonyExtensionAssignments(actor: MotoristActor): Promise<TelephonyExtensionSnapshot[]> {
  return loadTelephonyExtensions(actor.organizationId);
}

/**
 * Claims one of the shared browser workstations. Unlike the exceptional
 * manager handoff this is an explicit shared-seat lifecycle: no credential
 * rotation is falsely attested, and a fresh provider snapshot must prove the
 * target is disconnected, idle and outside every controlled queue.
 */
export async function claimSelfServiceTelephonyExtension(
  actor: MotoristActor,
  requestedExtension: unknown,
  dependencies: AssignmentDependencies = {},
): Promise<{ id: string; extension: string; profile_id: string | null; noOp?: true }> {
  assertTelephonyLiveMutationEnabled("extension.workplace.claim");
  const extensionNumber = readConfiguredExtension(requestedExtension);
  const client = dependencies.client ?? createSupabaseAdminClient();
  const targetResult = await client
    .from("motorist_telephony_extensions")
    .select("id, extension, profile_id, metadata, updated_at")
    .eq("organization_id", actor.organizationId)
    .eq("provider", PROVIDER)
    .eq("extension", extensionNumber)
    .eq("active", true)
    .maybeSingle();
  if (targetResult.error) throw new MutationError("Pracovné miesto sa nepodarilo načítať.", 500);
  if (!targetResult.data) throw new MutationError(`Pracovné miesto ${extensionNumber} nie je aktívne.`, 404);
  const target = targetResult.data;

  if (target.profile_id && target.profile_id !== actor.profileId) {
    throw new MutationError(`Pracovné miesto ${extensionNumber} už používa iný operátor.`, 409);
  }
  if (target.profile_id === actor.profileId) {
    await requireImmutableAssignmentLifecycle(client, actor.organizationId, target, actor.profileId);
    return { id: target.id, extension: target.extension, profile_id: target.profile_id, noOp: true };
  }

  const ownedResult = await client
    .from("motorist_telephony_extensions")
    .select("id, extension")
    .eq("organization_id", actor.organizationId)
    .eq("provider", PROVIDER)
    .eq("profile_id", actor.profileId)
    .eq("active", true)
    .limit(2);
  if (ownedResult.error) throw new MutationError("Aktuálne pracovné miesto sa nepodarilo overiť.", 500);
  if ((ownedResult.data ?? []).length > 1) {
    throw new MutationError("Používateľ má viac pracovných miest; zmenu musí najprv zosúladiť správca.", 409);
  }
  if (ownedResult.data?.[0]) {
    // The target was checked first, so an occupied target never releases the
    // actor's current seat. A race after release remains recoverable: the actor
    // ends without a seat and may choose another free one, never with two.
    await releaseSelfServiceTelephonyExtension(actor, dependencies);
    return claimSelfServiceTelephonyExtension(actor, extensionNumber, dependencies);
  }

  const profileResult = await client
    .from("motorist_profiles")
    .select("id, phone_extension, updated_at")
    .eq("id", actor.profileId)
    .eq("organization_id", actor.organizationId)
    .eq("active", true)
    .maybeSingle();
  if (profileResult.error) throw new MutationError("Profil operátora sa nepodarilo overiť.", 500);
  if (!profileResult.data) throw new MutationError("Aktívny profil operátora sa nenašiel.", 404);
  if (profileResult.data.phone_extension && !isLegacySeededProfileExtension(profileResult.data.phone_extension)) {
    throw new MutationError(
      `Profil už rezervuje pracovné miesto ${profileResult.data.phone_extension}. Obnov stav pred ďalším výberom.`,
      409,
    );
  }

  const changedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  const transition = await beginAssignmentTransition(
    client,
    actor,
    { ...target, active: true },
    actor.profileId,
    {
      now: () => changedAt,
      profileReservationPreviousExtension: profileResult.data.phone_extension,
      randomId: dependencies.randomId,
    },
  );
  try {
    await assertLiveAssignmentSafety(
      client,
      actor.organizationId,
      actor.profileId,
      transition.extension,
      dependencies.viptel,
      profileResult.data.phone_extension ?? undefined,
    );
    const refreshed = await refreshAssignmentTransition(client, actor, transition);
    return await assignUnownedExtension({
      actor,
      attestation: { mode: "workplace_claim" },
      changedAt,
      client,
      extension: refreshed.extension,
      lifecycleEpoch: refreshed.generation,
      profile: profileResult.data,
    });
  } catch (error) {
    if (error instanceof AssignmentReservationRecoveryRequired) throw error;
    const released = await releaseAssignmentTransition(client, actor, transition);
    if (!released) {
      throw new MutationError(
        "Výber pracovného miesta zlyhal a jeho bezpečnostný zámok zostal aktívny. Miesto nepoužívaj a obnov stav.",
        409,
      );
    }
    throw error;
  }
}

export async function releaseSelfServiceTelephonyExtension(
  actor: MotoristActor,
  dependencies: AssignmentDependencies = {},
): Promise<{ id?: string; extension?: string; profile_id: null; noOp?: true }> {
  assertTelephonyLiveMutationEnabled("extension.workplace.release");
  const client = dependencies.client ?? createSupabaseAdminClient();
  const ownedResult = await client
    .from("motorist_telephony_extensions")
    .select("id, extension, profile_id, metadata, updated_at")
    .eq("organization_id", actor.organizationId)
    .eq("provider", PROVIDER)
    .eq("profile_id", actor.profileId)
    .eq("active", true)
    .limit(2);
  if (ownedResult.error) throw new MutationError("Aktuálne pracovné miesto sa nepodarilo načítať.", 500);
  if ((ownedResult.data ?? []).length === 0) return { profile_id: null, noOp: true };
  if ((ownedResult.data ?? []).length > 1) {
    throw new MutationError("Používateľ má viac pracovných miest; uvoľnenie musí najprv zosúladiť správca.", 409);
  }
  const extension = ownedResult.data?.[0] as Pick<ExtensionRow, "id" | "extension" | "metadata" | "profile_id" | "updated_at">;
  await requireImmutableAssignmentLifecycle(client, actor.organizationId, extension, actor.profileId);
  const profileResult = await client
    .from("motorist_profiles")
    .select("id, phone_extension, updated_at")
    .eq("id", actor.profileId)
    .eq("organization_id", actor.organizationId)
    .eq("active", true)
    .maybeSingle();
  if (profileResult.error) throw new MutationError("Rezerváciu pracovného miesta sa nepodarilo overiť.", 500);
  if (!profileResult.data || profileResult.data.phone_extension !== extension.extension) {
    throw new MutationError("Profilová rezervácia nezodpovedá pracovnému miestu. Uvoľnenie bolo zastavené.", 409);
  }

  const changedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  const transition = await beginAssignmentTransition(
    client,
    actor,
    { ...extension, active: true },
    null,
    { now: () => changedAt, randomId: dependencies.randomId },
  );
  try {
    await assertLiveAssignmentSafety(
      client,
      actor.organizationId,
      actor.profileId,
      transition.extension,
      dependencies.viptel,
    );
    const refreshed = await refreshAssignmentTransition(client, actor, transition);
    const released = await unassignOwnedExtension({
      actor,
      changedAt,
      client,
      extension: refreshed.extension,
      profile: profileResult.data,
      sharedWorkplaceRelease: true,
    });
    return { id: released.id, extension: released.extension, profile_id: null };
  } catch (error) {
    const released = await releaseAssignmentTransition(client, actor, transition);
    if (!released) {
      throw new MutationError(
        "Uvoľnenie pracovného miesta zlyhalo a jeho bezpečnostný zámok zostal aktívny. Obnov stav.",
        409,
      );
    }
    throw error;
  }
}

export async function setTelephonyExtensionAssignment(
  actor: MotoristActor,
  extensionId: unknown,
  profileId: unknown,
  rotationReference?: unknown,
  rotationAttested?: unknown,
  initialProvisioningAttested?: unknown,
  dependencies: AssignmentDependencies = {},
) {
  const id = readRequiredId(extensionId, "Klapka");
  const nextProfileId = readOptionalId(profileId, "Operátor");
  const supabase = dependencies.client ?? createSupabaseAdminClient();
  const now = dependencies.now ?? (() => new Date().toISOString());
  const extensionResult = await supabase
    .from("motorist_telephony_extensions")
    .select("id, extension, profile_id, metadata, updated_at")
    .eq("id", id)
    .eq("organization_id", actor.organizationId)
    .eq("provider", PROVIDER)
    .eq("active", true)
    .maybeSingle();

  if (extensionResult.error) {
    throw new MutationError("Priradenie klapky sa nepodarilo načítať.", 500);
  }

  if (!extensionResult.data) {
    throw new MutationError("Aktívna VIPTel klapka sa nenašla.", 404);
  }

  const extension = extensionResult.data as Pick<ExtensionRow, "id" | "extension" | "metadata" | "profile_id" | "updated_at">;
  if (!isConfiguredPersonalExtension(extension.extension)) {
    throw new MutationError(
      `Klapka ${extension.extension} nie je medzi povolenými osobnými klapkami (${configuredPersonalExtensions().join(", ")}).`,
      400,
    );
  }
  // Once hot-desk is requested, canonical seats 20-23 may only move through
  // the lease-aware workplace transaction. This also fails closed for an
  // invalid requested deployment instead of falling back to the legacy admin
  // mutation, which could otherwise evict a live operator and orphan a lease.
  const lifecycle = readAssignmentLifecycle(jsonRecord(extension.metadata).assignmentLifecycle);
  const hotdeskBootstrapped = workplaceHotdeskCapability().runtimeEnabled ||
    lifecycle?.assignmentMode === "workplace_claim" &&
      (await findBootstrappedWorkplaceExtensionIds(supabase, actor.organizationId, {
        extensionIds: [extension.id],
      })).has(extension.id);
  if (hotdeskBootstrapped) {
    throw new MutationError(
      "Dynamické pracovné miesto nemožno priradiť starým spôsobom. Použi bezpečné prevzatie v pohľade Pracovisko.",
      409,
      "hotdesk_legacy_assignment_blocked",
    );
  }

  const orphanedTransition = readAssignmentTransition(extension.metadata);
  if (hasActiveAssignmentTransitionMetadata(extension.metadata) && !orphanedTransition) {
    throw new MutationError(
      "Assignment interlock má neplatné recovery údaje. Klapku nepoužívaj a eskaluj ručné zotavenie.",
      409,
    );
  }
  if (orphanedTransition) {
    const recoveryAt = now();
    if (!assignmentTransitionIsStale(extension.metadata, recoveryAt)) {
      throw new MutationError("Na osobnej klapke ešte prebieha zmena priradenia. Počkaj na bezpečnostnú lehotu a obnov stav.", 409);
    }
    const recovery = await claimStaleAssignmentTransitionRecovery(
      supabase,
      actor,
      { ...extension, active: true },
      { now: () => recoveryAt, randomId: dependencies.randomId },
    );
    const claimedTransition = readAssignmentTransition(recovery.transition.extension.metadata);
    if (!claimedTransition) {
      throw new MutationError("Recovery interlock sa po uložení nepodarilo potvrdiť.", 500);
    }
    await assertLiveAssignmentSafety(
      supabase,
      actor.organizationId,
      actor.profileId,
      recovery.transition.extension,
      dependencies.viptel,
      claimedTransition.profileReservationPreviousExtension ?? undefined,
    );
    const reservationRecovery = await recoverStaleTransitionProfileReservation(
      supabase,
      actor.organizationId,
      recovery.transition.extension,
      claimedTransition,
    );
    const released = await releaseAssignmentTransition(supabase, actor, recovery.transition);
    if (!released) {
      throw new MutationError("Uviaznutý assignment interlock sa nepodarilo bezpečne obnoviť.", 409);
    }
    const audited = await tryWriteAssignmentAudit(supabase, {
      action: "telephony.extension.assignment_transition.recover",
      actor,
      after: {
        extension: extension.extension,
        profile_reservation_rolled_back: reservationRecovery.profileReservationRolledBack,
        recovered_at: recoveryAt,
        recovery_transition_id: recovery.transition.transitionId,
        transition_id: orphanedTransition.transitionId,
      },
      before: { extension: extension.extension, transition: orphanedTransition },
      entityId: extension.id,
    });
    throw new MutationError(
      `Uviaznutý assignment interlock bol bezpečne uvoľnený${audited ? ". Obnov stav a požiadavku zopakuj." : ", ale audit zlyhal; požiadavku neopakuj a eskaluj."}`,
      409,
    );
  }

  await recoverOrphanedUnassignmentReservation(
    supabase,
    actor,
    extension,
    dependencies,
    now,
  );

  if (extension.profile_id === (nextProfileId ?? null)) {
    if (nextProfileId) {
      await requireImmutableAssignmentLifecycle(supabase, actor.organizationId, extension, nextProfileId);
      const consistency = await supabase
        .from("motorist_profiles")
        .select("id, phone_extension")
        .eq("id", nextProfileId)
        .eq("organization_id", actor.organizationId)
        .maybeSingle();
      if (consistency.error) throw new MutationError("Rezerváciu osobnej klapky sa nepodarilo overiť.", 500);
      if (!consistency.data || consistency.data.phone_extension !== extension.extension) {
        throw new MutationError(
          "Uložené priradenie nemá zhodnú profilovú rezerváciu. Stav bol ponechaný bez zmeny; obnov údaje a vyrieš nekonzistenciu.",
          409,
        );
      }
    }
    return { id: extension.id, extension: extension.extension, profile_id: extension.profile_id };
  }

  if (
    extension.profile_id &&
    nextProfileId &&
    extension.profile_id !== nextProfileId
  ) {
    throw new MutationError(
      "Osobnú klapku nemožno odovzdať priamo inému používateľovi. Najprv ju odpoj, vo VIPTel otoč SIP heslo a až potom ju priraď novému vlastníkovi.",
      409,
    );
  }

  const provisioningRequirement = nextProfileId
    ? await assignmentProvisioningRequirement(supabase, actor.organizationId, extension)
    : undefined;
  const attestation = nextProfileId && provisioningRequirement
    ? readAssignmentAttestation(
        provisioningRequirement,
        rotationReference,
        rotationAttested,
        initialProvisioningAttested,
      )
    : undefined;
  let profile: Pick<ProfileRow, "id" | "phone_extension" | "updated_at"> | undefined;
  let legacyProfileExtension: string | undefined;

  if (nextProfileId) {
    const profileResult = await supabase
      .from("motorist_profiles")
      .select("id, phone_extension, updated_at")
      .eq("id", nextProfileId)
      .eq("organization_id", actor.organizationId)
      .eq("active", true)
      .maybeSingle();

    if (profileResult.error) {
      throw new MutationError("Operátora sa nepodarilo overiť.", 500);
    }

    if (!profileResult.data) {
      throw new MutationError("Aktívny operátor sa nenašiel.", 404);
    }

    profile = profileResult.data;
    if (
      profile.phone_extension !== null &&
      !isLegacySeededProfileExtension(profile.phone_extension)
    ) {
      throw new MutationError(
        `Operátor už má rezervovanú klapku ${profile.phone_extension}. Iba starú demo klapku 101–105 možno pri explicitnom priradení bezpečne nahradiť.`,
        409,
      );
    }
    legacyProfileExtension = profile.phone_extension ?? undefined;

    const existingAssignment = await supabase
      .from("motorist_telephony_extensions")
      .select("id, extension")
      .eq("organization_id", actor.organizationId)
      .eq("provider", PROVIDER)
      .eq("profile_id", nextProfileId)
      .eq("active", true)
      .neq("id", extensionResult.data.id)
      .limit(1)
      .maybeSingle();

    if (existingAssignment.error) {
      throw new MutationError("Existujúce priradenie operátora sa nepodarilo overiť.", 500);
    }

    if (existingAssignment.data) {
      throw new MutationError(
        `Operátor už vlastní klapku ${existingAssignment.data.extension}. Najprv ju odpoj a potom priraď novú.`,
        409,
      );
    }
  } else if (extension.profile_id) {
    const profileResult = await supabase
      .from("motorist_profiles")
      .select("id, phone_extension, updated_at")
      .eq("id", extension.profile_id)
      .eq("organization_id", actor.organizationId)
      .maybeSingle();
    if (profileResult.error) throw new MutationError("Rezerváciu vlastníka klapky sa nepodarilo načítať.", 500);
    if (!profileResult.data || profileResult.data.phone_extension !== extension.extension) {
      throw new MutationError(
        "Rezervácia osobnej klapky v profile nezodpovedá vlastníkovi. Zmena bola bezpečne zastavená; obnov stav a vyrieš nekonzistenciu.",
        409,
      );
    }
    profile = profileResult.data;
  }

  const changedAt = now();
  const transition = await beginAssignmentTransition(
    supabase,
    actor,
    { ...extension, active: true },
    nextProfileId ?? null,
    {
      now: () => changedAt,
      profileReservationPreviousExtension: nextProfileId ? profile?.phone_extension ?? null : undefined,
      randomId: dependencies.randomId,
    },
  );
  try {
    await assertLiveAssignmentSafety(
      supabase,
      actor.organizationId,
      actor.profileId,
      transition.extension,
      dependencies.viptel,
      legacyProfileExtension,
    );
    const refreshedTransition = await refreshAssignmentTransition(supabase, actor, transition);

    if (nextProfileId && profile && attestation) {
      return await assignUnownedExtension({
        actor,
        attestation,
        changedAt,
        client: supabase,
        extension: refreshedTransition.extension,
        lifecycleEpoch: refreshedTransition.generation,
        profile,
      });
    }

    if (!nextProfileId && refreshedTransition.extension.profile_id && profile) {
      return await unassignOwnedExtension({ actor, changedAt, client: supabase, extension: refreshedTransition.extension, profile });
    }

    throw new MutationError("Zmena priradenia nemá platný bezpečný prechod.", 409);
  } catch (error) {
    // The target profile may still reserve this extension. Keep the exact
    // transition durable so bounded stale recovery can inspect and clear it.
    if (error instanceof AssignmentReservationRecoveryRequired) throw error;
    const released = await releaseAssignmentTransition(supabase, actor, transition);
    if (!released) {
      throw new MutationError(
        "Zmena priradenia zlyhala a bezpečnostný interlock zostal aktívny. Klapku nepoužívaj; obnov stav a eskaluj ručné uvoľnenie.",
        409,
      );
    }
    throw error;
  }
}

async function assignUnownedExtension(input: {
  actor: MotoristActor;
  attestation: ExtensionAssignmentAttestation;
  changedAt: string;
  client: AdminClient;
  extension: Pick<ExtensionRow, "id" | "extension" | "metadata" | "profile_id" | "updated_at">;
  lifecycleEpoch: string;
  profile: Pick<ProfileRow, "id" | "phone_extension" | "updated_at">;
}) {
  const { actor, attestation, changedAt, client, extension, lifecycleEpoch, profile } = input;
  let reservationQuery = client
    .from("motorist_profiles")
    .update({ phone_extension: extension.extension })
    .eq("id", profile.id)
    .eq("organization_id", actor.organizationId)
    .eq("updated_at", profile.updated_at);
  reservationQuery = profile.phone_extension === null
    ? reservationQuery.is("phone_extension", null)
    : reservationQuery.eq("phone_extension", profile.phone_extension);
  const reservation = await reservationQuery
    .select("id, phone_extension, updated_at")
    .maybeSingle();
  if (reservation.error) {
    const race = isUniqueViolation(reservation.error);
    throw new MutationError(
      race
        ? "Klapku alebo operátora medzitým rezervovala iná požiadavka. Obnov stav."
        : "Profilovú rezerváciu klapky sa nepodarilo uložiť.",
      race ? 409 : 500,
    );
  }
  if (!reservation.data) {
    throw new MutationError("Operátora medzitým zmenila iná požiadavka. Obnov stav.", 409);
  }

  const metadata = assignmentMetadata(extension.metadata, {
    assignedAt: changedAt,
    assignedBy: actor.profileId,
    assignedToProfileId: profile.id,
    assignmentMode: attestation.mode,
    attestation,
    extension: extension.extension,
    extensionId: extension.id,
    lifecycleEpoch,
  });
  const lifecycle = readAssignmentLifecycle(jsonRecord(metadata).assignmentLifecycle);
  if (!lifecycle) throw new MutationError("Assignment lifecycle sa nepodarilo bezpečne vytvoriť.", 500);
  const update = await client
    .from("motorist_telephony_extensions")
    .update({ profile_id: profile.id, metadata })
    .eq("id", extension.id)
    .eq("organization_id", actor.organizationId)
    .eq("updated_at", extension.updated_at)
    .is("profile_id", null)
    .select("id, extension, profile_id")
    .maybeSingle();

  if (update.error || !update.data) {
    const rollback = await rollbackProfileReservation(client, actor.organizationId, {
      ...reservation.data,
      phone_extension: extension.extension,
    }, profile.phone_extension);
    if (!rollback.ok) {
      const auditOk = await tryWriteAssignmentAudit(client, {
        action: "telephony.extension.assign.reservation_stuck",
        actor,
        after: {
          extension: extension.extension,
          profile_id: profile.id,
          reservation_stuck: true,
          credential_attestation: attestation,
        },
        before: { extension: extension.extension, profile_id: null },
        entityId: extension.id,
      });
      throw new AssignmentReservationRecoveryRequired(
        `Priradenie klapky sa neuložilo, ale profilová rezervácia mohla zostať. Obnov stav a zásah neopakuj${auditOk ? "." : "; zároveň zlyhal audit."}`,
      );
    }
    throw new MutationError(
      update.error
        ? "Priradenie klapky sa nepodarilo uložiť; profilová rezervácia bola bezpečne vrátená."
        : "Priradenie klapky medzitým zmenila iná požiadavka; profilová rezervácia bola bezpečne vrátená.",
      update.error ? 500 : 409,
    );
  }

  await writeAssignmentAudit(client, {
    action: "telephony.extension.assign",
    actor,
    after: {
      extension: extension.extension,
      profile_id: profile.id,
      assignment_lifecycle: lifecycleAuditPayload(lifecycle),
      credential_attestation: attestation,
      ...(profile.phone_extension
        ? { legacy_profile_extension_replaced: profile.phone_extension }
        : {}),
    },
    before: {
      extension: extension.extension,
      profile_id: null,
      profile_phone_extension: profile.phone_extension,
    },
    entityId: extension.id,
  });
  return update.data;
}

async function unassignOwnedExtension(input: {
  actor: MotoristActor;
  changedAt: string;
  client: AdminClient;
  extension: Pick<ExtensionRow, "id" | "extension" | "metadata" | "profile_id" | "updated_at">;
  profile: Pick<ProfileRow, "id" | "phone_extension" | "updated_at">;
  sharedWorkplaceRelease?: boolean;
}) {
  const { actor, changedAt, client, extension, profile, sharedWorkplaceRelease = false } = input;
  const quarantine = sharedWorkplaceRelease
    ? {
        active: false,
        extension: extension.extension,
        previousProfileId: profile.id,
        releasedAt: changedAt,
        releasedBy: actor.profileId,
        sharingMode: "workplace_claim",
      }
    : {
        active: true,
        extension: extension.extension,
        previousProfileId: profile.id,
        requiresSipCredentialRotation: true,
        unassignedAt: changedAt,
        unassignedBy: actor.profileId,
      };
  const currentLifecycle = readAssignmentLifecycle(jsonRecord(extension.metadata).assignmentLifecycle);
  const lifecycle = currentLifecycle
    ? unassignedLifecycle(currentLifecycle, { unassignedAt: changedAt, unassignedBy: actor.profileId })
    : undefined;
  const metadata = {
    ...withoutAssignmentTransition(extension.metadata),
    assignmentQuarantine: quarantine,
    ...(lifecycle ? { assignmentLifecycle: lifecycle } : {}),
  };
  const update = await client
    .from("motorist_telephony_extensions")
    .update({ profile_id: null, metadata: toJson(metadata) })
    .eq("id", extension.id)
    .eq("organization_id", actor.organizationId)
    .eq("updated_at", extension.updated_at)
    .eq("profile_id", profile.id)
    .select("id, extension, profile_id")
    .maybeSingle();
  if (update.error) throw new MutationError("Odpojenie klapky sa nepodarilo uložiť.", 500);
  if (!update.data) throw new MutationError("Priradenie klapky medzitým zmenila iná požiadavka. Obnov stav.", 409);

  const release = await client
    .from("motorist_profiles")
    .update({ phone_extension: null })
    .eq("id", profile.id)
    .eq("organization_id", actor.organizationId)
    .eq("updated_at", profile.updated_at)
    .eq("phone_extension", extension.extension)
    .select("id")
    .maybeSingle();
  if (release.error || !release.data) {
    const auditOk = await tryWriteAssignmentAudit(client, {
      action: "telephony.extension.unassign.reservation_stuck",
      actor,
      after: { extension: extension.extension, profile_id: null, profile_reservation_stuck: true, quarantine },
      before: { extension: extension.extension, profile_id: profile.id },
      entityId: extension.id,
    });
    throw new MutationError(
      `Klapka bola odpojená, ale profilovú rezerváciu sa nepodarilo uvoľniť. Obnov stav; ďalšie priradenie zostáva bezpečne zablokované${auditOk ? "." : "; zároveň zlyhal audit."}`,
      409,
    );
  }

  await writeAssignmentAudit(client, {
    action: "telephony.extension.unassign",
    actor,
    after: {
      extension: extension.extension,
      profile_id: null,
      quarantine,
      ...(sharedWorkplaceRelease ? { sharing_mode: "workplace_claim" } : {}),
      ...(lifecycle ? { assignment_lifecycle: lifecycleAuditPayload(lifecycle) } : {}),
    },
    before: { extension: extension.extension, profile_id: profile.id },
    entityId: extension.id,
  });
  return update.data;
}

export async function assertLiveAssignmentSafety(
  client: AdminClient,
  organizationId: string,
  requestedBy: string,
  extension: Pick<ExtensionRow, "extension" | "id">,
  configuredViptel?: Pick<ViptelClient, "getQueueStatus" | "listActiveCalls" | "listExtensions">,
  legacyProfileExtension?: string,
) {
  let live: {
    activeCalls: ViptelActiveCall[];
    extensions: ViptelExtension[];
    queueStatuses: ViptelQueueStatus[];
  };
  try {
    if (configuredViptel) {
      const [extensions, activeCalls, queueStatuses] = await Promise.all([
        configuredViptel.listExtensions(),
        configuredViptel.listActiveCalls(),
        Promise.all(DISPATCH_QUEUE_NUMBERS.map((queue) => configuredViptel.getQueueStatus(queue))),
      ]);
      live = { extensions, activeCalls, queueStatuses };
    } else {
      const snapshot = await requestViptelProviderSnapshot(organizationId, requestedBy, {
        maxAgeMs: 2_000,
        requireNewCapture: true,
      });
      live = {
        extensions: snapshot.extensions,
        activeCalls: snapshot.activeCalls,
        queueStatuses: snapshot.queueStatuses,
      };
    }
  } catch {
    throw new MutationError("Živý stav VIPTel sa nepodarilo overiť. Priradenie bolo bezpečne zastavené.", 502);
  }
  assertProviderAssignmentSafety(extension.extension, live);
  if (legacyProfileExtension) {
    if (live.activeCalls.some((call) => activeCallReferencesEndpoint(call, legacyProfileExtension))) {
      throw new MutationError(
        `Pôvodná klapka ${legacyProfileExtension} má v živom VIPTel stave aktívny hovor. Priradenie bolo zastavené.`,
        409,
      );
    }
    if (live.queueStatuses.some((status) => status.members.some(
      (member) => exactEndpoint(member.extension) === legacyProfileExtension,
    ))) {
      throw new MutationError(
        `Pôvodná klapka ${legacyProfileExtension} je stále členom radu. Najprv ju z radu odstráň.`,
        409,
      );
    }
  }

  const catalogResult = await client
    .from("motorist_telephony_queues")
    .select("id, external_id, line_id, metadata, updated_at")
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .in("external_id", [...DISPATCH_QUEUE_NUMBERS])
    .eq("active", true)
    .is("line_id", null);
  if (catalogResult.error) throw new MutationError("Plán priorít sa nepodarilo bezpečne overiť.", 500);
  const catalog = catalogResult.data ?? [];
  const completeCatalog = DISPATCH_QUEUE_NUMBERS.every(
    (queue) => catalog.filter((row) => row.external_id === queue).length === 1,
  );
  if (!completeCatalog || catalog.length !== DISPATCH_QUEUE_NUMBERS.length) {
    throw new MutationError("Riadený katalóg radov 601–603 nie je pripravený; priradenie bolo bezpečne zastavené.", 409);
  }
  const root = catalog.find((row) => row.external_id === "601") as (typeof catalog)[number];
  let state: DispatchRoutingState;
  try {
    state = parseDispatchRoutingState(root.metadata);
  } catch {
    throw new MutationError("Plán priorít je neplatný; priradenie bolo bezpečne zastavené.", 409);
  }
  await requireAssignmentSafeDispatchRoutingState(client, organizationId, root, state);
  if (dispatchRoutingReferencesExtension(state, extension.extension)) {
    throw new MutationError(
      `Klapka ${extension.extension} je stále uvedená v aktuálnom alebo rozpracovanom pláne priorít. Najprv ju odstráň z plánu.`,
      409,
    );
  }
  const workplaceDraftSelections = readApplicableWorkplacePriorityDraft(root.metadata, state.revision, {
    organizationId,
    rootQueueId: root.id,
  });
  if (workplaceDraftSelections) {
    await requireLatestWorkplacePriorityDraftAuthority(
      client,
      jsonRecord(root.metadata).workplacePriorityDraft,
      { organizationId, rootQueueId: root.id },
    );
  }
  if (workplaceDraftSelections && Object.values(workplaceDraftSelections).includes(extension.extension)) {
    throw new MutationError(
      `Pracovné miesto ${extension.extension} je stále vybrané v rozpracovaných prioritách. Najprv uvoľni jeho prioritu.`,
      409,
    );
  }
  if (legacyProfileExtension && dispatchRoutingReferencesExtension(state, legacyProfileExtension)) {
    throw new MutationError(
      `Pôvodná klapka ${legacyProfileExtension} je stále uvedená v pláne priorít. Najprv ju z plánu odstráň.`,
      409,
    );
  }

  const commandResult = await client
    .from("motorist_telephony_commands")
    .select("id, call_id, command_type, extension_id, request_payload, status")
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .in("status", [...NON_TERMINAL_COMMAND_STATUSES])
    .order("created_at", { ascending: true })
    .limit(COMMAND_SCAN_LIMIT);
  if (commandResult.error) throw new MutationError("Rozpracované telekomunikačné príkazy sa nepodarilo overiť.", 500);
  if ((commandResult.data ?? []).length >= COMMAND_SCAN_LIMIT) {
    throw new MutationError("Fronta telekomunikačných príkazov je príliš veľká na bezpečné overenie.", 409);
  }
  const terminalBrowserTransferCallIds = await loadTerminalAcceptedBrowserTransferCallIds(client, organizationId, commandResult.data ?? []);
  if (hasBlockingExtensionCommand(commandResult.data ?? [], extension.id, extension.extension, { terminalBrowserTransferCallIds })) {
    throw new MutationError(`Klapka ${extension.extension} má rozpracovaný telekomunikačný príkaz. Počkaj na jeho ukončenie.`, 409);
  }
  if (
    legacyProfileExtension &&
    hasBlockingExtensionCommand(commandResult.data ?? [], "", legacyProfileExtension, { terminalBrowserTransferCallIds })
  ) {
    throw new MutationError(
      `Pôvodná klapka ${legacyProfileExtension} má rozpracovaný telekomunikačný príkaz. Počkaj na jeho ukončenie.`,
      409,
    );
  }
}

export function assertProviderAssignmentSafety(
  extension: string,
  live: {
    activeCalls: ViptelActiveCall[];
    extensions: ViptelExtension[];
    queueStatuses: ViptelQueueStatus[];
  },
) {
  const matches = live.extensions.filter((candidate) => exactEndpoint(candidate.extension) === extension);
  if (matches.length !== 1 || matches[0].isRegistered !== false) {
    throw new MutationError(`Klapka ${extension} musí byť v živom VIPTel stave jednoznačne nájdená a odregistrovaná.`, 409);
  }
  const completeQueueSnapshot =
    live.queueStatuses.length === DISPATCH_QUEUE_NUMBERS.length &&
    DISPATCH_QUEUE_NUMBERS.every(
      (queue) => live.queueStatuses.filter((status) => status.queue === queue).length === 1,
    );
  if (!completeQueueSnapshot) {
    throw new MutationError("VIPTel nevrátil jednoznačný živý stav všetkých radov 601–603.", 409);
  }
  if (live.activeCalls.some((call) => activeCallReferencesEndpoint(call, extension))) {
    throw new MutationError(`Klapka ${extension} má v živom VIPTel stave aktívny hovor.`, 409);
  }
  if (
    live.queueStatuses.some(
      (status) =>
        DISPATCH_QUEUE_NUMBERS.includes(status.queue as (typeof DISPATCH_QUEUE_NUMBERS)[number]) &&
        status.members.some((member) => exactEndpoint(member.extension) === extension),
    )
  ) {
    throw new MutationError(`Klapka ${extension} je stále členom jedného z radov 601–603.`, 409);
  }
}

export function dispatchRoutingReferencesExtension(state: DispatchRoutingState, extension: string) {
  const plans = [state.currentPlan, state.operation?.previousPlan, state.operation?.targetPlan].filter(
    (plan): plan is DispatchRoutingState["currentPlan"] => Boolean(plan),
  );
  if (plans.some((plan) => Object.values(plan).includes(extension))) return true;
  const operation = state.operation;
  return Boolean(
    operation &&
      (operation.fallback.extension === extension ||
        operation.affectedExtensions.includes(extension) ||
        operation.steps.some((step) => step.extension === extension)),
  );
}

export { hasBlockingExtensionCommand };

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

function readRotationAttestation(reference: unknown, attested: unknown): ExtensionRotationAttestation {
  const rotationReference = typeof reference === "string" ? reference.trim() : "";
  if (
    rotationReference.length < 6 ||
    rotationReference.length > 120 ||
    !/^[\p{L}\p{N}][\p{L}\p{N} ._:/#-]*$/u.test(rotationReference)
  ) {
    throw new MutationError(
      "Pri novom priradení zadaj 6–120 znakový odkaz na vykonanú rotáciu SIP prístupu (nie heslo).",
      400,
    );
  }
  if (attested !== true) {
    throw new MutationError("Potvrď, že SIP prístup bol vo VIPTel otočený a referencia neobsahuje heslo.", 400);
  }
  return { mode: "rotated_handoff", rotationAttested: true, rotationReference };
}

function readAssignmentAttestation(
  requirement: AssignmentProvisioningRequirement,
  rotationReference: unknown,
  rotationAttested: unknown,
  initialProvisioningAttested: unknown,
): ExtensionAssignmentAttestation {
  if (requirement === "initial_provisioning") {
    if (initialProvisioningAttested !== true) {
      throw new MutationError(
        "Potvrď prvotné pridelenie doteraz nepoužitej klapky. Toto potvrdenie nenahrádza rotáciu pri ďalšom odovzdaní.",
        400,
      );
    }
    return { mode: "initial_provisioning", initialProvisioningAttested: true };
  }
  return readRotationAttestation(rotationReference, rotationAttested);
}

function assignmentMetadata(
  current: Json,
  attestation: {
    assignedAt: string;
    assignedBy: string;
    assignedToProfileId: string;
    assignmentMode: ExtensionAssignmentAttestation["mode"];
    attestation: ExtensionAssignmentAttestation;
    extension: string;
    extensionId: string;
    lifecycleEpoch: string;
  },
) {
  const root = withoutAssignmentTransition(current);
  const previousQuarantine = jsonRecord(root.assignmentQuarantine);
  const lifecycle = assignedLifecycle({
    assignedAt: attestation.assignedAt,
    assignedBy: attestation.assignedBy,
    assignmentMode: attestation.assignmentMode,
    epoch: attestation.lifecycleEpoch,
    extension: attestation.extension,
    extensionId: attestation.extensionId,
    profileId: attestation.assignedToProfileId,
  });
  return toJson({
    ...root,
    assignmentAttestation: {
      assignedAt: attestation.assignedAt,
      assignedBy: attestation.assignedBy,
      assignedToProfileId: attestation.assignedToProfileId,
      ...attestation.attestation,
    },
    assignmentLifecycle: lifecycle,
    ...(Object.keys(previousQuarantine).length > 0
      ? {
          assignmentQuarantine: {
            ...previousQuarantine,
            active: false,
            clearedAt: attestation.assignedAt,
            clearedBy: attestation.assignedBy,
            ...(attestation.attestation.mode === "rotated_handoff"
              ? { rotationReference: attestation.attestation.rotationReference }
              : {}),
          },
        }
      : {}),
  });
}

async function rollbackProfileReservation(
  client: AdminClient,
  organizationId: string,
  reservation: { id: string; phone_extension: string; updated_at: string },
  restorePhoneExtension: string | null = null,
) {
  const result = await client
    .from("motorist_profiles")
    .update({ phone_extension: restorePhoneExtension })
    .eq("id", reservation.id)
    .eq("organization_id", organizationId)
    .eq("updated_at", reservation.updated_at)
    .eq("phone_extension", reservation.phone_extension)
    .select("id")
    .maybeSingle();
  return { ok: !result.error && Boolean(result.data) };
}

async function recoverOrphanedUnassignmentReservation(
  client: AdminClient,
  actor: MotoristActor,
  extension: Pick<ExtensionRow, "id" | "extension" | "metadata" | "profile_id" | "updated_at">,
  dependencies: Pick<AssignmentDependencies, "randomId" | "viptel">,
  now: () => string,
) {
  const quarantine = readActiveAssignmentQuarantine(extension.metadata, extension.extension);
  if (!quarantine) return;
  if (extension.profile_id !== null) {
    throw new MutationError(
      "Aktívna karanténa klapky nezodpovedá jej vlastníkovi. Stav bol ponechaný bez zmeny; eskaluj ručné zotavenie.",
      409,
    );
  }

  const previousProfile = await client
    .from("motorist_profiles")
    .select("id, phone_extension, updated_at")
    .eq("id", quarantine.previousProfileId)
    .eq("organization_id", actor.organizationId)
    .maybeSingle();
  if (previousProfile.error) {
    throw new MutationError("Rezerváciu profilu po odpojení klapky sa nepodarilo overiť.", 500);
  }
  if (!previousProfile.data) {
    throw new MutationError(
      "Predchádzajúci profil z karantény sa nenašiel. Stav bol ponechaný bez zmeny; eskaluj ručné zotavenie.",
      409,
    );
  }
  if (previousProfile.data.phone_extension === null) return;
  if (previousProfile.data.phone_extension !== extension.extension) {
    if (/^\d{1,8}$/.test(previousProfile.data.phone_extension)) return;
    throw new MutationError(
      "Predchádzajúci profil z karantény má neplatnú rezerváciu. Stav bol ponechaný bez zmeny; eskaluj ručné zotavenie.",
      409,
    );
  }

  const recoveryAt = now();
  const transition = await beginAssignmentTransition(
    client,
    actor,
    { ...extension, active: true },
    null,
    { now: () => recoveryAt, randomId: dependencies.randomId },
  );
  let reservationReleased = false;
  try {
    await assertLiveAssignmentSafety(
      client,
      actor.organizationId,
      actor.profileId,
      transition.extension,
      dependencies.viptel,
    );
    const refreshed = await refreshAssignmentTransition(client, actor, transition);
    const release = await rollbackProfileReservation(client, actor.organizationId, {
      id: previousProfile.data.id,
      phone_extension: extension.extension,
      updated_at: previousProfile.data.updated_at,
    });
    if (!release.ok) {
      throw new MutationError(
        "Rezerváciu profilu po odpojení klapky súbežne zmenila iná požiadavka. Obnov stav.",
        409,
      );
    }
    reservationReleased = true;
    if (!await releaseAssignmentTransition(client, actor, refreshed)) {
      throw new MutationError(
        "Rezervácia profilu bola uvoľnená, ale recovery interlock zostal aktívny. Klapku nepoužívaj a eskaluj zotavenie.",
        409,
      );
    }
  } catch (error) {
    const unlocked = await releaseAssignmentTransition(client, actor, transition);
    if (!unlocked) {
      throw new MutationError(
        "Obnova profilovej rezervácie zlyhala a assignment interlock zostal aktívny. Klapku nepoužívaj a eskaluj zotavenie.",
        409,
      );
    }
    if (!reservationReleased) throw error;
  }

  const audited = await tryWriteAssignmentAudit(client, {
    action: "telephony.extension.unassign.reservation_recover",
    actor,
    after: {
      extension: extension.extension,
      profile_id: null,
      profile_reservation_released: true,
      recovered_at: recoveryAt,
    },
    before: {
      extension: extension.extension,
      previous_profile_id: quarantine.previousProfileId,
      profile_reservation_stuck: true,
    },
    entityId: extension.id,
  });
  throw new MutationError(
    `Osirelá profilová rezervácia po odpojení klapky bola bezpečne uvoľnená${audited ? ". Obnov stav a požiadavku zopakuj." : ", ale audit zlyhal; požiadavku neopakuj a eskaluj."}`,
    409,
  );
}

function readActiveAssignmentQuarantine(metadata: unknown, extension: string) {
  const quarantine = jsonRecord(jsonRecord(metadata).assignmentQuarantine);
  if (quarantine.active !== true) return undefined;
  const previousProfileId = typeof quarantine.previousProfileId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(quarantine.previousProfileId)
    ? quarantine.previousProfileId
    : undefined;
  if (
    !previousProfileId ||
    quarantine.extension !== extension ||
    quarantine.requiresSipCredentialRotation !== true
  ) {
    throw new MutationError(
      "Aktívna karanténa klapky má neplatné recovery údaje. Klapku nepoužívaj a eskaluj ručné zotavenie.",
      409,
    );
  }
  return { previousProfileId };
}

async function recoverStaleTransitionProfileReservation(
  client: AdminClient,
  organizationId: string,
  extension: Pick<ExtensionRow, "extension" | "profile_id">,
  transition: NonNullable<ReturnType<typeof readAssignmentTransition>>,
) {
  // An unassignment starts with an existing owner reservation and must not
  // release it while the extension row still belongs to that owner.
  if (!transition.toProfileId) return { profileReservationRolledBack: false };
  if (transition.fromProfileId !== null || extension.profile_id !== null) {
    throw new MutationError(
      "Uviaznutý assignment interlock má neplatný profilový prechod. Rezervácia zostala zachovaná; eskaluj ručné zotavenie.",
      409,
    );
  }

  const profile = await client
    .from("motorist_profiles")
    .select("id, phone_extension, updated_at")
    .eq("id", transition.toProfileId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (profile.error) {
    throw new MutationError("Profilovú rezerváciu uviaznutého priradenia sa nepodarilo overiť.", 500);
  }
  if (!profile.data) {
    throw new MutationError(
      "Cieľový profil uviaznutého priradenia sa nenašiel. Interlock zostal aktívny; eskaluj ručné zotavenie.",
      409,
    );
  }
  if (profile.data.phone_extension === transition.profileReservationPreviousExtension) {
    return { profileReservationRolledBack: false };
  }
  if (profile.data.phone_extension !== extension.extension) {
    throw new MutationError(
      "Cieľový profil uviaznutého priradenia má inú rezerváciu. Interlock zostal aktívny; eskaluj ručné zotavenie.",
      409,
    );
  }
  // Transition metadata is intentionally not trusted as proof of the previous
  // profile value. When the target reservation is already present, automatic
  // rollback could erase a valid assignment after metadata tampering. Keep the
  // interlock active and require a service-side, audited reconciliation.
  throw new MutationError(
    "Profilová rezervácia po prerušenej zmene vyžaduje ručné zosúladenie. Interlock zostal aktívny; automatický zápis nebol vykonaný.",
    409,
  );
}

async function writeAssignmentAudit(
  client: AdminClient,
  input: {
    action: string;
    actor: MotoristActor;
    after: unknown;
    before: unknown;
    entityId: string;
  },
) {
  const result = await client.from("motorist_audit_log").insert({
    organization_id: input.actor.organizationId,
    actor_profile_id: input.actor.profileId,
    action: input.action,
    entity_type: "motorist_telephony_extensions",
    entity_id: input.entityId,
    source: "web",
    before_payload: toJson(input.before),
    after_payload: toJson(input.after),
  });
  if (result.error) {
    throw new MutationError(
      "Zmena priradenia sa uložila, ale audit sa nepodarilo zapísať. Zásah neopakuj; obnov stav a eskaluj auditnú chybu.",
      500,
    );
  }
}

async function tryWriteAssignmentAudit(
  client: AdminClient,
  input: Parameters<typeof writeAssignmentAudit>[1],
) {
  try {
    await writeAssignmentAudit(client, input);
    return true;
  } catch {
    return false;
  }
}

function isUniqueViolation(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function providerSyncIsNewer(lastSyncedAt: string | null, checkedAt: string) {
  if (!lastSyncedAt) return false;
  const currentTimestamp = Date.parse(lastSyncedAt);
  const incomingTimestamp = Date.parse(checkedAt);
  return Number.isFinite(currentTimestamp) && Number.isFinite(incomingTimestamp) && currentTimestamp > incomingTimestamp;
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

function assignmentSemanticsAreUnchanged(previous: ExtensionRow, current: ExtensionRow) {
  return previous.id === current.id &&
    previous.extension === current.extension &&
    previous.profile_id === current.profile_id &&
    previous.active === current.active &&
    previous.workplace_seat_generation === current.workplace_seat_generation &&
    jsonValuesEqual(previous.metadata, current.metadata);
}

async function synchronizeExistingViptelExtension(
  supabase: AdminClient,
  organizationId: string,
  providerExtension: ViptelExtension,
  checkedAt: string,
  synchronized: Database["public"]["Tables"]["motorist_telephony_extensions"]["Update"],
  existing: ExtensionRow,
) {
  const assignmentBaseline = existing;
  let current = existing;

  for (let attempt = 0; attempt < PROVIDER_SYNC_CAS_ATTEMPTS; attempt += 1) {
    if (hasActiveAssignmentTransitionMetadata(current.metadata)) return;
    if (providerSyncIsNewer(current.last_synced_at, checkedAt)) return;

    // Only provider-owned telemetry is written. Application-owned assignment,
    // lifecycle and transition fields deliberately remain untouched.
    const synced = await supabase
      .from("motorist_telephony_extensions")
      .update(synchronized)
      .eq("id", current.id)
      .eq("organization_id", organizationId)
      .eq("provider", PROVIDER)
      .eq("extension", providerExtension.extension)
      .eq("updated_at", current.updated_at)
      .select("id")
      .maybeSingle();
    if (synced.error) {
      throw new MutationError(`VIPTel klapku ${providerExtension.extension} sa nepodarilo synchronizovať.`, 500);
    }
    if (synced.data) return;

    // A concurrent assignment or provider refresh won the CAS. Re-read the
    // exact row before deciding whether the same snapshot is still safe to
    // apply. Retry only across provider-only row drift; an ownership,
    // lifecycle or generation change requires a newly captured snapshot.
    const reloaded = await supabase
      .from("motorist_telephony_extensions")
      .select("*")
      .eq("id", current.id)
      .eq("organization_id", organizationId)
      .eq("provider", PROVIDER)
      .eq("extension", providerExtension.extension)
      .maybeSingle();
    if (reloaded.error) {
      throw new MutationError(`VIPTel klapku ${providerExtension.extension} sa nepodarilo po súbežnej zmene overiť.`, 500);
    }
    if (!reloaded.data) return;
    if (!assignmentSemanticsAreUnchanged(assignmentBaseline, reloaded.data)) return;
    if (hasActiveAssignmentTransitionMetadata(reloaded.data.metadata)) return;
    if (providerSyncIsNewer(reloaded.data.last_synced_at, checkedAt)) return;
    current = reloaded.data;
  }

  throw new MutationError(
    `VIPTel klapku ${providerExtension.extension} sa nepodarilo zosúladiť pre opakovanú súbežnú zmenu. Obnov stav.`,
    409,
  );
}

export async function synchronizeViptelExtensions(
  organizationId: string,
  providerExtensions: ViptelExtension[],
  checkedAt: string,
  configuredClient?: AdminClient,
) {
  const supabase = configuredClient ?? createSupabaseAdminClient();
  const existingResult = await supabase
    .from("motorist_telephony_extensions")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER);

  if (existingResult.error) {
    throw new MutationError("VIPTel klapky sa nepodarilo načítať pred synchronizáciou.", 500);
  }

  const validProviderExtensions = providerExtensions.filter((extension) => /^\d{1,8}$/.test(extension.extension));
  if (validProviderExtensions.length === 0 && (existingResult.data ?? []).some((row) => row.active)) {
    throw new MutationError("VIPTel vrátil prázdny zoznam klapiek. Existujúce priradenia zostali zachované.", 502);
  }
  const providerNumbers = new Set(validProviderExtensions.map((extension) => extension.extension));
  const existingByNumber = new Map((existingResult.data ?? []).map((row) => [row.extension, row]));

  for (const providerExtension of validProviderExtensions) {
    const existing = existingByNumber.get(providerExtension.extension);
    if (existing && hasActiveAssignmentTransitionMetadata(existing.metadata)) {
      continue;
    }
    const callForwarding = normalizeForwarding(providerExtension.callForwarding);
    const changed =
      !existing ||
      existing.display_name !== (providerExtension.name ?? null) ||
      existing.outbound_cid !== (providerExtension.outboundCid ?? null) ||
      existing.call_forwarding !== callForwarding ||
      existing.is_registered !== (providerExtension.isRegistered ?? null) ||
      existing.is_viptel_phone_active !== (providerExtension.isViptelPhoneActive ?? null) ||
      !sameStringArray(existing.allowed_changes, providerExtension.allowedChanges) ||
      existing.active !== true;
    const heartbeatDue = !existing?.last_synced_at || Date.parse(checkedAt) - Date.parse(existing.last_synced_at) >= SYNC_HEARTBEAT_MS;

    if (!changed && !heartbeatDue) {
      continue;
    }

    const synchronized = {
      external_id: providerExtension.extension,
      active: true,
      display_name: providerExtension.name ?? null,
      outbound_cid: providerExtension.outboundCid ?? null,
      call_forwarding: callForwarding,
      is_registered: providerExtension.isRegistered ?? null,
      is_viptel_phone_active: providerExtension.isViptelPhoneActive ?? null,
      allowed_changes: providerExtension.allowedChanges,
      last_synced_at: checkedAt,
      raw_payload: toJson(providerExtension.raw),
    };

    if (existing) {
      await synchronizeExistingViptelExtension(
        supabase,
        organizationId,
        providerExtension,
        checkedAt,
        synchronized,
        existing,
      );
      continue;
    }

    // Do not use an upsert here. This snapshot was captured without an
    // existing-row assignment baseline, so a concurrent insert means the same
    // snapshot is no longer safe to replay over the newly created identity.
    // A following fresh refresh will synchronize that winner.
    const { error } = await supabase.from("motorist_telephony_extensions").insert({
      organization_id: organizationId,
      provider: PROVIDER,
      extension: providerExtension.extension,
      ...synchronized,
    });

    if (error && !isUniqueViolation(error)) {
      throw new MutationError(`VIPTel klapku ${providerExtension.extension} sa nepodarilo vytvoriť.`, 500);
    }
  }

  const missingProviderRows = (existingResult.data ?? [])
    .filter((row) =>
      row.active &&
      !providerNumbers.has(row.extension) &&
      !hasActiveAssignmentTransitionMetadata(row.metadata) &&
      !providerSyncIsNewer(row.last_synced_at, checkedAt));

  for (const row of missingProviderRows) {
    const deactivated = await supabase
      .from("motorist_telephony_extensions")
      .update({ active: false, is_registered: false, last_synced_at: checkedAt })
      .eq("id", row.id)
      .eq("organization_id", organizationId)
      .eq("provider", PROVIDER)
      .eq("updated_at", row.updated_at)
      .select("id")
      .maybeSingle();
    if (deactivated.error) {
      throw new MutationError("Neaktívne VIPTel klapky sa nepodarilo zosynchronizovať.", 500);
    }
  }
}

async function loadTelephonyExtensions(organizationId: string): Promise<TelephonyExtensionSnapshot[]> {
  const client = createSupabaseAdminClient();
  const { data, error } = await client
    .from("motorist_telephony_extensions")
    .select(
      "id, profile_id, extension, active, display_name, outbound_cid, call_forwarding, is_registered, is_viptel_phone_active, allowed_changes, last_synced_at, metadata",
    )
    .eq("organization_id", organizationId)
    .eq("provider", PROVIDER)
    .eq("active", true)
    .order("extension", { ascending: true });

  if (error) {
    throw new MutationError("Synchronizované VIPTel klapky sa nepodarilo načítať.", 500);
  }

  return Promise.all((data ?? []).map(async (row) => ({
    id: row.id,
    profileId: row.profile_id ?? undefined,
    extension: row.extension,
    active: row.active,
    assignmentEligible: isConfiguredPersonalExtension(row.extension),
    assignmentRequirement: await assignmentProvisioningRequirement(client, organizationId, row),
    displayName: row.display_name ?? undefined,
    outboundCid: row.outbound_cid ?? undefined,
    callForwarding: row.call_forwarding ?? undefined,
    registered: row.is_registered ?? undefined,
    viptelPhoneActive: row.is_viptel_phone_active ?? undefined,
    allowedChanges: row.allowed_changes,
    lastSyncedAt: row.last_synced_at ?? undefined,
  })));
}

function normalizeForwarding(value: ViptelExtension["callForwarding"]) {
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "boolean" ? String(value) : value;
}

function sameStringArray(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readRequiredId(value: unknown, label: string) {
  const id = readOptionalId(value, label);
  if (!id) throw new MutationError(`${label} je povinná.`, 400);
  return id;
}

function readOptionalId(value: unknown, label: string) {
  if (value === null || value === undefined || value === "") return undefined;
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim())
  ) {
    throw new MutationError(`${label} nemá platný identifikátor.`, 400);
  }
  return value.trim();
}

function readConfiguredExtension(value: unknown) {
  const extension = typeof value === "string" ? value.trim() : "";
  if (!/^\d{1,8}$/.test(extension) || !isConfiguredPersonalExtension(extension)) {
    throw new MutationError(
      `Pracovné miesto musí byť jedna z liniek ${configuredPersonalExtensions().join(", ")}.`,
      400,
    );
  }
  return extension;
}

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}
