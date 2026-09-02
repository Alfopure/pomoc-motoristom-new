import { describe, expect, it } from "vitest";

import {
  canProfileUseWorkplaceHotdesk,
  canVacateQueuedWorkplace,
  workplaceHotdeskCapability,
} from "./workplace-capability";

const profileId = "11111111-1111-4111-8111-111111111111";
const evidenceId = "22222222-2222-4222-8222-222222222222";
const staticSipPilotAcknowledgement = "I_ACCEPT_NON_REVOCABLE_STATIC_SIP_PILOT";
const probeScope = {
  VIPTEL_WORKPLACE_QUEUE_PROBE_PROFILE_ID: profileId,
  VIPTEL_WORKPLACE_QUEUE_PROBE_SOURCE_EXTENSION: "20",
  VIPTEL_WORKPLACE_QUEUE_PROBE_STARTS_AT: "2026-08-07T07:30:00.000Z",
  VIPTEL_WORKPLACE_QUEUE_PROBE_ENDS_AT: "2026-08-07T09:30:00.000Z",
  VIPTEL_WORKPLACE_QUEUE_PROBE_FALLBACK_REFERENCE: "approved-fallback-2026-08-07",
};

describe("workplace hot-desk capability", () => {
  it("is disabled by default and always blocks Preview", () => {
    expect(workplaceHotdeskCapability({}).reason).toBe("flag_disabled");
    expect(workplaceHotdeskCapability({
      VIPTEL_WORKPLACE_HOTDESK_ENABLED: "true",
    })).toMatchObject({ enabled: false, runtimeEnabled: false, reason: "runtime_disabled" });
    expect(workplaceHotdeskCapability({
      VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED: "true",
      VIPTEL_WORKPLACE_HOTDESK_ENABLED: "true",
      VIPTEL_WORKPLACE_HOTDESK_MODE: "trusted_test",
      VIPTEL_WORKPLACE_HOTDESK_PROFILE_IDS: profileId,
      VIPTEL_WORKPLACE_DEPLOYMENT_STAGE: "controlled_test",
      VERCEL_ENV: "preview",
    }).reason).toBe("preview_blocked");
  });

  it("permits only allowlisted profiles in a non-production trusted test", () => {
    const capability = workplaceHotdeskCapability({
      VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED: "true",
      VIPTEL_WORKPLACE_HOTDESK_ENABLED: "true",
      VIPTEL_WORKPLACE_HOTDESK_MODE: "trusted_test",
      VIPTEL_WORKPLACE_HOTDESK_PROFILE_IDS: `${profileId},invalid,${profileId}`,
      VIPTEL_WORKPLACE_CREDENTIAL_PROVIDER: "static_viptel",
      VIPTEL_WORKPLACE_DEPLOYMENT_STAGE: "controlled_test",
      VERCEL_ENV: "development",
    });
    expect(capability).toMatchObject({ enabled: true, mode: "trusted_test", credentialRevocable: false });
    expect(capability.pilotProfileIds).toEqual([profileId]);
    expect(canProfileUseWorkplaceHotdesk(capability, profileId)).toBe(true);
    expect(canProfileUseWorkplaceHotdesk(capability, evidenceId)).toBe(false);
    expect(canVacateQueuedWorkplace(capability, { profileId, sourceExtension: "20" })).toBe(false);
  });

  it("never permits trusted_test in production", () => {
    expect(workplaceHotdeskCapability({
      VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED: "true",
      VIPTEL_WORKPLACE_HOTDESK_ENABLED: "true",
      VIPTEL_WORKPLACE_HOTDESK_MODE: "trusted_test",
      VIPTEL_WORKPLACE_HOTDESK_PROFILE_IDS: profileId,
      VIPTEL_WORKPLACE_DEPLOYMENT_STAGE: "production",
      VERCEL_ENV: "production",
    })).toMatchObject({ enabled: false, reason: "trusted_test_in_production" });
  });

  it("permits every valid operator profile in an acknowledged production static-SIP pilot", () => {
    const base = {
      VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED: "true",
      VIPTEL_WORKPLACE_HOTDESK_ENABLED: "true",
      VIPTEL_WORKPLACE_HOTDESK_MODE: "production_static_pilot",
      VIPTEL_WORKPLACE_CREDENTIAL_PROVIDER: "static_viptel",
      VIPTEL_WORKPLACE_DEPLOYMENT_STAGE: "production",
      VERCEL_ENV: "production",
    };

    const unacknowledged = workplaceHotdeskCapability(base);
    expect(unacknowledged).toMatchObject({
      enabled: false,
      mode: "production_static_pilot",
      reason: "static_sip_pilot_acknowledgement_missing",
      staticSipPilotAcknowledged: false,
      staticSipPilotGuardSatisfied: false,
    });
    expect(canVacateQueuedWorkplace(unacknowledged, { profileId, sourceExtension: "20" })).toBe(false);

    const capability = workplaceHotdeskCapability({
      ...base,
      VIPTEL_WORKPLACE_STATIC_SIP_PILOT_ACKNOWLEDGEMENT: staticSipPilotAcknowledgement,
    });
    expect(capability).toMatchObject({
      enabled: true,
      mode: "production_static_pilot",
      reason: "enabled",
      credentialProvider: "static_viptel",
      credentialRevocable: false,
      staticSipPilotAcknowledged: true,
      staticSipPilotGuardSatisfied: true,
    });
    expect(canProfileUseWorkplaceHotdesk(capability, profileId)).toBe(true);
    expect(canProfileUseWorkplaceHotdesk(capability, evidenceId)).toBe(true);
    expect(canProfileUseWorkplaceHotdesk(capability, "not-a-profile-id")).toBe(false);
    expect(canVacateQueuedWorkplace(capability, { profileId, sourceExtension: "20" })).toBe(true);
  });

  it("fails closed for a production static-SIP pilot when a global gate is invalid", () => {
    const base = {
      VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED: "true",
      VIPTEL_WORKPLACE_HOTDESK_ENABLED: "true",
      VIPTEL_WORKPLACE_HOTDESK_MODE: "production_static_pilot",
      VIPTEL_WORKPLACE_CREDENTIAL_PROVIDER: "static_viptel",
      VIPTEL_WORKPLACE_STATIC_SIP_PILOT_ACKNOWLEDGEMENT: staticSipPilotAcknowledgement,
      VIPTEL_WORKPLACE_DEPLOYMENT_STAGE: "production",
      VERCEL_ENV: "production",
    };

    expect(workplaceHotdeskCapability({
      ...base,
      VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED: "false",
    }).reason).toBe("runtime_disabled");
    const draining = workplaceHotdeskCapability({
      ...base,
      VIPTEL_WORKPLACE_HOTDESK_ENABLED: "false",
    });
    expect(draining).toMatchObject({
      enabled: false,
      mode: "production_static_pilot",
      reason: "claims_disabled",
      staticSipPilotGuardSatisfied: true,
    });
    expect(canVacateQueuedWorkplace(draining, { profileId, sourceExtension: "20" })).toBe(true);
    expect(workplaceHotdeskCapability({ ...base, VERCEL_ENV: "preview" }).reason).toBe("preview_blocked");
    expect(workplaceHotdeskCapability({ ...base, VERCEL_ENV: "development" }).reason).toBe("environment_invalid");
    expect(workplaceHotdeskCapability({ ...base, VERCEL_ENV: undefined }).reason).toBe("environment_invalid");
    expect(workplaceHotdeskCapability({
      ...base,
      VIPTEL_WORKPLACE_DEPLOYMENT_STAGE: "controlled_test",
    }).reason).toBe("environment_invalid");
    expect(workplaceHotdeskCapability({
      ...base,
      VIPTEL_WORKPLACE_HOTDESK_PROFILE_IDS: "",
    })).toMatchObject({ enabled: true, reason: "enabled", staticSipPilotGuardSatisfied: true });
    expect(workplaceHotdeskCapability({
      ...base,
      VIPTEL_WORKPLACE_CREDENTIAL_PROVIDER: "gateway_short_lived",
    }).reason).toBe("static_sip_provider_required");
    expect(workplaceHotdeskCapability({
      ...base,
      VIPTEL_WORKPLACE_CREDENTIAL_PROVIDER: "typo_static_provider",
    }).reason).toBe("static_sip_provider_required");
    expect(workplaceHotdeskCapability({
      ...base,
      VIPTEL_WORKPLACE_CREDENTIAL_PROVIDER: undefined,
    }).reason).toBe("static_sip_provider_required");
    expect(workplaceHotdeskCapability({
      ...base,
      VIPTEL_WORKPLACE_STATIC_SIP_PILOT_ACKNOWLEDGEMENT: "true",
    }).reason).toBe("static_sip_pilot_acknowledgement_missing");
  });

  it("lets any valid operator in the acknowledged static-SIP pilot vacate its queued source without probe env", () => {
    const capability = workplaceHotdeskCapability({
      VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED: "true",
      VIPTEL_WORKPLACE_HOTDESK_ENABLED: "true",
      VIPTEL_WORKPLACE_HOTDESK_MODE: "production_static_pilot",
      VIPTEL_WORKPLACE_CREDENTIAL_PROVIDER: "static_viptel",
      VIPTEL_WORKPLACE_STATIC_SIP_PILOT_ACKNOWLEDGEMENT: staticSipPilotAcknowledgement,
      VIPTEL_WORKPLACE_DEPLOYMENT_STAGE: "production",
      VERCEL_ENV: "production",
    });

    expect(capability.enabled).toBe(true);
    expect(canVacateQueuedWorkplace(capability, { profileId, sourceExtension: "20" })).toBe(true);
    expect(canVacateQueuedWorkplace(capability, { profileId, sourceExtension: "21" })).toBe(true);
    expect(canVacateQueuedWorkplace(capability, { profileId, sourceExtension: "invalid" })).toBe(false);
    expect(canVacateQueuedWorkplace(capability, { profileId: evidenceId, sourceExtension: "20" })).toBe(true);
    expect(canVacateQueuedWorkplace(capability, { profileId: "not-a-profile-id", sourceExtension: "20" })).toBe(false);
  });

  it("requires queue evidence and revocable credentials in production mode", () => {
    const base = {
      VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED: "true",
      VIPTEL_WORKPLACE_HOTDESK_ENABLED: "true",
      VIPTEL_WORKPLACE_HOTDESK_MODE: "production_revocable",
      VIPTEL_WORKPLACE_QUEUE_CAPABILITY: "verified_skip",
      VIPTEL_WORKPLACE_QUEUE_EVIDENCE_ID: evidenceId,
      VIPTEL_WORKPLACE_DEPLOYMENT_STAGE: "production",
      VERCEL_ENV: "production",
    };
    expect(workplaceHotdeskCapability({
      ...base,
      VIPTEL_WORKPLACE_CREDENTIAL_PROVIDER: "static_viptel",
    }).reason).toBe("credential_not_revocable");
    const declaredButUnimplemented = workplaceHotdeskCapability({
      ...base,
      VIPTEL_WORKPLACE_CREDENTIAL_PROVIDER: "gateway_short_lived",
    });
    expect(declaredButUnimplemented).toMatchObject({
      enabled: false,
      credentialRevocable: false,
      reason: "credential_not_revocable",
    });
    // Creation stays blocked, but verified queue safety remains usable while
    // an existing lease is being drained.
    expect(canVacateQueuedWorkplace(declaredButUnimplemented, { profileId, sourceExtension: "20" })).toBe(true);
  });

  it("allows a queued-seat controlled probe only with immutable evidence", () => {
    const capability = workplaceHotdeskCapability({
      VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED: "true",
      VIPTEL_WORKPLACE_HOTDESK_ENABLED: "true",
      VIPTEL_WORKPLACE_HOTDESK_MODE: "trusted_test",
      VIPTEL_WORKPLACE_HOTDESK_PROFILE_IDS: profileId,
      VIPTEL_WORKPLACE_QUEUE_CAPABILITY: "controlled_probe",
      VIPTEL_WORKPLACE_QUEUE_EVIDENCE_ID: evidenceId,
      ...probeScope,
      VIPTEL_WORKPLACE_DEPLOYMENT_STAGE: "controlled_test",
      VERCEL_ENV: "development",
    });
    expect(capability.queueProbe).toEqual({
      profileId,
      sourceExtension: "20",
      startsAt: "2026-08-07T07:30:00.000Z",
      endsAt: "2026-08-07T09:30:00.000Z",
      fallbackReference: "approved-fallback-2026-08-07",
    });
    expect(canVacateQueuedWorkplace(capability, { profileId, sourceExtension: "20" })).toBe(true);
    expect(canVacateQueuedWorkplace(capability, { profileId, sourceExtension: "21" })).toBe(false);
    expect(canVacateQueuedWorkplace(capability, { profileId: evidenceId, sourceExtension: "20" })).toBe(false);
  });

  it("does not turn a bare or overbroad probe declaration into queue-vacate authority", () => {
    const base = {
      VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED: "true",
      VIPTEL_WORKPLACE_HOTDESK_ENABLED: "true",
      VIPTEL_WORKPLACE_HOTDESK_MODE: "trusted_test",
      VIPTEL_WORKPLACE_HOTDESK_PROFILE_IDS: profileId,
      VIPTEL_WORKPLACE_QUEUE_CAPABILITY: "controlled_probe",
      VIPTEL_WORKPLACE_QUEUE_EVIDENCE_ID: evidenceId,
      VIPTEL_WORKPLACE_DEPLOYMENT_STAGE: "controlled_test",
      VERCEL_ENV: "development",
    };
    const bare = workplaceHotdeskCapability(base);
    expect(bare.queueProbe).toBeNull();
    expect(canVacateQueuedWorkplace(bare, { profileId, sourceExtension: "20" })).toBe(false);

    const tooLong = workplaceHotdeskCapability({
      ...base,
      ...probeScope,
      VIPTEL_WORKPLACE_QUEUE_PROBE_ENDS_AT: "2026-08-08T09:30:00.000Z",
    });
    expect(tooLong.queueProbe).toBeNull();
    expect(canVacateQueuedWorkplace(tooLong, { profileId, sourceExtension: "20" })).toBe(false);
  });

  it("fails closed when deployment identity is missing, including a Hetzner-like environment", () => {
    const capability = workplaceHotdeskCapability({
      VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED: "true",
      VIPTEL_WORKPLACE_HOTDESK_ENABLED: "true",
      VIPTEL_WORKPLACE_HOTDESK_MODE: "trusted_test",
      VIPTEL_WORKPLACE_HOTDESK_PROFILE_IDS: profileId,
      NEXT_PUBLIC_APP_URL: "https://dispecing.linkapomoci.sk",
    });
    expect(capability).toMatchObject({ enabled: false, reason: "environment_invalid", deploymentStage: null });
  });

  it("keeps the lease runtime alive while new claims are drained", () => {
    const capability = workplaceHotdeskCapability({
      VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED: "true",
      VIPTEL_WORKPLACE_HOTDESK_ENABLED: "false",
      VIPTEL_WORKPLACE_HOTDESK_MODE: "trusted_test",
      VIPTEL_WORKPLACE_QUEUE_CAPABILITY: "controlled_probe",
      VIPTEL_WORKPLACE_QUEUE_EVIDENCE_ID: evidenceId,
      ...probeScope,
    });

    expect(capability).toMatchObject({
      claimsEnabled: false,
      enabled: false,
      mode: "trusted_test",
      reason: "claims_disabled",
      runtimeEnabled: true,
    });
    expect(canProfileUseWorkplaceHotdesk(capability, profileId)).toBe(false);
    expect(canVacateQueuedWorkplace(capability, { profileId, sourceExtension: "20" })).toBe(true);
  });

  it("does not let a trusted-test declaration impersonate broad verified queue authority", () => {
    const capability = workplaceHotdeskCapability({
      VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED: "true",
      VIPTEL_WORKPLACE_HOTDESK_ENABLED: "false",
      VIPTEL_WORKPLACE_HOTDESK_MODE: "trusted_test",
      VIPTEL_WORKPLACE_QUEUE_CAPABILITY: "verified_skip",
      VIPTEL_WORKPLACE_QUEUE_EVIDENCE_ID: evidenceId,
    });

    expect(canVacateQueuedWorkplace(capability, { profileId, sourceExtension: "20" })).toBe(false);
  });
});
