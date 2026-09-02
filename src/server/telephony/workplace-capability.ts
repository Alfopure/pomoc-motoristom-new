import "server-only";

export type WorkplaceHotdeskMode =
  | "disabled"
  | "trusted_test"
  | "production_static_pilot"
  | "production_revocable";
export type WorkplaceQueueCapability = "unverified" | "controlled_probe" | "verified_skip" | "verified_fallback";
export type WorkplaceCredentialProvider = "static_viptel" | "viptel_rotation" | "gateway_short_lived";
export type WorkplaceDeploymentStage = "local" | "controlled_test" | "production";

export type WorkplaceControlledQueueProbe = {
  profileId: string;
  sourceExtension: string;
  startsAt: string;
  endsAt: string;
  fallbackReference: string;
};

export type WorkplaceHotdeskCapabilityReason =
  | "enabled"
  | "flag_disabled"
  | "runtime_disabled"
  | "claims_disabled"
  | "preview_blocked"
  | "mode_missing"
  | "trusted_test_in_production"
  | "pilot_allowlist_missing"
  | "static_sip_pilot_acknowledgement_missing"
  | "static_sip_provider_required"
  | "queue_capability_unverified"
  | "queue_evidence_missing"
  | "credential_not_revocable"
  | "environment_invalid";

export type WorkplaceHotdeskCapability = {
  enabled: boolean;
  /** The additive lease schema/runtime is available and must stay on while draining. */
  runtimeEnabled: boolean;
  /** New claim/takeover/switch operations may be created. */
  claimsEnabled: boolean;
  mode: WorkplaceHotdeskMode;
  reason: WorkplaceHotdeskCapabilityReason;
  pilotProfileIds: readonly string[];
  queueCapability: WorkplaceQueueCapability;
  queueEvidenceId: string | null;
  queueProbe: WorkplaceControlledQueueProbe | null;
  credentialProvider: WorkplaceCredentialProvider;
  credentialRevocable: boolean;
  staticSipPilotAcknowledged: boolean;
  /** All non-claims pilot guards; remains true while claims are disabled for drain. */
  staticSipPilotGuardSatisfied: boolean;
  deploymentStage: WorkplaceDeploymentStage | null;
};

export type WorkplaceCapabilityEnvironment = Readonly<Record<string, string | undefined>>;

const ENABLED = "true";
const STATIC_SIP_PILOT_ACKNOWLEDGEMENT = "I_ACCEPT_NON_REVOCABLE_STATIC_SIP_PILOT";
// Capability declarations are not implementations. Keep this list empty until
// webphone session issuance is actually backed by an adapter that revokes or
// rotates the old SIP credential as part of the same handoff contract.
const IMPLEMENTED_REVOCABLE_CREDENTIAL_PROVIDERS: readonly WorkplaceCredentialProvider[] = [];

/**
 * Fail-closed deployment capability. A boolean feature flag alone is never
 * sufficient to turn static SIP credentials into a production-safe handoff.
 */
export function workplaceHotdeskCapability(
  env: WorkplaceCapabilityEnvironment = process.env,
): WorkplaceHotdeskCapability {
  const runtimeEnabled = env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED?.trim().toLowerCase() === ENABLED;
  const claimsEnabled = env.VIPTEL_WORKPLACE_HOTDESK_ENABLED?.trim().toLowerCase() === ENABLED;
  const queueCapability = parseQueueCapability(env.VIPTEL_WORKPLACE_QUEUE_CAPABILITY);
  const requestedCredentialProvider = env.VIPTEL_WORKPLACE_CREDENTIAL_PROVIDER?.trim().toLowerCase();
  const credentialProvider = parseCredentialProvider(env.VIPTEL_WORKPLACE_CREDENTIAL_PROVIDER);
  const pilotProfileIds = parseProfileAllowlist(env.VIPTEL_WORKPLACE_HOTDESK_PROFILE_IDS);
  const queueEvidenceId = readUuid(env.VIPTEL_WORKPLACE_QUEUE_EVIDENCE_ID?.trim()) ?? null;
  const queueProbe = parseControlledQueueProbe(env);
  const deploymentStage = parseDeploymentStage(env.VIPTEL_WORKPLACE_DEPLOYMENT_STAGE);
  const credentialRevocable = IMPLEMENTED_REVOCABLE_CREDENTIAL_PROVIDERS.includes(credentialProvider);
  const staticSipPilotAcknowledged =
    env.VIPTEL_WORKPLACE_STATIC_SIP_PILOT_ACKNOWLEDGEMENT?.trim() === STATIC_SIP_PILOT_ACKNOWLEDGEMENT;
  const staticSipPilotGuardSatisfied =
    deploymentStage === "production" &&
    env.VERCEL_ENV?.trim().toLowerCase() === "production" &&
    requestedCredentialProvider === "static_viptel" &&
    staticSipPilotAcknowledged;
  const base = {
    claimsEnabled,
    runtimeEnabled,
    pilotProfileIds,
    queueCapability,
    queueEvidenceId,
    queueProbe,
    credentialProvider,
    credentialRevocable,
    staticSipPilotAcknowledged,
    staticSipPilotGuardSatisfied,
    deploymentStage,
  };

  if (!runtimeEnabled) {
    if (claimsEnabled) {
      return { ...base, enabled: false, mode: "disabled", reason: "runtime_disabled" };
    }
    return { ...base, enabled: false, mode: "disabled", reason: "flag_disabled" };
  }
  if (!claimsEnabled) {
    return { ...base, enabled: false, mode: readRequestedMode(env), reason: "claims_disabled" };
  }
  if (env.VERCEL_ENV?.trim().toLowerCase() === "preview") {
    return { ...base, enabled: false, mode: "disabled", reason: "preview_blocked" };
  }
  const requestedMode = env.VIPTEL_WORKPLACE_HOTDESK_MODE?.trim().toLowerCase();
  if (
    requestedMode !== "trusted_test" &&
    requestedMode !== "production_static_pilot" &&
    requestedMode !== "production_revocable"
  ) {
    return { ...base, enabled: false, mode: "disabled", reason: "mode_missing" };
  }
  if (requestedMode === "trusted_test") {
    if (deploymentStage === "production" || env.VERCEL_ENV?.trim().toLowerCase() === "production") {
      return { ...base, enabled: false, mode: requestedMode, reason: "trusted_test_in_production" };
    }
    if (deploymentStage !== "local" && deploymentStage !== "controlled_test") {
      return { ...base, enabled: false, mode: requestedMode, reason: "environment_invalid" };
    }
    if (pilotProfileIds.length === 0) {
      return { ...base, enabled: false, mode: requestedMode, reason: "pilot_allowlist_missing" };
    }
    return { ...base, enabled: true, mode: requestedMode, reason: "enabled" };
  }
  if (requestedMode === "production_static_pilot") {
    if (deploymentStage !== "production" || env.VERCEL_ENV?.trim().toLowerCase() !== "production") {
      return { ...base, enabled: false, mode: requestedMode, reason: "environment_invalid" };
    }
    if (requestedCredentialProvider !== "static_viptel" || credentialProvider !== "static_viptel") {
      return { ...base, enabled: false, mode: requestedMode, reason: "static_sip_provider_required" };
    }
    if (!staticSipPilotAcknowledged) {
      return { ...base, enabled: false, mode: requestedMode, reason: "static_sip_pilot_acknowledgement_missing" };
    }
    return { ...base, enabled: true, mode: requestedMode, reason: "enabled" };
  }
  if (deploymentStage !== "production" || env.VERCEL_ENV && env.VERCEL_ENV.trim().toLowerCase() !== "production") {
    return { ...base, enabled: false, mode: requestedMode, reason: "environment_invalid" };
  }
  if (queueCapability !== "verified_skip" && queueCapability !== "verified_fallback") {
    return { ...base, enabled: false, mode: requestedMode, reason: "queue_capability_unverified" };
  }
  if (!queueEvidenceId) {
    return { ...base, enabled: false, mode: requestedMode, reason: "queue_evidence_missing" };
  }
  if (!credentialRevocable) {
    return { ...base, enabled: false, mode: requestedMode, reason: "credential_not_revocable" };
  }
  return { ...base, enabled: true, mode: requestedMode, reason: "enabled" };
}

export function canProfileUseWorkplaceHotdesk(
  capability: WorkplaceHotdeskCapability,
  profileId: string,
) {
  if (!capability.enabled || !readUuid(profileId)) return false;
  return capability.mode === "production_static_pilot" ||
    capability.mode === "production_revocable" ||
    capability.pilotProfileIds.includes(profileId.toLowerCase());
}

/**
 * Every path that empties a queue seat must call this separately from the
 * general capability check. Target-only claim/takeover does not need it.
 */
export function canVacateQueuedWorkplace(
  capability: WorkplaceHotdeskCapability,
  input?: { profileId: string; sourceExtension: string },
) {
  if (!capability.runtimeEnabled) return false;
  if (capability.mode === "production_revocable") {
    return capability.queueEvidenceId !== null &&
      (capability.queueCapability === "verified_skip" || capability.queueCapability === "verified_fallback");
  }
  if (capability.mode === "production_static_pilot") {
    return capability.staticSipPilotGuardSatisfied &&
      Boolean(input) &&
      Boolean(readUuid(input?.profileId)) &&
      Boolean(readExtension(input?.sourceExtension));
  }
  if (capability.mode !== "trusted_test") return false;
  return capability.queueCapability === "controlled_probe" &&
    capability.queueEvidenceId !== null &&
    capability.queueProbe !== null &&
    Boolean(input) &&
    capability.queueProbe.profileId === input?.profileId.toLowerCase() &&
    capability.queueProbe.sourceExtension === input?.sourceExtension;
}

function readRequestedMode(env: WorkplaceCapabilityEnvironment): WorkplaceHotdeskMode {
  const mode = env.VIPTEL_WORKPLACE_HOTDESK_MODE?.trim().toLowerCase();
  return mode === "trusted_test" || mode === "production_static_pilot" || mode === "production_revocable"
    ? mode
    : "disabled";
}

function parseControlledQueueProbe(
  env: WorkplaceCapabilityEnvironment,
): WorkplaceControlledQueueProbe | null {
  const profileId = readUuid(env.VIPTEL_WORKPLACE_QUEUE_PROBE_PROFILE_ID?.trim());
  const sourceExtension = readExtension(env.VIPTEL_WORKPLACE_QUEUE_PROBE_SOURCE_EXTENSION);
  const startsAt = readIso(env.VIPTEL_WORKPLACE_QUEUE_PROBE_STARTS_AT);
  const endsAt = readIso(env.VIPTEL_WORKPLACE_QUEUE_PROBE_ENDS_AT);
  const fallbackReference = readBoundedReference(env.VIPTEL_WORKPLACE_QUEUE_PROBE_FALLBACK_REFERENCE);
  if (!profileId || !sourceExtension || !startsAt || !endsAt || !fallbackReference) return null;
  const durationMs = Date.parse(endsAt) - Date.parse(startsAt);
  if (durationMs <= 0 || durationMs > 12 * 60 * 60 * 1_000) return null;
  return { profileId: profileId.toLowerCase(), sourceExtension, startsAt, endsAt, fallbackReference };
}

function parseQueueCapability(value: string | undefined): WorkplaceQueueCapability {
  const normalized = value?.trim().toLowerCase();
  return normalized === "controlled_probe" || normalized === "verified_skip" || normalized === "verified_fallback"
    ? normalized
    : "unverified";
}

function parseCredentialProvider(value: string | undefined): WorkplaceCredentialProvider {
  const normalized = value?.trim().toLowerCase();
  return normalized === "viptel_rotation" || normalized === "gateway_short_lived" ? normalized : "static_viptel";
}

function parseDeploymentStage(value: string | undefined): WorkplaceDeploymentStage | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === "local" || normalized === "controlled_test" || normalized === "production"
    ? normalized
    : null;
}

function parseProfileAllowlist(value: string | undefined) {
  const ids = new Set<string>();
  for (const candidate of value?.split(",") ?? []) {
    const id = readUuid(candidate.trim());
    if (id) ids.add(id.toLowerCase());
  }
  return [...ids].sort();
}

function readUuid(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : undefined;
}

function readExtension(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^\d{1,8}$/.test(normalized) ? normalized : undefined;
}

function readIso(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
  const normalized = new Date(value).toISOString();
  return normalized === value ? normalized : undefined;
}

function readBoundedReference(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length >= 6 && normalized.length <= 160 &&
    /^[\p{L}\p{N}][\p{L}\p{N} ._:/#-]*$/u.test(normalized)
    ? normalized
    : undefined;
}
