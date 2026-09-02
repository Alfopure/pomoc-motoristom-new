import "server-only";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import { assertSameOriginRequest, requireDefaultMotoristActor, type MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import {
  type AssignmentLifecycle,
  requireImmutableAssignmentLifecycle,
} from "@/server/telephony/assignment-lifecycle";
import {
  workplaceHotdeskCapability,
} from "@/server/telephony/workplace-capability";
import {
  readWorkplaceLease,
  type WorkplaceLease,
} from "@/server/telephony/workplace-lease";
import {
  createWorkplaceOperationRepository,
  type WorkplaceLeaseVerificationResult,
} from "@/server/telephony/workplace-operation-repository";
import { findBootstrappedWorkplaceExtensionIds } from "@/server/telephony/workplace-runtime-state";

type MotoristRole = Database["public"]["Tables"]["motorist_profiles"]["Row"]["role"];
type TelephonyExtensionRow = Database["public"]["Tables"]["motorist_telephony_extensions"]["Row"];

export const TELEPHONY_ACTOR_ROLES: MotoristRole[] = ["dispatcher", "senior_dispatcher", "manager", "admin"];

export type OwnedTelephonyExtension = Pick<
  TelephonyExtensionRow,
  "id" | "extension" | "display_name" | "is_registered" | "last_synced_at"
>;

export type WorkplaceLeaseFence = {
  leaseId: string;
  assignmentGeneration: string;
  browserInstanceId: string;
  leaderEpoch: number;
  leaseVersion: number;
};

export async function requireTelephonyActor(request?: Request) {
  if (request) {
    assertSameOriginRequest(request);
  }

  return requireDefaultMotoristActor(TELEPHONY_ACTOR_ROLES);
}

export async function listOwnedTelephonyExtensions(actor: MotoristActor): Promise<OwnedTelephonyExtension[]> {
  const client = createSupabaseAdminClient();
  const { data, error } = await client
    .from("motorist_telephony_extensions")
    .select("id, extension, display_name, is_registered, last_synced_at, profile_id, metadata")
    .eq("organization_id", actor.organizationId)
    .eq("profile_id", actor.profileId)
    .eq("provider", "viptel")
    .eq("active", true)
    .order("extension", { ascending: true });

  if (error) {
    throw new MutationError("Priradenie telefónnej klapky sa nepodarilo overiť.", 500);
  }

  const verified: OwnedTelephonyExtension[] = [];
  for (const extension of data ?? []) {
    await requireImmutableAssignmentLifecycle(client, actor.organizationId, extension, actor.profileId);
    verified.push({
      id: extension.id,
      extension: extension.extension,
      display_name: extension.display_name,
      is_registered: extension.is_registered,
      last_synced_at: extension.last_synced_at,
    });
  }
  return verified;
}

export async function resolveOwnedTelephonyExtension(actor: MotoristActor, requestedExtension?: unknown) {
  const requested = normalizeRequestedExtension(requestedExtension);
  const extensions = await listOwnedTelephonyExtensions(actor);

  if (requested) {
    const match = extensions.find((item) => item.extension === requested);

    if (!match) {
      throw new MutationError(`Klapka ${requested} nie je priradená prihlásenému používateľovi.`, 403);
    }

    return match;
  }

  if (extensions.length === 1) {
    return extensions[0];
  }

  if (extensions.length === 0) {
    throw new MutationError("Prihlásený používateľ nemá priradenú aktívnu VIPTel klapku.", 403);
  }

  throw new MutationError("Vyber jednu zo svojich priradených klapiek.", 400);
}

/**
 * Requires the actor's authoritative hot-desk lease whenever the additive
 * runtime is enabled or the extension is already canonical. The new-claims
 * kill switch never disables an existing lease fence.
 */
export async function requireActiveWorkplaceLease(
  actor: MotoristActor,
  extension: Pick<TelephonyExtensionRow, "id" | "extension">,
  fence?: WorkplaceLeaseFence,
  dependencies: {
    client?: ReturnType<typeof createSupabaseAdminClient>;
    now?: () => string;
    loadLease?: () => Promise<unknown[]>;
    requireFence?: boolean;
    assignmentLifecycle?: AssignmentLifecycle;
    verifyLease?: () => Promise<WorkplaceLeaseVerificationResult>;
  } = {},
): Promise<WorkplaceLease | undefined> {
  const capability = workplaceHotdeskCapability();
  const client = dependencies.client ?? createSupabaseAdminClient();
  if (!capability.runtimeEnabled) {
    if (dependencies.assignmentLifecycle && dependencies.assignmentLifecycle.assignmentMode !== "workplace_claim") {
      return undefined;
    }
    const bootstrapped = await findBootstrappedWorkplaceExtensionIds(client, actor.organizationId, {
      extensionIds: [extension.id],
    });
    if (!bootstrapped.has(extension.id)) return undefined;
    throw new MutationError(
      "Dynamické pracovisko je pripravené, ale jeho lease runtime je vypnutý. Telefonická akcia bola zastavená.",
      503,
      "hotdesk_runtime_disabled",
    );
  }
  if (dependencies.requireFence && !fence) {
    throw new MutationError("Telefonická akcia vyžaduje aktuálnu reláciu pracoviska.", 400, "lease_fence_required");
  }
  const verification = dependencies.verifyLease
    ? await dependencies.verifyLease()
    : await createWorkplaceOperationRepository(client).verify({
        organizationId: actor.organizationId,
        profileId: actor.profileId,
        extensionId: extension.id,
        leaseId: fence?.leaseId ?? null,
        assignmentGeneration: fence?.assignmentGeneration ?? null,
        browserInstanceId: fence?.browserInstanceId ?? null,
        leaderEpoch: fence?.leaderEpoch ?? null,
        leaseVersion: fence?.leaseVersion ?? null,
        requireFence: dependencies.requireFence === true,
      }).catch(() => {
        throw new MutationError("Reláciu pracoviska sa nepodarilo overiť databázovým časom.", 500);
      });
  if (verification.status === "transitioning") {
    throw new MutationError("Zmena pracovného miesta sa práve dokončuje.", 423, "lease_transitioning");
  }
  if (verification.status !== "verified") {
    throw new MutationError(
      verification.status === "expired"
        ? "Relácia pracoviska vypršala. Obnov pracovisko alebo vyber iné."
        : "Telefonické pracovisko už nepatrí tejto relácii.",
      409,
      "lease_lost",
    );
  }
  const rows = dependencies.loadLease
    ? await dependencies.loadLease()
    : await loadCurrentWorkplaceLeases(
        client,
        actor.organizationId,
        actor.profileId,
        extension.id,
      );
  if (rows.length !== 1) {
    throw new MutationError(
      rows.length === 0
        ? "Telefonické pracovisko už nie je aktívne. Vyber si pracovné miesto znova."
        : "Pracovisko má nejednoznačnú aktívnu reláciu. Telefonovanie bolo zablokované.",
      409,
      "lease_lost",
    );
  }
  const lease = readWorkplaceLease(rows[0]);
  if (
    !lease || lease.organizationId !== actor.organizationId || lease.extensionId !== extension.id ||
    lease.profileId !== actor.profileId
  ) {
    throw new MutationError("Relácia pracoviska nezodpovedá prihlásenému operátorovi.", 409, "lease_lost");
  }
  if (fence && (
    lease.id !== fence.leaseId || lease.assignmentGeneration !== fence.assignmentGeneration ||
    lease.browserInstanceId !== fence.browserInstanceId || lease.leaderEpoch !== fence.leaderEpoch ||
    fence.leaseVersion > lease.leaseVersion
  )) {
    throw new MutationError("Telefón používa starú alebo inú reláciu pracoviska.", 409, "lease_lost");
  }
  return lease;
}

export function readWorkplaceLeaseFence(value: unknown): WorkplaceLeaseFence {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const leaseId = readUuid(input.leaseId);
  const assignmentGeneration = readUuid(input.assignmentGeneration);
  const browserInstanceId = readUuid(input.browserInstanceId);
  const leaderEpoch = readPositiveInteger(input.leaderEpoch);
  const leaseVersion = readPositiveInteger(input.leaseVersion);
  if (!leaseId || !assignmentGeneration || !browserInstanceId || !leaderEpoch || !leaseVersion) {
    throw new MutationError("Údaje relácie pracoviska nie sú úplné alebo platné.", 400);
  }
  return { leaseId, assignmentGeneration, browserInstanceId, leaderEpoch, leaseVersion };
}

async function loadCurrentWorkplaceLeases(
  client: ReturnType<typeof createSupabaseAdminClient>,
  organizationId: string,
  profileId: string,
  extensionId: string,
) {
  const result = await client
    .from("motorist_workplace_leases")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("profile_id", profileId)
    .eq("extension_id", extensionId)
    .in("state", ["active", "ending"])
    .limit(2);
  if (result.error) {
    throw new MutationError("Reláciu pracoviska sa nepodarilo bezpečne overiť.", 500);
  }
  return result.data ?? [];
}

function normalizeRequestedExtension(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string" || !/^\d{1,8}$/.test(value.trim())) {
    throw new MutationError("Klapka musí obsahovať iba číslice.", 400);
  }

  return value.trim();
}

function readUuid(value: unknown) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}

function readPositiveInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
