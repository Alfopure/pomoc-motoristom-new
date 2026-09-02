import "server-only";

import { createHash } from "node:crypto";

export const WORKPLACE_RESOURCE_CLAIM_TTL_SECONDS = 90;
export const WORKPLACE_RECOVERY_OWNER_TTL_SECONDS = 30;

export type WorkplaceOperationKind = "claim" | "takeover" | "switch" | "leave" | "browser_transfer";
export type WorkplaceOperationPhase =
  | "created"
  | "claimed"
  | "browser_presence_checked"
  | "provider_checked"
  | "ownership_committed"
  | "audits_verified"
  | "completed"
  | "aborted"
  | "manual_recovery_required";

export type TelephonyGuardOperationKind =
  | `workplace_${WorkplaceOperationKind}`
  | "routing_apply"
  | "call_command"
  | "dtmf_intent"
  | "queue_action"
  | "webphone_session_issue"
  | "assignment";

export type TelephonyResourceType =
  | "profile"
  | "extension"
  | "workplace_lease"
  | "routing_plan"
  | "call"
  | "queue";

export type TelephonyResourceClaim = {
  resourceType: TelephonyResourceType;
  resourceId: string;
};

export type WorkplaceOperationIntent = {
  organizationId: string;
  actorProfileId: string;
  kind: WorkplaceOperationKind;
  sourceExtensionId: string | null;
  targetExtensionId: string | null;
  browserInstanceId: string;
};

export const TERMINAL_WORKPLACE_OPERATION_PHASES = [
  "completed",
  "aborted",
  "manual_recovery_required",
] as const satisfies readonly WorkplaceOperationPhase[];

export function isTerminalWorkplaceOperationPhase(
  phase: WorkplaceOperationPhase,
): phase is (typeof TERMINAL_WORKPLACE_OPERATION_PHASES)[number] {
  return TERMINAL_WORKPLACE_OPERATION_PHASES.includes(
    phase as (typeof TERMINAL_WORKPLACE_OPERATION_PHASES)[number],
  );
}

/**
 * Produces the only accepted ordering for durable claims. Sorting and
 * de-duplication prevent A→B/B→A lock inversions and ambiguous resource sets.
 */
export function canonicalTelephonyResourceClaims(
  resources: readonly TelephonyResourceClaim[],
): TelephonyResourceClaim[] {
  const canonical = resources.map((resource) => {
    if (!isResourceType(resource.resourceType) || !isUuid(resource.resourceId)) {
      throw new Error("Invalid telephony resource claim.");
    }
    return { resourceType: resource.resourceType, resourceId: resource.resourceId.toLowerCase() };
  }).sort((left, right) =>
    left.resourceType.localeCompare(right.resourceType) || left.resourceId.localeCompare(right.resourceId)
  );
  for (let index = 1; index < canonical.length; index += 1) {
    const previous = canonical[index - 1];
    const current = canonical[index];
    if (previous.resourceType === current.resourceType && previous.resourceId === current.resourceId) {
      throw new Error("Duplicate telephony resource claim.");
    }
  }
  return canonical;
}

export function canonicalWorkplaceIntent(input: WorkplaceOperationIntent) {
  if (
    !isUuid(input.organizationId) || !isUuid(input.actorProfileId) || !isUuid(input.browserInstanceId) ||
    !isWorkplaceOperationKind(input.kind) ||
    (input.sourceExtensionId !== null && !isUuid(input.sourceExtensionId)) ||
    (input.targetExtensionId !== null && !isUuid(input.targetExtensionId))
  ) {
    throw new Error("Invalid workplace operation intent.");
  }
  if (input.sourceExtensionId && input.sourceExtensionId === input.targetExtensionId) {
    throw new Error("A workplace switch must use two different seats.");
  }
  if (input.kind === "leave" && (!input.sourceExtensionId || input.targetExtensionId)) {
    throw new Error("A leave operation requires only a source seat.");
  }
  if ((input.kind === "claim" || input.kind === "takeover") && (input.sourceExtensionId || !input.targetExtensionId)) {
    throw new Error("A claim/takeover requires only a target seat.");
  }
  if (input.kind === "switch" && (!input.sourceExtensionId || !input.targetExtensionId)) {
    throw new Error("A switch requires source and target seats.");
  }
  if (input.kind === "browser_transfer" && (input.sourceExtensionId || !input.targetExtensionId)) {
    throw new Error("A browser transfer requires only the actor's target seat.");
  }
  return JSON.stringify({
    actorProfileId: input.actorProfileId.toLowerCase(),
    browserInstanceId: input.browserInstanceId.toLowerCase(),
    kind: input.kind,
    organizationId: input.organizationId.toLowerCase(),
    sourceExtensionId: input.sourceExtensionId?.toLowerCase() ?? null,
    targetExtensionId: input.targetExtensionId?.toLowerCase() ?? null,
  });
}

export function workplaceOperationIntentHash(input: WorkplaceOperationIntent) {
  return createHash("sha256").update(canonicalWorkplaceIntent(input), "utf8").digest("hex");
}

export function toResourceClaimsJson(resources: readonly TelephonyResourceClaim[]) {
  return canonicalTelephonyResourceClaims(resources).map((resource) => ({
    resource_type: resource.resourceType,
    resource_id: resource.resourceId,
  }));
}

function isWorkplaceOperationKind(value: unknown): value is WorkplaceOperationKind {
  return value === "claim" || value === "takeover" || value === "switch" || value === "leave" ||
    value === "browser_transfer";
}

function isResourceType(value: unknown): value is TelephonyResourceType {
  return value === "profile" || value === "extension" || value === "workplace_lease" ||
    value === "routing_plan" || value === "call" || value === "queue";
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
