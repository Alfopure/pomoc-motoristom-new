import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/database.types";
import type { WorkplaceOperationKind, WorkplaceOperationPhase } from "./workplace-operation";

type AdminClient = SupabaseClient<Database>;

export type BeginWorkplaceOperationInput = {
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
  resources: Json;
  claimTtlSeconds?: number;
};

export type BeginWorkplaceOperationResult = {
  operationId: string;
  phase: WorkplaceOperationPhase;
  claimGeneration: string;
  claimExpiresAt: string;
  databaseNow: string;
  idempotent: boolean;
  terminalResult: Json | null;
};

export type MarkWorkplaceProviderCheckedInput = {
  organizationId: string;
  operationId: string;
  claimGeneration: string;
  providerProofHash: string;
};

export type FinalizeWorkplaceOperationInput = {
  organizationId: string;
  operationId: string;
  claimGeneration: string;
  newLeaseId: string | null;
  newAssignmentGeneration: string | null;
  newBrowserInstanceId: string | null;
  newResumeSecretHash: string | null;
  sourceLifecycle: Json | null;
  targetLifecycle: Json | null;
  sourceUnassignAuditId: string | null;
  targetUnassignAuditId: string | null;
  targetAssignAuditId: string | null;
};

export type FinalizeWorkplaceOperationResult = {
  operationId: string;
  phase: "completed";
  leaseId: string | null;
  assignmentGeneration: string | null;
  leaderEpoch: number | null;
  leaseVersion: number | null;
  expiresAt: string | null;
  databaseNow: string;
};

export type AbortWorkplaceOperationInput = {
  organizationId: string;
  operationId: string;
  claimGeneration: string;
  errorSafe: string;
};

export type WorkplacePresenceInput = {
  organizationId: string;
  leaseId: string;
  profileId: string;
  assignmentGeneration: string;
  browserInstanceId: string;
  leaderEpoch: number;
  leaseVersion: number;
};

export type ResumeWorkplaceLeaseInput = Omit<WorkplacePresenceInput, "browserInstanceId" | "leaderEpoch" | "leaseVersion"> & {
  idempotencyKey: string;
  previousResumeSecretHash: string;
  newResumeSecretHash: string;
  newBrowserInstanceId: string;
  expectedLeaderEpoch: number;
  expectedLeaseVersion: number;
};

export type WorkplacePresenceResult = {
  status: "renewed" | "resumed" | "lease_transitioning" | "lease_lost";
  leaseId: string;
  assignmentGeneration: string;
  browserInstanceId: string | null;
  leaderEpoch: number;
  leaseVersion: number;
  expiresAt: string | null;
  databaseNow: string;
};

export type VerifyWorkplaceLeaseInput = {
  organizationId: string;
  profileId: string;
  extensionId: string;
  leaseId: string | null;
  assignmentGeneration: string | null;
  browserInstanceId: string | null;
  leaderEpoch: number | null;
  leaseVersion: number | null;
  requireFence: boolean;
};

export type WorkplaceLeaseVerificationResult = {
  status: "verified" | "expired" | "transitioning" | "lease_lost";
  leaseId: string | null;
  assignmentGeneration: string | null;
  browserInstanceId: string | null;
  leaderEpoch: number | null;
  leaseVersion: number | null;
  expiresAt: string | null;
  databaseNow: string;
};

export type LoadedWorkplaceOperation = {
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
  phase: WorkplaceOperationPhase;
  claimGeneration: string;
  claimExpiresAt: string | null;
  terminalResult: Json | null;
};

export type WorkplaceOperationRepository = {
  databaseNow(): Promise<string>;
  load(input: {
    organizationId: string;
    operationId: string;
    actorProfileId: string;
  }): Promise<LoadedWorkplaceOperation>;
  begin(input: BeginWorkplaceOperationInput): Promise<BeginWorkplaceOperationResult>;
  markProviderChecked(input: MarkWorkplaceProviderCheckedInput): Promise<BeginWorkplaceOperationResult>;
  finalize(input: FinalizeWorkplaceOperationInput): Promise<FinalizeWorkplaceOperationResult>;
  abort(input: AbortWorkplaceOperationInput): Promise<{ operationId: string; phase: "aborted"; databaseNow: string }>;
  recoverExpired(input: {
    organizationId: string;
    operationId: string;
    recoveryOwner: string;
  }): Promise<{ operationId: string; phase: "aborted"; databaseNow: string; recovered: boolean }>;
  /**
   * Extends a precommit claim while the flow waits for a human to disconnect a
   * desk phone. Without this the 90-second guard expires mid-handover and
   * finalize rejects the operation, which is how seats became orphaned.
   */
  renewClaim(input: {
    organizationId: string;
    operationId: string;
    claimGeneration: string;
    claimTtlSeconds: number;
  }): Promise<{ operationId: string; databaseNow: string }>;
  /**
   * Frees claims whose owning operation is already terminal -- the case where
   * the release simply crashed after the phase write.
   */
  releaseTerminalClaims(input: {
    organizationId: string;
    operationId: string;
    recoveryOwner: string;
  }): Promise<{ operationId: string; releasedClaims: number; databaseNow: string }>;
  /**
   * Marks a post-commit operation as needing a human. Deliberately does not
   * release its claims: it must roll forward, not be freed.
   */
  markManualRecovery(input: {
    organizationId: string;
    operationId: string;
    recoveryOwner: string;
    reasonSafe: string;
  }): Promise<{ operationId: string; phase: "manual_recovery_required"; databaseNow: string }>;
  /** Ends an expired lease and nothing else; never touches extension ownership. */
  reapLease(input: {
    organizationId: string;
    leaseId: string;
    recoveryOwner: string;
  }): Promise<{ leaseId: string; reaped: boolean; databaseNow: string }>;
  verify(input: VerifyWorkplaceLeaseInput): Promise<WorkplaceLeaseVerificationResult>;
  heartbeat(input: WorkplacePresenceInput): Promise<WorkplacePresenceResult>;
  resume(input: ResumeWorkplaceLeaseInput): Promise<WorkplacePresenceResult>;
};

export class WorkplaceOperationRepositoryError extends Error {
  constructor(
    message: string,
    readonly operation: keyof WorkplaceOperationRepository,
    readonly causeSafe?: string,
  ) {
    super(message);
    this.name = "WorkplaceOperationRepositoryError";
  }
}

export function createWorkplaceOperationRepository(client: AdminClient): WorkplaceOperationRepository {
  return {
    async databaseNow() {
      const result = await client.rpc("motorist_workplace_database_now", {});
      const value = record(unwrapRpc(result, "databaseNow"));
      const databaseNow = timestamp(value.databaseNow);
      if (!databaseNow) throw invalidResult("databaseNow");
      return databaseNow;
    },
    async load(input) {
      const result = await client
        .from("motorist_workplace_operations")
        .select(
          "id, organization_id, idempotency_key, intent_hash, kind, actor_profile_id, source_extension_id, target_extension_id, source_lease_id, target_lease_id, browser_instance_id, expected_source_assignment_generation, expected_target_assignment_generation, expected_source_lease_version, expected_target_lease_version, expected_source_heartbeat_at, expected_target_heartbeat_at, phase, claim_generation, claim_expires_at, result_safe",
        )
        .eq("organization_id", input.organizationId)
        .eq("id", input.operationId)
        .eq("actor_profile_id", input.actorProfileId)
        .maybeSingle();
      if (result.error || !result.data) {
        throw new WorkplaceOperationRepositoryError(
          "Rozpracovaná operácia pracoviska sa nenašla alebo ju nemožno bezpečne načítať.",
          "load",
          safeRpcError(result.error),
        );
      }
      return parseLoadedOperation(result.data);
    },
    async begin(input) {
      const result = await client.rpc("motorist_begin_workplace_operation", {
        p_operation_id: input.operationId,
        p_organization_id: input.organizationId,
        p_idempotency_key: input.idempotencyKey,
        p_intent_hash: input.intentHash,
        p_kind: input.kind,
        p_actor_profile_id: input.actorProfileId,
        p_source_extension_id: input.sourceExtensionId,
        p_target_extension_id: input.targetExtensionId,
        p_source_lease_id: input.sourceLeaseId,
        p_target_lease_id: input.targetLeaseId,
        p_browser_instance_id: input.browserInstanceId,
        p_expected_source_assignment_generation: input.expectedSourceAssignmentGeneration,
        p_expected_target_assignment_generation: input.expectedTargetAssignmentGeneration,
        p_expected_source_lease_version: input.expectedSourceLeaseVersion,
        p_expected_target_lease_version: input.expectedTargetLeaseVersion,
        p_expected_source_heartbeat_at: input.expectedSourceHeartbeatAt,
        p_expected_target_heartbeat_at: input.expectedTargetHeartbeatAt,
        p_resources: input.resources,
        p_claim_ttl_seconds: input.claimTtlSeconds ?? 90,
      });
      return parseBeginResult(unwrapRpc(result, "begin"), "begin");
    },
    async markProviderChecked(input) {
      const result = await client.rpc("motorist_mark_workplace_provider_checked", {
        p_organization_id: input.organizationId,
        p_operation_id: input.operationId,
        p_claim_generation: input.claimGeneration,
        p_provider_proof_hash: input.providerProofHash,
      });
      return parseBeginResult(unwrapRpc(result, "markProviderChecked"), "markProviderChecked");
    },
    async finalize(input) {
      const result = await client.rpc("motorist_finalize_workplace_operation", {
        p_organization_id: input.organizationId,
        p_operation_id: input.operationId,
        p_claim_generation: input.claimGeneration,
        p_new_lease_id: input.newLeaseId,
        p_new_assignment_generation: input.newAssignmentGeneration,
        p_new_browser_instance_id: input.newBrowserInstanceId,
        p_new_resume_secret_hash: input.newResumeSecretHash,
        p_source_lifecycle: input.sourceLifecycle,
        p_target_lifecycle: input.targetLifecycle,
        p_source_unassign_audit_id: input.sourceUnassignAuditId,
        p_target_unassign_audit_id: input.targetUnassignAuditId,
        p_target_assign_audit_id: input.targetAssignAuditId,
      });
      return parseFinalizeResult(unwrapRpc(result, "finalize"));
    },
    async abort(input) {
      const result = await client.rpc("motorist_abort_workplace_operation", {
        p_organization_id: input.organizationId,
        p_operation_id: input.operationId,
        p_claim_generation: input.claimGeneration,
        p_error_safe: input.errorSafe,
      });
      const value = record(unwrapRpc(result, "abort"));
      const operationId = uuid(value.operationId);
      const databaseNow = timestamp(value.databaseNow);
      if (!operationId || value.phase !== "aborted" || !databaseNow) throw invalidResult("abort");
      return { operationId, phase: "aborted", databaseNow };
    },
    async recoverExpired(input) {
      const result = await client.rpc("motorist_recover_expired_workplace_operation", {
        p_organization_id: input.organizationId,
        p_operation_id: input.operationId,
        p_recovery_owner: input.recoveryOwner,
      });
      const value = record(unwrapRpc(result, "recoverExpired"));
      const operationId = uuid(value.operationId);
      const databaseNow = timestamp(value.databaseNow);
      if (!operationId || value.phase !== "aborted" || !databaseNow) throw invalidResult("recoverExpired");
      return { operationId, phase: "aborted", databaseNow, recovered: value.recovered === true };
    },
    async renewClaim(input) {
      const result = await client.rpc("motorist_renew_workplace_operation_claim", {
        p_organization_id: input.organizationId,
        p_operation_id: input.operationId,
        p_claim_generation: input.claimGeneration,
        p_claim_ttl_seconds: input.claimTtlSeconds,
      });
      const value = record(unwrapRpc(result, "renewClaim"));
      const operationId = uuid(value.operationId);
      const databaseNow = timestamp(value.databaseNow);
      if (!operationId || !databaseNow) throw invalidResult("renewClaim");
      return { operationId, databaseNow };
    },
    async releaseTerminalClaims(input) {
      const result = await client.rpc("motorist_release_terminal_telephony_resource_claims", {
        p_organization_id: input.organizationId,
        p_operation_id: input.operationId,
        p_recovery_owner: input.recoveryOwner,
      });
      const value = record(unwrapRpc(result, "releaseTerminalClaims"));
      const operationId = uuid(value.operationId);
      const databaseNow = timestamp(value.databaseNow);
      const releasedClaims = typeof value.releasedClaims === "number" ? value.releasedClaims : null;
      if (!operationId || !databaseNow || releasedClaims === null) throw invalidResult("releaseTerminalClaims");
      return { operationId, releasedClaims, databaseNow };
    },
    async markManualRecovery(input) {
      const result = await client.rpc("motorist_mark_workplace_operation_manual_recovery", {
        p_organization_id: input.organizationId,
        p_operation_id: input.operationId,
        p_recovery_owner: input.recoveryOwner,
        p_reason_safe: input.reasonSafe,
      });
      const value = record(unwrapRpc(result, "markManualRecovery"));
      const operationId = uuid(value.operationId);
      const databaseNow = timestamp(value.databaseNow);
      if (!operationId || value.phase !== "manual_recovery_required" || !databaseNow) {
        throw invalidResult("markManualRecovery");
      }
      return { operationId, phase: "manual_recovery_required", databaseNow };
    },
    async reapLease(input) {
      const result = await client.rpc("motorist_reap_expired_workplace_lease", {
        p_organization_id: input.organizationId,
        p_lease_id: input.leaseId,
        p_recovery_owner: input.recoveryOwner,
      });
      const value = record(unwrapRpc(result, "reapLease"));
      const leaseId = uuid(value.leaseId);
      const databaseNow = timestamp(value.databaseNow);
      if (!leaseId || !databaseNow) throw invalidResult("reapLease");
      return { leaseId, reaped: value.reaped === true, databaseNow };
    },
    async verify(input) {
      const result = await client.rpc("motorist_verify_workplace_lease", {
        p_organization_id: input.organizationId,
        p_profile_id: input.profileId,
        p_extension_id: input.extensionId,
        p_lease_id: input.leaseId,
        p_assignment_generation: input.assignmentGeneration,
        p_browser_instance_id: input.browserInstanceId,
        p_leader_epoch: input.leaderEpoch,
        p_lease_version: input.leaseVersion,
        p_require_fence: input.requireFence,
      });
      return parseVerificationResult(unwrapRpc(result, "verify"));
    },
    async heartbeat(input) {
      const result = await client.rpc("motorist_heartbeat_workplace_lease", {
        p_organization_id: input.organizationId,
        p_lease_id: input.leaseId,
        p_profile_id: input.profileId,
        p_assignment_generation: input.assignmentGeneration,
        p_browser_instance_id: input.browserInstanceId,
        p_leader_epoch: input.leaderEpoch,
        p_lease_version: input.leaseVersion,
      });
      return parsePresenceResult(unwrapRpc(result, "heartbeat"), "heartbeat");
    },
    async resume(input) {
      const result = await client.rpc("motorist_resume_workplace_lease", {
        p_organization_id: input.organizationId,
        p_lease_id: input.leaseId,
        p_profile_id: input.profileId,
        p_assignment_generation: input.assignmentGeneration,
        p_previous_resume_secret_hash: input.previousResumeSecretHash,
        p_new_resume_secret_hash: input.newResumeSecretHash,
        p_new_browser_instance_id: input.newBrowserInstanceId,
        p_expected_leader_epoch: input.expectedLeaderEpoch,
        p_expected_lease_version: input.expectedLeaseVersion,
        p_idempotency_key: input.idempotencyKey,
      });
      return parsePresenceResult(unwrapRpc(result, "resume"), "resume");
    },
  };
}

function parseLoadedOperation(value: unknown): LoadedWorkplaceOperation {
  const row = record(value);
  const operationId = uuid(row.id);
  const organizationId = uuid(row.organization_id);
  const idempotencyKey = uuid(row.idempotency_key);
  const intentHash = sha256(row.intent_hash);
  const kind = workplaceKind(row.kind);
  const actorProfileId = uuid(row.actor_profile_id);
  const sourceExtensionId = nullableUuid(row.source_extension_id);
  const targetExtensionId = nullableUuid(row.target_extension_id);
  const sourceLeaseId = nullableUuid(row.source_lease_id);
  const targetLeaseId = nullableUuid(row.target_lease_id);
  const browserInstanceId = uuid(row.browser_instance_id);
  const expectedSourceAssignmentGeneration = nullableUuid(row.expected_source_assignment_generation);
  const expectedTargetAssignmentGeneration = nullableUuid(row.expected_target_assignment_generation);
  const expectedSourceLeaseVersion = nullablePositiveInteger(row.expected_source_lease_version);
  const expectedTargetLeaseVersion = nullablePositiveInteger(row.expected_target_lease_version);
  const expectedSourceHeartbeatAt = nullablePreciseTimestamp(row.expected_source_heartbeat_at);
  const expectedTargetHeartbeatAt = nullablePreciseTimestamp(row.expected_target_heartbeat_at);
  const phase = operationPhase(row.phase);
  const claimGeneration = uuid(row.claim_generation);
  const claimExpiresAt = nullableTimestamp(row.claim_expires_at);
  if (
    !operationId || !organizationId || !idempotencyKey || !intentHash || !kind || !actorProfileId ||
    sourceExtensionId === undefined || targetExtensionId === undefined || sourceLeaseId === undefined ||
    targetLeaseId === undefined || !browserInstanceId || expectedSourceAssignmentGeneration === undefined ||
    expectedTargetAssignmentGeneration === undefined || expectedSourceLeaseVersion === undefined ||
    expectedTargetLeaseVersion === undefined || expectedSourceHeartbeatAt === undefined ||
    expectedTargetHeartbeatAt === undefined || !phase || !claimGeneration || claimExpiresAt === undefined
  ) {
    throw invalidResult("load");
  }
  return {
    operationId,
    organizationId,
    idempotencyKey,
    intentHash,
    kind,
    actorProfileId,
    sourceExtensionId,
    targetExtensionId,
    sourceLeaseId,
    targetLeaseId,
    browserInstanceId,
    expectedSourceAssignmentGeneration,
    expectedTargetAssignmentGeneration,
    expectedSourceLeaseVersion,
    expectedTargetLeaseVersion,
    expectedSourceHeartbeatAt,
    expectedTargetHeartbeatAt,
    phase,
    claimGeneration,
    claimExpiresAt,
    terminalResult: jsonOrNull(row.result_safe),
  };
}

function unwrapRpc(
  result: { data: Json | null; error: { message?: string; code?: string } | null },
  operation: keyof WorkplaceOperationRepository,
) {
  if (result.error || result.data === null) {
    throw new WorkplaceOperationRepositoryError(
      "Databázová operácia dynamického pracoviska zlyhala bezpečne.",
      operation,
      safeRpcError(result.error),
    );
  }
  return result.data;
}

function parseBeginResult(value: unknown, operation: "begin" | "markProviderChecked"): BeginWorkplaceOperationResult {
  const row = record(value);
  const operationId = uuid(row.operationId);
  const phase = operationPhase(row.phase);
  const claimGeneration = uuid(row.claimGeneration);
  const claimExpiresAt = timestamp(row.claimExpiresAt);
  const databaseNow = timestamp(row.databaseNow);
  if (!operationId || !phase || !claimGeneration || !claimExpiresAt || !databaseNow || typeof row.idempotent !== "boolean") {
    throw invalidResult(operation);
  }
  return {
    operationId,
    phase,
    claimGeneration,
    claimExpiresAt,
    databaseNow,
    idempotent: row.idempotent,
    terminalResult: jsonOrNull(row.terminalResult),
  };
}

function parseFinalizeResult(value: unknown): FinalizeWorkplaceOperationResult {
  const row = record(value);
  const operationId = uuid(row.operationId);
  const leaseId = nullableUuid(row.leaseId);
  const assignmentGeneration = nullableUuid(row.assignmentGeneration);
  const leaderEpoch = nullablePositiveInteger(row.leaderEpoch);
  const leaseVersion = nullablePositiveInteger(row.leaseVersion);
  const expiresAt = nullableTimestamp(row.expiresAt);
  const databaseNow = timestamp(row.databaseNow);
  if (
    !operationId || row.phase !== "completed" || leaseId === undefined || assignmentGeneration === undefined ||
    leaderEpoch === undefined || leaseVersion === undefined || expiresAt === undefined || !databaseNow ||
    ((leaseId === null) !== (assignmentGeneration === null)) ||
    ((leaseId === null) !== (leaderEpoch === null)) ||
    ((leaseId === null) !== (leaseVersion === null)) ||
    ((leaseId === null) !== (expiresAt === null))
  ) {
    throw invalidResult("finalize");
  }
  return {
    operationId,
    phase: "completed",
    leaseId,
    assignmentGeneration,
    leaderEpoch,
    leaseVersion,
    expiresAt,
    databaseNow,
  };
}

function parsePresenceResult(value: unknown, operation: "heartbeat" | "resume"): WorkplacePresenceResult {
  const row = record(value);
  const status = row.status === "renewed" || row.status === "resumed" || row.status === "lease_transitioning" ||
      row.status === "lease_lost"
    ? row.status
    : undefined;
  const leaseId = uuid(row.leaseId);
  const assignmentGeneration = uuid(row.assignmentGeneration);
  const browserInstanceId = nullableUuid(row.browserInstanceId);
  const leaderEpoch = positiveInteger(row.leaderEpoch);
  const leaseVersion = positiveInteger(row.leaseVersion);
  const expiresAt = nullableTimestamp(row.expiresAt);
  const databaseNow = timestamp(row.databaseNow);
  if (
    !status || !leaseId || !assignmentGeneration || browserInstanceId === undefined || !leaderEpoch || !leaseVersion ||
    expiresAt === undefined || !databaseNow ||
    ((status === "renewed" || status === "resumed") && (!browserInstanceId || !expiresAt))
  ) {
    throw invalidResult(operation);
  }
  return { status, leaseId, assignmentGeneration, browserInstanceId, leaderEpoch, leaseVersion, expiresAt, databaseNow };
}

function parseVerificationResult(value: unknown): WorkplaceLeaseVerificationResult {
  const row = record(value);
  const status = row.status === "verified" || row.status === "expired" || row.status === "transitioning" ||
      row.status === "lease_lost"
    ? row.status
    : undefined;
  const leaseId = nullableUuid(row.leaseId);
  const assignmentGeneration = nullableUuid(row.assignmentGeneration);
  const browserInstanceId = nullableUuid(row.browserInstanceId);
  const leaderEpoch = nullablePositiveInteger(row.leaderEpoch);
  const leaseVersion = nullablePositiveInteger(row.leaseVersion);
  const expiresAt = nullableTimestamp(row.expiresAt);
  const databaseNow = timestamp(row.databaseNow);
  if (
    !status || leaseId === undefined || assignmentGeneration === undefined || browserInstanceId === undefined ||
    leaderEpoch === undefined || leaseVersion === undefined || expiresAt === undefined || !databaseNow ||
    ((status === "verified" || status === "expired" || status === "transitioning") && (
      !leaseId || !assignmentGeneration || !browserInstanceId || !leaderEpoch || !leaseVersion || !expiresAt
    ))
  ) {
    throw invalidResult("verify");
  }
  return { status, leaseId, assignmentGeneration, browserInstanceId, leaderEpoch, leaseVersion, expiresAt, databaseNow };
}

function invalidResult(operation: keyof WorkplaceOperationRepository) {
  return new WorkplaceOperationRepositoryError(
    "Databáza vrátila neplatný stav dynamického pracoviska; akcia bola zastavená.",
    operation,
  );
}

/**
 * Builds a diagnostic that carries no row data.
 *
 * Symbolic raises from our own RPCs (`WORKPLACE_TARGET_ACTIVE`, ...) pass the
 * message filter. PostgreSQL's own failures do not, and their text was being
 * dropped entirely -- a duplicate-key violation arrived as a bare `23505` with
 * nothing to say which uniqueness rule fired, which is exactly the detail a
 * stuck-workplace report needs. The constraint name is a schema identifier, so
 * it is safe to keep; the surrounding message, which can quote column values,
 * is still discarded.
 */
function safeRpcError(error: { message?: string; code?: string } | null) {
  if (!error) return undefined;
  const code = typeof error.code === "string" && /^[A-Z0-9]{2,10}$/i.test(error.code) ? error.code : undefined;
  const rawMessage = typeof error.message === "string" ? error.message : "";
  const message = /^[A-Z][A-Z0-9_]{2,99}$/.test(rawMessage) ? rawMessage : undefined;
  const constraint = /violates (?:unique|check|foreign key|not-null) constraint "([a-z0-9_]{3,80})"/i
    .exec(rawMessage)?.[1];
  return [code, message, constraint && `constraint=${constraint}`].filter(Boolean).join(": ") || undefined;
}

function operationPhase(value: unknown): WorkplaceOperationPhase | undefined {
  return value === "created" || value === "claimed" || value === "browser_presence_checked" ||
      value === "provider_checked" || value === "ownership_committed" || value === "audits_verified" ||
      value === "completed" || value === "aborted" || value === "manual_recovery_required"
    ? value
    : undefined;
}

function workplaceKind(value: unknown): WorkplaceOperationKind | undefined {
  return value === "claim" || value === "takeover" || value === "switch" || value === "leave" ||
      value === "browser_transfer"
    ? value
    : undefined;
}

function sha256(value: unknown) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}

function timestamp(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function nullableTimestamp(value: unknown): string | null | undefined {
  return value === null ? null : timestamp(value);
}

function nullablePreciseTimestamp(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    return undefined;
  }
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function uuid(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}

function nullableUuid(value: unknown): string | null | undefined {
  return value === null ? null : uuid(value);
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nullablePositiveInteger(value: unknown): number | null | undefined {
  return value === null ? null : positiveInteger(value);
}

function jsonOrNull(value: unknown): Json | null {
  return value === undefined || value === null ? null : value as Json;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
