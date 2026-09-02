import { describe, expect, it } from "vitest";

import {
  canonicalTelephonyResourceClaims,
  canonicalWorkplaceIntent,
  isTerminalWorkplaceOperationPhase,
  toResourceClaimsJson,
  workplaceOperationIntentHash,
} from "./workplace-operation";

const ids = {
  organization: "11111111-1111-4111-8111-111111111111",
  actor: "22222222-2222-4222-8222-222222222222",
  browser: "33333333-3333-4333-8333-333333333333",
  source: "44444444-4444-4444-8444-444444444444",
  target: "55555555-5555-4555-8555-555555555555",
};

describe("workplace operation contract", () => {
  it("sorts claims deterministically across A→B and B→A callers", () => {
    const resources = canonicalTelephonyResourceClaims([
      { resourceType: "extension", resourceId: ids.target },
      { resourceType: "profile", resourceId: ids.actor },
      { resourceType: "extension", resourceId: ids.source },
    ]);
    expect(toResourceClaimsJson(resources)).toEqual([
      { resource_type: "extension", resource_id: ids.source },
      { resource_type: "extension", resource_id: ids.target },
      { resource_type: "profile", resource_id: ids.actor },
    ]);
  });

  it("rejects duplicate or malformed claims", () => {
    expect(() => canonicalTelephonyResourceClaims([
      { resourceType: "extension", resourceId: ids.source },
      { resourceType: "extension", resourceId: ids.source },
    ])).toThrow("Duplicate");
    expect(() => canonicalTelephonyResourceClaims([
      { resourceType: "extension", resourceId: "20" },
    ])).toThrow("Invalid");
  });

  it("hashes a canonical intent and rejects an incomplete switch", () => {
    const input = {
      organizationId: ids.organization,
      actorProfileId: ids.actor,
      browserInstanceId: ids.browser,
      kind: "switch" as const,
      sourceExtensionId: ids.source,
      targetExtensionId: ids.target,
    };
    expect(canonicalWorkplaceIntent(input)).toContain('"kind":"switch"');
    expect(workplaceOperationIntentHash(input)).toMatch(/^[0-9a-f]{64}$/);
    expect(workplaceOperationIntentHash(input)).toBe(workplaceOperationIntentHash({ ...input }));
    expect(() => canonicalWorkplaceIntent({ ...input, targetExtensionId: null })).toThrow("source and target");
  });

  it("recognizes only the phases that must not be silently retried", () => {
    expect(isTerminalWorkplaceOperationPhase("completed")).toBe(true);
    expect(isTerminalWorkplaceOperationPhase("manual_recovery_required")).toBe(true);
    expect(isTerminalWorkplaceOperationPhase("provider_checked")).toBe(false);
  });
});
