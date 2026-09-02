import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/database.types";
import { MutationError } from "@/server/motorist-mutations";

type AdminClient = SupabaseClient<Database>;
type ExtensionRow = Database["public"]["Tables"]["motorist_telephony_extensions"]["Row"];

const ASSIGN_ACTION = "telephony.extension.assign";
const UNASSIGN_ACTION = "telephony.extension.unassign";
const TERMINAL_ASSIGNMENT_ACTIONS = [ASSIGN_ACTION, UNASSIGN_ACTION] as const;
const ASSIGNMENT_AUDIT_PREFIX = "telephony.extension.";
const LIFECYCLE_SCHEMA_VERSION = 1;
const ASSIGNMENT_HISTORY_SCAN_LIMIT = 500;

export type AssignmentProvisioningRequirement = "initial_provisioning" | "rotation_required";
export type AssignmentLifecycle = {
  schemaVersion: 1;
  epoch: string;
  state: "assigned" | "unassigned";
  extensionId: string;
  extension: string;
  profileId: string | null;
  assignmentMode: "initial_provisioning" | "rotated_handoff" | "workplace_claim";
  assignedAt: string;
  assignedBy: string;
  unassignedAt?: string;
  unassignedBy?: string;
};

type AssignmentExtension = Pick<ExtensionRow, "extension" | "id" | "metadata" | "profile_id">;

/**
 * Empty metadata is not trusted on its own. Initial provisioning is available
 * only when the immutable, service-write-only audit has no prior assignment
 * lifecycle and the application row has no legacy assignment evidence.
 * Audit lookup failure intentionally falls back to real credential rotation.
 */
export async function assignmentProvisioningRequirement(
  client: AdminClient,
  organizationId: string,
  extension: AssignmentExtension,
): Promise<AssignmentProvisioningRequirement> {
  if (extension.profile_id !== null || hasAssignmentEvidence(extension.metadata)) return "rotation_required";
  const history = await client
    .from("motorist_audit_log")
    .select("id, entity_id, action, before_payload, after_payload")
    .eq("organization_id", organizationId)
    .eq("entity_type", "motorist_telephony_extensions")
    .like("action", `${ASSIGNMENT_AUDIT_PREFIX}%`)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(ASSIGNMENT_HISTORY_SCAN_LIMIT + 1);
  if (history.error || (history.data?.length ?? 0) > ASSIGNMENT_HISTORY_SCAN_LIMIT) {
    return "rotation_required";
  }
  for (const row of history.data ?? []) {
    if (row.entity_id === extension.id) return "rotation_required";
    const auditedExtension = auditedExtensionNumber(row.before_payload, row.after_payload);
    // An unparseable immutable assignment event is not evidence that a number
    // is unused. Fail closed so row recreation cannot turn audit corruption or
    // a legacy payload into a credential handoff bypass.
    if (!auditedExtension || auditedExtension === extension.extension) return "rotation_required";
  }
  return "initial_provisioning";
}

/**
 * Requires member-writable extension/profile state to match the latest
 * immutable assignment audit exactly. This is the authorization anchor used
 * before issuing SIP credentials or signing any provider-affecting command.
 */
export async function requireImmutableAssignmentLifecycle(
  client: AdminClient,
  organizationId: string,
  extension: AssignmentExtension,
  expectedProfileId?: string,
): Promise<AssignmentLifecycle> {
  const [audit, profile] = await Promise.all([
    client
      .from("motorist_audit_log")
      .select("id, action, after_payload, created_at")
      .eq("organization_id", organizationId)
      .eq("entity_type", "motorist_telephony_extensions")
      .eq("entity_id", extension.id)
      .in("action", [...TERMINAL_ASSIGNMENT_ACTIONS])
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle(),
    extension.profile_id
      ? client
          .from("motorist_profiles")
          .select("id, phone_extension")
          .eq("id", extension.profile_id)
          .eq("organization_id", organizationId)
          .eq("active", true)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (audit.error || profile.error) {
    throw new MutationError("Nemenný audit vlastníctva osobnej klapky sa nepodarilo overiť.", 500);
  }
  const metadataLifecycle = readAssignmentLifecycle(jsonRecord(extension.metadata).assignmentLifecycle);
  const auditPayload = jsonRecord(audit.data?.after_payload);
  const auditedLifecycle = readAssignmentLifecycle(auditPayload.assignment_lifecycle);
  if (
    !audit.data ||
    audit.data.action !== ASSIGN_ACTION ||
    !metadataLifecycle ||
    !auditedLifecycle ||
    !sameLifecycle(metadataLifecycle, auditedLifecycle) ||
    auditedLifecycle.state !== "assigned" ||
    auditedLifecycle.extensionId !== extension.id ||
    auditedLifecycle.extension !== extension.extension ||
    auditedLifecycle.profileId !== extension.profile_id ||
    (expectedProfileId !== undefined && auditedLifecycle.profileId !== expectedProfileId) ||
    !profile.data ||
    profile.data.id !== auditedLifecycle.profileId ||
    profile.data.phone_extension !== extension.extension
  ) {
    throw new MutationError(
      "Uložené vlastníctvo klapky nezodpovedá nemennému assignment auditu. Akcia bola bezpečne zastavená.",
      409,
    );
  }
  return auditedLifecycle;
}

/**
 * Authorization anchor for a hot-desk seat in both its occupied and empty
 * states. Unlike the legacy assignment helper, an audited `unassigned`
 * workplace is a valid stable seat identity; missing/mismatched audit or a
 * lingering profile reservation is never interpreted as free.
 */
export async function requireImmutableWorkplaceSeatLifecycle(
  client: AdminClient,
  organizationId: string,
  extension: AssignmentExtension,
): Promise<AssignmentLifecycle> {
  const [audit, assignedProfile, reservations] = await Promise.all([
    client
      .from("motorist_audit_log")
      .select("id, action, after_payload, created_at")
      .eq("organization_id", organizationId)
      .eq("entity_type", "motorist_telephony_extensions")
      .eq("entity_id", extension.id)
      .in("action", [...TERMINAL_ASSIGNMENT_ACTIONS])
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle(),
    extension.profile_id
      ? client
          .from("motorist_profiles")
          .select("id, phone_extension")
          .eq("id", extension.profile_id)
          .eq("organization_id", organizationId)
          .eq("active", true)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    client
      .from("motorist_profiles")
      .select("id, phone_extension")
      .eq("organization_id", organizationId)
      .eq("active", true)
      .eq("phone_extension", extension.extension)
      .limit(2),
  ]);
  if (audit.error || assignedProfile.error || reservations.error) {
    throw new MutationError("Nemenný audit pracovného miesta sa nepodarilo overiť.", 500);
  }
  const metadataLifecycle = readAssignmentLifecycle(jsonRecord(extension.metadata).assignmentLifecycle);
  const auditedLifecycle = readAssignmentLifecycle(jsonRecord(audit.data?.after_payload).assignment_lifecycle);
  const expectedAction = metadataLifecycle?.state === "assigned" ? ASSIGN_ACTION : UNASSIGN_ACTION;
  if (
    !audit.data || audit.data.action !== expectedAction || !metadataLifecycle || !auditedLifecycle ||
    !sameLifecycle(metadataLifecycle, auditedLifecycle) ||
    auditedLifecycle.assignmentMode !== "workplace_claim" ||
    auditedLifecycle.extensionId !== extension.id || auditedLifecycle.extension !== extension.extension ||
    auditedLifecycle.profileId !== extension.profile_id
  ) {
    throw new MutationError(
      "Pracovné miesto nemá zhodný nemenný hot-desk lifecycle. Akcia bola bezpečne zastavená.",
      409,
      "workplace_lifecycle_mismatch",
    );
  }
  const reservedProfiles = reservations.data ?? [];
  if (auditedLifecycle.state === "assigned") {
    if (
      !assignedProfile.data || assignedProfile.data.id !== auditedLifecycle.profileId ||
      assignedProfile.data.phone_extension !== extension.extension ||
      reservedProfiles.length !== 1 || reservedProfiles[0]?.id !== auditedLifecycle.profileId
    ) {
      throw new MutationError("Vlastník a profilová rezervácia pracovného miesta sa nezhodujú.", 409);
    }
  } else if (extension.profile_id !== null || assignedProfile.data || reservedProfiles.length !== 0) {
    throw new MutationError("Prázdne pracovné miesto má osirelú profilovú rezerváciu.", 409);
  }
  return auditedLifecycle;
}

export function assignedLifecycle(input: {
  assignedAt: string;
  assignedBy: string;
  assignmentMode: "initial_provisioning" | "rotated_handoff" | "workplace_claim";
  epoch: string;
  extension: string;
  extensionId: string;
  profileId: string;
}): AssignmentLifecycle {
  const lifecycle: AssignmentLifecycle = {
    schemaVersion: LIFECYCLE_SCHEMA_VERSION,
    epoch: input.epoch,
    state: "assigned",
    extensionId: input.extensionId,
    extension: input.extension,
    profileId: input.profileId,
    assignmentMode: input.assignmentMode,
    assignedAt: input.assignedAt,
    assignedBy: input.assignedBy,
  };
  if (!readAssignmentLifecycle(lifecycle)) throw new Error("Assignment lifecycle input is invalid.");
  return lifecycle;
}

export function unassignedLifecycle(
  current: AssignmentLifecycle,
  input: { unassignedAt: string; unassignedBy: string },
): AssignmentLifecycle {
  return {
    ...current,
    state: "unassigned",
    profileId: null,
    unassignedAt: input.unassignedAt,
    unassignedBy: input.unassignedBy,
  };
}

export function readAssignmentLifecycle(value: unknown): AssignmentLifecycle | undefined {
  const lifecycle = jsonRecord(value);
  const state = lifecycle.state === "assigned" || lifecycle.state === "unassigned" ? lifecycle.state : undefined;
  const assignmentMode = lifecycle.assignmentMode === "initial_provisioning" ||
    lifecycle.assignmentMode === "rotated_handoff" ||
    lifecycle.assignmentMode === "workplace_claim"
    ? lifecycle.assignmentMode
    : undefined;
  const profileId = lifecycle.profileId === null ? null : readUuid(lifecycle.profileId);
  const parsed: AssignmentLifecycle | undefined =
    lifecycle.schemaVersion === LIFECYCLE_SCHEMA_VERSION &&
    state &&
    assignmentMode &&
    readUuid(lifecycle.epoch) &&
    readUuid(lifecycle.extensionId) &&
    typeof lifecycle.extension === "string" && /^\d{1,8}$/.test(lifecycle.extension) &&
    profileId !== undefined &&
    readIso(lifecycle.assignedAt) &&
    readUuid(lifecycle.assignedBy) &&
    (state !== "assigned" || profileId !== null) &&
    (state !== "unassigned" || (
      profileId === null && readIso(lifecycle.unassignedAt) && readUuid(lifecycle.unassignedBy)
    ))
      ? {
          schemaVersion: 1,
          epoch: lifecycle.epoch as string,
          state,
          extensionId: lifecycle.extensionId as string,
          extension: lifecycle.extension,
          profileId,
          assignmentMode,
          assignedAt: lifecycle.assignedAt as string,
          assignedBy: lifecycle.assignedBy as string,
          ...(state === "unassigned"
            ? { unassignedAt: lifecycle.unassignedAt as string, unassignedBy: lifecycle.unassignedBy as string }
            : {}),
        }
      : undefined;
  return parsed;
}

export function lifecycleAuditPayload(lifecycle: AssignmentLifecycle): Json {
  return JSON.parse(JSON.stringify(lifecycle)) as Json;
}

function hasAssignmentEvidence(metadata: unknown) {
  const root = jsonRecord(metadata);
  return Object.keys(jsonRecord(root.assignmentLifecycle)).length > 0 ||
    Object.keys(jsonRecord(root.assignmentAttestation)).length > 0 ||
    Object.keys(jsonRecord(root.assignmentQuarantine)).length > 0;
}

function auditedExtensionNumber(beforePayload: unknown, afterPayload: unknown) {
  const candidates = new Set<string>();
  let malformedLifecycle = false;
  for (const value of [beforePayload, afterPayload]) {
    const payload = jsonRecord(value);
    const direct = readExtensionNumber(payload.extension);
    if (direct) candidates.add(direct);
    if (Object.hasOwn(payload, "assignment_lifecycle")) {
      const lifecycle = readAssignmentLifecycle(payload.assignment_lifecycle);
      if (!lifecycle) malformedLifecycle = true;
      else candidates.add(lifecycle.extension);
    }
    const quarantine = jsonRecord(payload.quarantine);
    const quarantinedExtension = readExtensionNumber(quarantine.extension);
    if (quarantinedExtension) candidates.add(quarantinedExtension);
  }
  if (malformedLifecycle || candidates.size !== 1) return undefined;
  return [...candidates][0];
}

function readExtensionNumber(value: unknown) {
  return typeof value === "string" && /^\d{1,8}$/.test(value) ? value : undefined;
}

function sameLifecycle(left: AssignmentLifecycle, right: AssignmentLifecycle) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readUuid(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}

function readIso(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
    ? value
    : undefined;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
