import { describe, expect, it } from "vitest";

import {
  readWorkplaceLease,
  toWorkplaceLeaseClientRef,
  workplaceLeaseFreshness,
  workplaceLeaseMatches,
  workplaceSeatOwnershipVersion,
} from "./workplace-lease";

const ids = {
  lease: "11111111-1111-4111-8111-111111111111",
  organization: "22222222-2222-4222-8222-222222222222",
  extension: "33333333-3333-4333-8333-333333333333",
  profile: "44444444-4444-4444-8444-444444444444",
  generation: "55555555-5555-4555-8555-555555555555",
  browser: "66666666-6666-4666-8666-666666666666",
};

function leaseRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.lease,
    organization_id: ids.organization,
    extension_id: ids.extension,
    profile_id: ids.profile,
    assignment_generation: ids.generation,
    browser_instance_id: ids.browser,
    lease_version: 1,
    leader_epoch: 1,
    resume_secret_hash: "a".repeat(64),
    resume_requested_at: null,
    heartbeat_suspended_at: null,
    heartbeat_suspension_operation_id: null,
    state: "active",
    claimed_at: "2026-08-07T00:00:00.000Z",
    heartbeat_at: "2026-08-07T00:01:00.000Z",
    expires_at: "2026-08-07T00:02:00.000Z",
    ended_at: null,
    ended_reason: null,
    revoked_by: null,
    ...overrides,
  };
}

describe("workplace lease", () => {
  it("parses a bounded database lease and creates the stable client reference", () => {
    const lease = readWorkplaceLease(leaseRow());
    expect(lease).toMatchObject({
      id: ids.lease,
      assignmentGeneration: ids.generation,
      leaseVersion: 1,
      leaderEpoch: 1,
    });
    expect(toWorkplaceLeaseClientRef(lease!, { extension: "21" })).toEqual({
      leaseId: ids.lease,
      seatId: ids.extension,
      extension: "21",
      assignmentGeneration: ids.generation,
      leaderEpoch: 1,
      leaseVersion: 1,
      expiresAt: "2026-08-07T00:02:00.000Z",
      heartbeatIntervalMs: 15_000,
    });
  });

  it("uses the supplied database time and expires only after the exact boundary", () => {
    const lease = readWorkplaceLease(leaseRow())!;
    expect(workplaceLeaseFreshness(lease, "2026-08-07T00:02:00.000Z")).toBe("fresh");
    expect(workplaceLeaseFreshness(lease, "2026-08-07T00:02:00.001Z")).toBe("expired");
    expect(workplaceLeaseFreshness(lease, "not-a-time")).toBe("invalid_time");
  });

  it("preserves PostgreSQL microseconds in the heartbeat ownership fence", () => {
    const lease = readWorkplaceLease(leaseRow({
      heartbeat_at: "2026-08-07T00:01:00.748828+00:00",
      expires_at: "2026-08-07T00:02:00.748828+00:00",
    }));

    expect(lease?.heartbeatAt).toBe("2026-08-07T00:01:00.748828+00:00");
  });

  it("never parses a lease with a client-extended TTL or inconsistent terminal state", () => {
    expect(readWorkplaceLease(leaseRow({ expires_at: "2026-08-07T00:02:00.001Z" }))).toBeUndefined();
    expect(readWorkplaceLease(leaseRow({ state: "revoked" }))).toBeUndefined();
    expect(readWorkplaceLease(leaseRow({
      heartbeat_suspended_at: "2026-08-07T00:01:01.000Z",
      heartbeat_suspension_operation_id: null,
    }))).toBeUndefined();
  });

  it("matches every fencing field, including browser, epoch and version", () => {
    const lease = readWorkplaceLease(leaseRow())!;
    const expected = {
      leaseId: ids.lease,
      organizationId: ids.organization,
      extensionId: ids.extension,
      profileId: ids.profile,
      assignmentGeneration: ids.generation,
      browserInstanceId: ids.browser,
      leaderEpoch: 1,
      leaseVersion: 1,
    };
    expect(workplaceLeaseMatches(lease, expected)).toBe(true);
    expect(workplaceLeaseMatches(lease, { ...expected, leaderEpoch: 2 })).toBe(false);
    expect(workplaceLeaseMatches(lease, { ...expected, browserInstanceId: ids.lease })).toBe(false);
  });

  it("keeps the ownership version stable across heartbeats but changes it for a new assignment", () => {
    const lease = readWorkplaceLease(leaseRow())!;
    const renewed = readWorkplaceLease(leaseRow({
      lease_version: 9,
      heartbeat_at: "2026-08-07T00:01:30.000Z",
      expires_at: "2026-08-07T00:02:30.000Z",
    }))!;
    const input = { seatId: ids.extension, lifecycleEpoch: ids.generation, lease };
    expect(workplaceSeatOwnershipVersion({ ...input, lease: renewed }))
      .toBe(workplaceSeatOwnershipVersion(input));
    expect(workplaceSeatOwnershipVersion({
      ...input,
      lifecycleEpoch: "77777777-7777-4777-8777-777777777777",
    })).not.toBe(workplaceSeatOwnershipVersion(input));
    expect(workplaceSeatOwnershipVersion({
      ...input,
      lease: { ...lease, assignmentGeneration: "88888888-8888-4888-8888-888888888888" },
    })).not.toBe(workplaceSeatOwnershipVersion(input));
  });
});
