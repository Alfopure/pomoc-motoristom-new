import "server-only";

import { createHash } from "node:crypto";

export const WORKPLACE_HEARTBEAT_INTERVAL_MS = 15_000;
export const WORKPLACE_LEASE_TTL_MS = 60_000;

export type WorkplaceLeaseState = "active" | "ending" | "ended" | "revoked";

export type WorkplaceLease = {
  id: string;
  organizationId: string;
  extensionId: string;
  profileId: string;
  assignmentGeneration: string;
  browserInstanceId: string;
  leaseVersion: number;
  leaderEpoch: number;
  resumeSecretHash: string;
  resumeRequestedAt: string | null;
  heartbeatSuspendedAt: string | null;
  heartbeatSuspensionOperationId: string | null;
  state: WorkplaceLeaseState;
  claimedAt: string;
  heartbeatAt: string;
  expiresAt: string;
  endedAt: string | null;
  endedReason: string | null;
  revokedBy: string | null;
};

export type WorkplaceLeaseClientRef = {
  leaseId: string;
  seatId: string;
  extension: string;
  assignmentGeneration: string;
  leaderEpoch: number;
  leaseVersion: number;
  expiresAt: string;
  heartbeatIntervalMs: typeof WORKPLACE_HEARTBEAT_INTERVAL_MS;
};

export type WorkplaceLeaseFreshness =
  | "fresh"
  | "expired"
  | "ending"
  | "ended"
  | "revoked";

export type WorkplaceLeaseMatch = {
  leaseId: string;
  organizationId: string;
  extensionId: string;
  profileId: string;
  assignmentGeneration: string;
  browserInstanceId: string;
  leaderEpoch: number;
  leaseVersion: number;
};

/**
 * Optimistic version for a seat ownership decision. Heartbeats and browser
 * lease renewals deliberately do not change it; ownership/lifecycle changes do.
 */
export function workplaceSeatOwnershipVersion(input: {
  seatId?: string;
  lifecycleEpoch?: string;
  lease?: Pick<WorkplaceLease, "id" | "assignmentGeneration" | "state">;
}) {
  return createHash("sha256")
    .update(input.seatId ?? "missing")
    .update("\0")
    .update(input.lifecycleEpoch ?? "unknown")
    .update("\0")
    .update(input.lease
      ? `${input.lease.id}:${input.lease.assignmentGeneration}:${input.lease.state}`
      : "no-lease")
    .digest("hex");
}

/**
 * Parses the service-only database representation. A malformed lease is never
 * treated as expired/free: callers must fail closed when this returns undefined.
 */
export function readWorkplaceLease(value: unknown): WorkplaceLease | undefined {
  const row = record(value);
  const state = readLeaseState(row.state);
  const leaseVersion = readPositiveSafeInteger(field(row, "lease_version", "leaseVersion"));
  const leaderEpoch = readPositiveSafeInteger(field(row, "leader_epoch", "leaderEpoch"));
  const id = readUuid(row.id);
  const organizationId = readUuid(field(row, "organization_id", "organizationId"));
  const extensionId = readUuid(field(row, "extension_id", "extensionId"));
  const profileId = readUuid(field(row, "profile_id", "profileId"));
  const assignmentGeneration = readUuid(field(row, "assignment_generation", "assignmentGeneration"));
  const browserInstanceId = readUuid(field(row, "browser_instance_id", "browserInstanceId"));
  const resumeSecretHash = readSha256(field(row, "resume_secret_hash", "resumeSecretHash"));
  const claimedAt = readIso(field(row, "claimed_at", "claimedAt"));
  // This value is also an optimistic database fence. PostgreSQL timestamps
  // carry microseconds while JavaScript Date only carries milliseconds, so it
  // must survive parsing byte-for-byte instead of being normalized through
  // Date#toISOString().
  const heartbeatAt = readPreciseIso(field(row, "heartbeat_at", "heartbeatAt"));
  const expiresAt = readIso(field(row, "expires_at", "expiresAt"));
  const endedAt = readNullableIso(field(row, "ended_at", "endedAt"));
  const resumeRequestedAt = readNullableIso(field(row, "resume_requested_at", "resumeRequestedAt"));
  const heartbeatSuspendedAt = readNullableIso(field(row, "heartbeat_suspended_at", "heartbeatSuspendedAt"));
  const heartbeatSuspensionOperationId = readNullableUuid(
    field(row, "heartbeat_suspension_operation_id", "heartbeatSuspensionOperationId"),
  );
  const revokedBy = readNullableUuid(field(row, "revoked_by", "revokedBy"));
  const endedReason = readNullableBoundedString(field(row, "ended_reason", "endedReason"), 160);

  if (
    !id || !organizationId || !extensionId || !profileId || !assignmentGeneration || !browserInstanceId ||
    !leaseVersion || !leaderEpoch || !resumeSecretHash || !state || !claimedAt || !heartbeatAt || !expiresAt ||
    endedAt === undefined || resumeRequestedAt === undefined || heartbeatSuspendedAt === undefined ||
    heartbeatSuspensionOperationId === undefined || revokedBy === undefined || endedReason === undefined
  ) {
    return undefined;
  }

  const heartbeatMs = Date.parse(heartbeatAt);
  const expiresMs = Date.parse(expiresAt);
  if (
    expiresMs < heartbeatMs ||
    expiresMs - heartbeatMs > WORKPLACE_LEASE_TTL_MS ||
    ((state === "ended" || state === "revoked") && endedAt === null) ||
    ((state === "active" || state === "ending") && endedAt !== null) ||
    (heartbeatSuspendedAt === null) !== (heartbeatSuspensionOperationId === null)
  ) {
    return undefined;
  }

  return {
    id,
    organizationId,
    extensionId,
    profileId,
    assignmentGeneration,
    browserInstanceId,
    leaseVersion,
    leaderEpoch,
    resumeSecretHash,
    resumeRequestedAt,
    heartbeatSuspendedAt,
    heartbeatSuspensionOperationId,
    state,
    claimedAt,
    heartbeatAt,
    expiresAt,
    endedAt,
    endedReason,
    revokedBy,
  };
}

/** Uses a server/DB timestamp supplied by the caller; never the browser clock. */
export function workplaceLeaseFreshness(
  lease: WorkplaceLease,
  databaseNow: string | number | Date,
): WorkplaceLeaseFreshness | "invalid_time" {
  const nowMs = readTime(databaseNow);
  if (nowMs === undefined) return "invalid_time";
  if (lease.state === "ended") return "ended";
  if (lease.state === "revoked") return "revoked";
  if (lease.state === "ending") return "ending";
  return nowMs <= Date.parse(lease.expiresAt) ? "fresh" : "expired";
}

export function workplaceLeaseMatches(lease: WorkplaceLease, expected: WorkplaceLeaseMatch) {
  return lease.id === expected.leaseId &&
    lease.organizationId === expected.organizationId &&
    lease.extensionId === expected.extensionId &&
    lease.profileId === expected.profileId &&
    lease.assignmentGeneration === expected.assignmentGeneration &&
    lease.browserInstanceId === expected.browserInstanceId &&
    lease.leaderEpoch === expected.leaderEpoch &&
    lease.leaseVersion === expected.leaseVersion;
}

export function toWorkplaceLeaseClientRef(
  lease: WorkplaceLease,
  input: { extension: string; seatId?: string },
): WorkplaceLeaseClientRef {
  if (!/^\d{1,8}$/.test(input.extension)) throw new Error("Invalid workplace extension.");
  const seatId = input.seatId ?? lease.extensionId;
  if (!readUuid(seatId)) throw new Error("Invalid workplace seat ID.");
  return {
    leaseId: lease.id,
    seatId,
    extension: input.extension,
    assignmentGeneration: lease.assignmentGeneration,
    leaderEpoch: lease.leaderEpoch,
    leaseVersion: lease.leaseVersion,
    expiresAt: lease.expiresAt,
    heartbeatIntervalMs: WORKPLACE_HEARTBEAT_INTERVAL_MS,
  };
}

function readLeaseState(value: unknown): WorkplaceLeaseState | undefined {
  return value === "active" || value === "ending" || value === "ended" || value === "revoked"
    ? value
    : undefined;
}

function readUuid(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}

function readNullableUuid(value: unknown): string | null | undefined {
  return value === null ? null : readUuid(value);
}

function readPositiveSafeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function readSha256(value: unknown) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}

function readIso(value: unknown): string | undefined {
  const precise = readPreciseIso(value);
  if (!precise) {
    return undefined;
  }
  const parsed = Date.parse(precise);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function readPreciseIso(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    return undefined;
  }
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function readNullableIso(value: unknown): string | null | undefined {
  return value === null ? null : readIso(value);
}

function readNullableBoundedString(value: unknown, maximum: number): string | null | undefined {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= maximum)
    ? value as string | null
    : undefined;
}

function readTime(value: string | number | Date) {
  const parsed = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function field(row: Record<string, unknown>, snakeCase: string, camelCase: string) {
  return Object.hasOwn(row, snakeCase) ? row[snakeCase] : row[camelCase];
}
