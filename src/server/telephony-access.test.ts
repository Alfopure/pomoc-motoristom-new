import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { MotoristActor } from "./api-auth";
import { requireActiveWorkplaceLease, type WorkplaceLeaseFence } from "./telephony-access";

const actor: MotoristActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  profileId: "22222222-2222-4222-8222-222222222222",
  organizationId: "33333333-3333-4333-8333-333333333333",
  displayName: "Tester",
  role: "dispatcher",
};
const extension = { id: "44444444-4444-4444-8444-444444444444", extension: "20" };
const fence: WorkplaceLeaseFence = {
  leaseId: "55555555-5555-4555-8555-555555555555",
  assignmentGeneration: "66666666-6666-4666-8666-666666666666",
  browserInstanceId: "77777777-7777-4777-8777-777777777777",
  leaderEpoch: 2,
  leaseVersion: 4,
};

afterEach(() => {
  delete process.env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED;
  delete process.env.VIPTEL_WORKPLACE_HOTDESK_ENABLED;
});

describe("telephony workplace lease fence", () => {
  it("keeps an existing lease fenced while new claims are drained", async () => {
    process.env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED = "true";
    process.env.VIPTEL_WORKPLACE_HOTDESK_ENABLED = "false";
    const lease = leaseRow();

    await expect(requireActiveWorkplaceLease(actor, extension, fence, {
      client: {} as never,
      requireFence: true,
      verifyLease: async () => ({
        status: "verified",
        leaseId: fence.leaseId,
        assignmentGeneration: fence.assignmentGeneration,
        browserInstanceId: fence.browserInstanceId,
        leaderEpoch: fence.leaderEpoch,
        leaseVersion: fence.leaseVersion,
        expiresAt: lease.expires_at,
        databaseNow: "2026-08-07T08:00:00.000Z",
      }),
      loadLease: async () => [lease],
    })).resolves.toMatchObject({ id: fence.leaseId, profileId: actor.profileId });
  });

  it("preserves a historical workplace_claim seat before the additive schema exists", async () => {
    const client = clientResult({
      data: null,
      error: {
        code: "PGRST204",
        message: "Could not find the 'workplace_seat_generation' column in the schema cache",
      },
    });
    await expect(requireActiveWorkplaceLease(actor, extension, undefined, {
      client: client as never,
      assignmentLifecycle: lifecycle("workplace_claim"),
      requireFence: true,
    })).resolves.toBeUndefined();
  });

  it("fails closed when a bootstrapped seat is present but runtime was disabled", async () => {
    const client = clientResult({
      data: [{ id: extension.id, workplace_seat_generation: "88888888-8888-4888-8888-888888888888" }],
      error: null,
    });
    await expect(requireActiveWorkplaceLease(actor, extension, fence, {
      client: client as never,
      assignmentLifecycle: lifecycle("workplace_claim"),
      requireFence: true,
    })).rejects.toMatchObject({ code: "hotdesk_runtime_disabled", status: 503 });
  });
});

function lifecycle(assignmentMode: "initial_provisioning" | "workplace_claim") {
  return {
    schemaVersion: 1 as const,
    epoch: fence.assignmentGeneration,
    state: "assigned" as const,
    extensionId: extension.id,
    extension: extension.extension,
    profileId: actor.profileId,
    assignmentMode,
    assignedAt: "2026-08-07T07:00:00.000Z",
    assignedBy: actor.profileId,
  };
}

function leaseRow() {
  return {
    id: fence.leaseId,
    organization_id: actor.organizationId,
    extension_id: extension.id,
    profile_id: actor.profileId,
    assignment_generation: fence.assignmentGeneration,
    browser_instance_id: fence.browserInstanceId,
    lease_version: fence.leaseVersion,
    leader_epoch: fence.leaderEpoch,
    resume_secret_hash: "a".repeat(64),
    resume_requested_at: null,
    heartbeat_suspended_at: null,
    heartbeat_suspension_operation_id: null,
    state: "active",
    claimed_at: "2026-08-07T07:59:00.000Z",
    heartbeat_at: "2026-08-07T07:59:30.000Z",
    expires_at: "2026-08-07T08:00:30.000Z",
    ended_at: null,
    ended_reason: null,
    revoked_by: null,
    created_at: "2026-08-07T07:59:00.000Z",
    updated_at: "2026-08-07T07:59:30.000Z",
  };
}

function clientResult(result: { data: unknown; error: unknown }) {
  const query = new Proxy<Record<string, unknown>>({}, {
    get(_target, property) {
      if (property === "then") {
        return (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject);
      }
      return () => query;
    },
  });
  return { from: vi.fn(() => query) };
}
