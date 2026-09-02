import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { WorkplaceOperationRepository } from "./workplace-operation-repository";
import {
  sweepStuckWorkplaceState,
  WorkplaceSweepError,
  WORKPLACE_LEASE_REAP_GRACE_MS,
  WORKPLACE_MANUAL_RECOVERY_THRESHOLD_MS,
  WORKPLACE_SWEEP_LIMIT,
} from "./workplace-sweeper";

const ORG = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-09-01T20:00:00.000Z";
const context = { organizationId: ORG, recoveryOwner: "job:sweep-test-0001" };

type TableRows = {
  operations?: Array<{ id: string }>;
  claims?: Array<{ operation_id: string | null }>;
  leases?: Array<{ id: string }>;
};

/**
 * Minimal Supabase stub. Each `from()` chain resolves to whichever fixture the
 * table needs; the chain records which table was touched so a test can assert
 * the sweeper never writes where it must not.
 */
function stubClient(rows: TableRows, writes: string[] = []) {
  const make = (table: string) => {
    const result = table === "motorist_workplace_operations"
      ? { data: rows.operations ?? [], error: null }
      : table === "motorist_workplace_resource_claims"
        ? { data: rows.claims ?? [], error: null }
        : { data: rows.leases ?? [], error: null };
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "lt", "order", "limit"]) {
      chain[method] = () => chain;
    }
    for (const method of ["update", "insert", "upsert", "delete"]) {
      chain[method] = () => {
        writes.push(table);
        return chain;
      };
    }
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return chain;
  };
  return { from: (table: string) => make(table) } as unknown as SupabaseClient<Database>;
}

function stubRepository(overrides: Partial<WorkplaceOperationRepository> = {}) {
  return {
    databaseNow: vi.fn(async () => NOW),
    recoverExpired: vi.fn(async ({ operationId }: { operationId: string }) => ({
      operationId, phase: "aborted" as const, databaseNow: NOW, recovered: true,
    })),
    releaseTerminalClaims: vi.fn(async ({ operationId }: { operationId: string }) => ({
      operationId, releasedClaims: 1, databaseNow: NOW,
    })),
    markManualRecovery: vi.fn(async ({ operationId }: { operationId: string }) => ({
      operationId, phase: "manual_recovery_required" as const, databaseNow: NOW,
    })),
    reapLease: vi.fn(async ({ leaseId }: { leaseId: string }) => ({
      leaseId, reaped: true, databaseNow: NOW,
    })),
    ...overrides,
  } as unknown as WorkplaceOperationRepository;
}

beforeEach(() => {
  vi.stubEnv("VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED", "true");
  vi.stubEnv("VIPTEL_WORKPLACE_HOTDESK_ENABLED", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("workplace sweeper", () => {
  it("does nothing when hot-desking is off rather than scanning unused tables", async () => {
    vi.stubEnv("VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED", "");
    vi.stubEnv("VIPTEL_WORKPLACE_HOTDESK_ENABLED", "false");
    const repository = stubRepository();

    const summary = await sweepStuckWorkplaceState(context, {
      client: stubClient({}),
      repository,
    });

    expect(summary.skipped.hotdesk_runtime_disabled).toBe(1);
    expect(repository.databaseNow).not.toHaveBeenCalled();
  });

  it("reaps an expired lease without ever writing extension ownership", async () => {
    // Half-releasing these correlated rows is the documented way to make a
    // workstation permanently stuck, so the reaper must stay lease-only.
    const writes: string[] = [];
    const repository = stubRepository();

    const summary = await sweepStuckWorkplaceState(context, {
      client: stubClient({ leases: [{ id: "lease-1" }] }, writes),
      repository,
    });

    expect(summary.reapedLeases).toBe(1);
    expect(writes).not.toContain("motorist_telephony_extensions");
    expect(writes).not.toContain("motorist_profiles");
  });

  it("marks a stranded post-commit operation instead of releasing its claims", async () => {
    const repository = stubRepository();

    const summary = await sweepStuckWorkplaceState(context, {
      client: stubClient({ operations: [{ id: "op-1" }] }),
      repository,
    });

    expect(summary.markedManualRecovery).toBeGreaterThan(0);
    expect(repository.markManualRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, recoveryOwner: context.recoveryOwner }),
    );
  });

  it("throws an aggregate rather than swallowing a genuine failure", async () => {
    // A sweeper that hides its own errors is how a wedged claim stays invisible.
    const repository = stubRepository({
      reapLease: vi.fn(async () => { throw new Error("PG_CONNECTION_LOST"); }),
    });

    const error = await sweepStuckWorkplaceState(context, {
      client: stubClient({ leases: [{ id: "lease-1" }] }),
      repository,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkplaceSweepError);
    expect((error as WorkplaceSweepError).summary.failures).toHaveLength(1);
    expect((error as WorkplaceSweepError).summary.failures[0]?.pass).toBe("reap_lease");
  });

  it("treats a busy resource as skipped, not failed", async () => {
    // Refusing to free something still in use is the fence working, not a fault.
    const repository = stubRepository({
      reapLease: vi.fn(async () => { throw new Error("TELEPHONY_RESOURCE_BUSY"); }),
    });

    const summary = await sweepStuckWorkplaceState(context, {
      client: stubClient({ leases: [{ id: "lease-1" }] }),
      repository,
    });

    expect(summary.failures).toEqual([]);
    expect(summary.skipped["reap:referenced"]).toBe(1);
  });

  it("keeps row values out of the reported reason", async () => {
    const repository = stubRepository({
      reapLease: vi.fn(async () => {
        throw new Error('duplicate key (extension)=(sip-secret-20) WORKPLACE_RECOVERY_STATE_MISMATCH');
      }),
    });

    const error = await sweepStuckWorkplaceState(context, {
      client: stubClient({ leases: [{ id: "lease-1" }] }),
      repository,
    }).catch((caught: unknown) => caught);

    const reason = (error as WorkplaceSweepError).summary.failures[0]?.reason ?? "";
    expect(reason).toContain("WORKPLACE_RECOVERY_STATE_MISMATCH");
    expect(reason).not.toContain("sip-secret-20");
  });

  it("uses a database clock rather than the worker's own", async () => {
    // Deciding what is expired from a drifting worker clock would reap live work.
    const repository = stubRepository({ databaseNow: vi.fn(async () => "not-a-timestamp") });

    await expect(sweepStuckWorkplaceState(context, {
      client: stubClient({}),
      repository,
    })).rejects.toThrow(/database clock/i);
  });
});

describe("sweeper bounds", () => {
  it("keeps every pass bounded and the lease grace ahead of the lease TTL", () => {
    expect(WORKPLACE_SWEEP_LIMIT).toBeGreaterThan(0);
    expect(WORKPLACE_SWEEP_LIMIT).toBeLessThanOrEqual(100);
    // A lease TTL is 60 s; the grace must be comfortably longer so a browser
    // that is merely slow to heartbeat is never reaped out from under itself.
    expect(WORKPLACE_LEASE_REAP_GRACE_MS).toBeGreaterThan(60_000);
    expect(WORKPLACE_MANUAL_RECOVERY_THRESHOLD_MS).toBeGreaterThan(WORKPLACE_LEASE_REAP_GRACE_MS);
  });
});
