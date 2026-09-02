import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";
import {
  createWorkplaceOperationRepository,
  WorkplaceOperationRepositoryError,
} from "./workplace-operation-repository";

const ids = {
  operation: "11111111-1111-4111-8111-111111111111",
  organization: "22222222-2222-4222-8222-222222222222",
  idempotency: "33333333-3333-4333-8333-333333333333",
  actor: "44444444-4444-4444-8444-444444444444",
  extension: "55555555-5555-4555-8555-555555555555",
  lease: "66666666-6666-4666-8666-666666666666",
  browser: "77777777-7777-4777-8777-777777777777",
  generation: "88888888-8888-4888-8888-888888888888",
  claim: "99999999-9999-4999-8999-999999999999",
};

function clientWithRpc(data: unknown) {
  const rpc = vi.fn().mockResolvedValue({ data, error: null });
  return {
    client: { rpc } as unknown as SupabaseClient<Database>,
    rpc,
  };
}

describe("workplace operation repository", () => {
  it("loads the authoritative database clock through a service-only RPC", async () => {
    const { client, rpc } = clientWithRpc({ databaseNow: "2026-08-07T00:00:00+00:00" });
    await expect(createWorkplaceOperationRepository(client).databaseNow()).resolves.toBe("2026-08-07T00:00:00.000Z");
    expect(rpc).toHaveBeenCalledWith("motorist_workplace_database_now", {});
  });

  it("reloads the durable server-only claim between HTTP phases", async () => {
    const row = {
      id: ids.operation,
      organization_id: ids.organization,
      idempotency_key: ids.idempotency,
      intent_hash: "a".repeat(64),
      kind: "takeover",
      actor_profile_id: ids.actor,
      source_extension_id: null,
      target_extension_id: ids.extension,
      source_lease_id: null,
      target_lease_id: ids.lease,
      browser_instance_id: ids.browser,
      expected_source_assignment_generation: null,
      expected_target_assignment_generation: ids.generation,
      expected_source_lease_version: null,
      expected_target_lease_version: 2,
      expected_source_heartbeat_at: null,
      expected_target_heartbeat_at: "2026-08-07T00:00:00.748828+00:00",
      phase: "claimed",
      claim_generation: ids.claim,
      claim_expires_at: "2026-08-07T00:01:30+00:00",
      result_safe: null,
    };
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    const from = vi.fn().mockReturnValue(query);
    const repository = createWorkplaceOperationRepository({ from } as unknown as SupabaseClient<Database>);
    await expect(repository.load({
      organizationId: ids.organization,
      operationId: ids.operation,
      actorProfileId: ids.actor,
    })).resolves.toMatchObject({
      operationId: ids.operation,
      claimGeneration: ids.claim,
      targetLeaseId: ids.lease,
      expectedTargetLeaseVersion: 2,
      expectedTargetHeartbeatAt: "2026-08-07T00:00:00.748828+00:00",
    });
    expect(from).toHaveBeenCalledWith("motorist_workplace_operations");
  });

  it("forwards both heartbeat watermarks to the durable begin RPC", async () => {
    const { client, rpc } = clientWithRpc({
      operationId: ids.operation,
      phase: "claimed",
      claimGeneration: ids.claim,
      claimExpiresAt: "2026-08-07T00:01:30+00:00",
      databaseNow: "2026-08-07T00:00:00+00:00",
      idempotent: false,
      terminalResult: null,
    });
    const repository = createWorkplaceOperationRepository(client);
    const result = await repository.begin({
      operationId: ids.operation,
      organizationId: ids.organization,
      idempotencyKey: ids.idempotency,
      intentHash: "a".repeat(64),
      kind: "switch",
      actorProfileId: ids.actor,
      sourceExtensionId: ids.extension,
      targetExtensionId: ids.operation,
      sourceLeaseId: ids.lease,
      targetLeaseId: null,
      browserInstanceId: ids.browser,
      expectedSourceAssignmentGeneration: ids.generation,
      expectedTargetAssignmentGeneration: ids.claim,
      expectedSourceLeaseVersion: 4,
      expectedTargetLeaseVersion: null,
      expectedSourceHeartbeatAt: "2026-08-07T00:00:00.000Z",
      expectedTargetHeartbeatAt: null,
      resources: [],
    });
    expect(result.claimGeneration).toBe(ids.claim);
    expect(rpc).toHaveBeenCalledWith("motorist_begin_workplace_operation", expect.objectContaining({
      p_expected_source_heartbeat_at: "2026-08-07T00:00:00.000Z",
      p_expected_target_heartbeat_at: null,
    }));
  });

  it("verifies a lease through DB time and the complete optional fence", async () => {
    const { client, rpc } = clientWithRpc({
      status: "verified",
      leaseId: ids.lease,
      assignmentGeneration: ids.generation,
      browserInstanceId: ids.browser,
      leaderEpoch: 3,
      leaseVersion: 8,
      expiresAt: "2026-08-07T00:01:00+00:00",
      databaseNow: "2026-08-07T00:00:30+00:00",
    });
    const result = await createWorkplaceOperationRepository(client).verify({
      organizationId: ids.organization,
      profileId: ids.actor,
      extensionId: ids.extension,
      leaseId: ids.lease,
      assignmentGeneration: ids.generation,
      browserInstanceId: ids.browser,
      leaderEpoch: 3,
      leaseVersion: 8,
      requireFence: true,
    });
    expect(result).toMatchObject({ status: "verified", databaseNow: "2026-08-07T00:00:30.000Z" });
    expect(rpc).toHaveBeenCalledWith("motorist_verify_workplace_lease", expect.objectContaining({
      p_require_fence: true,
      p_lease_version: 8,
    }));
  });

  it("forwards the resume idempotency intent and both secret hashes atomically", async () => {
    const { client, rpc } = clientWithRpc({
      status: "resumed",
      leaseId: ids.lease,
      assignmentGeneration: ids.generation,
      browserInstanceId: ids.browser,
      leaderEpoch: 4,
      leaseVersion: 9,
      expiresAt: "2026-08-07T00:01:00+00:00",
      databaseNow: "2026-08-07T00:00:30+00:00",
    });
    await createWorkplaceOperationRepository(client).resume({
      organizationId: ids.organization,
      leaseId: ids.lease,
      profileId: ids.actor,
      assignmentGeneration: ids.generation,
      idempotencyKey: ids.idempotency,
      previousResumeSecretHash: "a".repeat(64),
      newResumeSecretHash: "b".repeat(64),
      newBrowserInstanceId: ids.browser,
      expectedLeaderEpoch: 3,
      expectedLeaseVersion: 8,
    });
    expect(rpc).toHaveBeenCalledWith("motorist_resume_workplace_lease", {
      p_organization_id: ids.organization,
      p_lease_id: ids.lease,
      p_profile_id: ids.actor,
      p_assignment_generation: ids.generation,
      p_previous_resume_secret_hash: "a".repeat(64),
      p_new_resume_secret_hash: "b".repeat(64),
      p_new_browser_instance_id: ids.browser,
      p_expected_leader_epoch: 3,
      p_expected_lease_version: 8,
      p_idempotency_key: ids.idempotency,
    });
  });

  it("fails closed instead of accepting a partial successful RPC response", async () => {
    const { client } = clientWithRpc({ status: "verified", leaseId: ids.lease });
    await expect(createWorkplaceOperationRepository(client).verify({
      organizationId: ids.organization,
      profileId: ids.actor,
      extensionId: ids.extension,
      leaseId: null,
      assignmentGeneration: null,
      browserInstanceId: null,
      leaderEpoch: null,
      leaseVersion: null,
      requireFence: false,
    })).rejects.toBeInstanceOf(WorkplaceOperationRepositoryError);
  });

  it("returns only a sanitized database error summary", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "55P03", message: "TELEPHONY_RESOURCE_BUSY" },
    });
    const repository = createWorkplaceOperationRepository({ rpc } as unknown as SupabaseClient<Database>);
    await expect(repository.heartbeat({
      organizationId: ids.organization,
      leaseId: ids.lease,
      profileId: ids.actor,
      assignmentGeneration: ids.generation,
      browserInstanceId: ids.browser,
      leaderEpoch: 1,
      leaseVersion: 1,
    })).rejects.toMatchObject({
      operation: "heartbeat",
      causeSafe: "55P03: TELEPHONY_RESOURCE_BUSY",
    });
  });

  it("never copies arbitrary database text into the safe error field", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "XX000", message: "query leaked value sip-password" },
    });
    const repository = createWorkplaceOperationRepository({ rpc } as unknown as SupabaseClient<Database>);
    try {
      await repository.databaseNow();
      throw new Error("Expected repository failure.");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkplaceOperationRepositoryError);
      expect((error as WorkplaceOperationRepositoryError).causeSafe).toBe("XX000");
    }
  });

  it("keeps the constraint name from a duplicate key so a stuck report is diagnosable", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: "23505",
        message: 'duplicate key value violates unique constraint "motorist_workplace_leases_one_current_profile_idx"',
      },
    });
    const repository = createWorkplaceOperationRepository({ rpc } as unknown as SupabaseClient<Database>);

    await expect(repository.databaseNow()).rejects.toMatchObject({
      // A bare "23505" said nothing about which uniqueness rule fired.
      causeSafe: "23505: constraint=motorist_workplace_leases_one_current_profile_idx",
    });
  });

  it("still drops the surrounding message text that can quote row values", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: "23505",
        message: 'Key (extension)=(sip-password-20) already exists violates unique constraint "motorist_ext_idx"',
      },
    });
    const repository = createWorkplaceOperationRepository({ rpc } as unknown as SupabaseClient<Database>);

    const error = await repository.databaseNow().catch((caught: unknown) => caught);
    const safe = (error as WorkplaceOperationRepositoryError).causeSafe ?? "";
    expect(safe).toContain("constraint=motorist_ext_idx");
    expect(safe).not.toContain("sip-password-20");
    expect(safe).not.toContain("Key (extension)");
  });

  it("exposes bounded opportunistic recovery without a browser claim token", async () => {
    const { client, rpc } = clientWithRpc({
      operationId: ids.operation,
      phase: "aborted",
      recovered: true,
      databaseNow: "2026-08-07T00:03:00+00:00",
    });
    const result = await createWorkplaceOperationRepository(client).recoverExpired({
      organizationId: ids.organization,
      operationId: ids.operation,
      recoveryOwner: "request:worker-01",
    });
    expect(result.recovered).toBe(true);
    expect(rpc).toHaveBeenCalledWith("motorist_recover_expired_workplace_operation", {
      p_organization_id: ids.organization,
      p_operation_id: ids.operation,
      p_recovery_owner: "request:worker-01",
    });
  });
});
