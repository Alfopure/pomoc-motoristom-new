import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { MotoristActor } from "@/server/api-auth";
import { resumeWorkplaceLease } from "./workplace-presence";

const actor: MotoristActor = {
  userId: "11111111-1111-4111-8111-111111111111",
  profileId: "22222222-2222-4222-8222-222222222222",
  organizationId: "33333333-3333-4333-8333-333333333333",
  displayName: "Tester",
  role: "dispatcher",
};
const input = {
  leaseId: "44444444-4444-4444-8444-444444444444",
  assignmentGeneration: "55555555-5555-4555-8555-555555555555",
  browserInstanceId: "66666666-6666-4666-8666-666666666666",
  idempotencyKey: "77777777-7777-4777-8777-777777777777",
  leaderEpoch: 2,
  leaseVersion: 4,
  resumeSecret: "old_resume_secret_value_that_is_long_enough_123",
};

beforeEach(() => {
  process.env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED = "true";
  process.env.VIPTEL_WORKPLACE_HOTDESK_ENABLED = "true";
  process.env.VIPTEL_WORKPLACE_HOTDESK_MODE = "trusted_test";
  process.env.VIPTEL_WORKPLACE_DEPLOYMENT_STAGE = "local";
  process.env.VIPTEL_WORKPLACE_HOTDESK_PROFILE_IDS = actor.profileId;
});

afterEach(() => {
  delete process.env.VIPTEL_WORKPLACE_HOTDESK_RUNTIME_ENABLED;
  delete process.env.VIPTEL_WORKPLACE_HOTDESK_ENABLED;
  delete process.env.VIPTEL_WORKPLACE_HOTDESK_MODE;
  delete process.env.VIPTEL_WORKPLACE_DEPLOYMENT_STAGE;
  delete process.env.VIPTEL_WORKPLACE_HOTDESK_PROFILE_IDS;
});

describe("workplace resume", () => {
  it("keeps exact resume available while new claims and the pilot allowlist are drained", async () => {
    process.env.VIPTEL_WORKPLACE_HOTDESK_ENABLED = "false";
    delete process.env.VIPTEL_WORKPLACE_HOTDESK_PROFILE_IDS;
    const resume = vi.fn(async (request) => ({
      status: "resumed" as const,
      leaseId: request.leaseId,
      assignmentGeneration: request.assignmentGeneration,
      browserInstanceId: request.newBrowserInstanceId,
      leaderEpoch: request.expectedLeaderEpoch + 1,
      leaseVersion: request.expectedLeaseVersion + 1,
      expiresAt: "2026-08-07T09:01:00.000Z",
      databaseNow: "2026-08-07T09:00:00.000Z",
    }));

    await expect(resumeWorkplaceLease(actor, input, {
      client: presenceClient() as never,
      repository: { resume } as never,
      resumeSecretKey: "resume-test-key-that-is-at-least-thirty-two-characters",
    })).resolves.toMatchObject({ lease: { leaseId: input.leaseId }, resumeSecret: expect.any(String) });
    expect(resume).toHaveBeenCalledOnce();
  });

  it("derives the same next secret for an exact retry after a lost RPC response", async () => {
    const resultFor = (request: Record<string, unknown>) => ({
      status: "resumed" as const,
      leaseId: request.leaseId,
      assignmentGeneration: request.assignmentGeneration,
      browserInstanceId: request.newBrowserInstanceId,
      leaderEpoch: (request.expectedLeaderEpoch as number) + 1,
      leaseVersion: (request.expectedLeaseVersion as number) + 1,
      expiresAt: "2026-08-07T09:01:00.000Z",
      databaseNow: "2026-08-07T09:00:00.000Z",
    });
    const resume = vi.fn()
      .mockRejectedValueOnce(new Error("RPC response lost after commit"))
      .mockImplementation(async (request) => resultFor(request));
    const dependencies = {
      client: presenceClient() as never,
      repository: { resume } as never,
      resumeSecretKey: "resume-test-key-that-is-at-least-thirty-two-characters",
    };

    await expect(resumeWorkplaceLease(actor, input, dependencies)).rejects.toMatchObject({ status: 502 });
    const retry = await resumeWorkplaceLease(actor, input, dependencies);
    const exactReplay = await resumeWorkplaceLease(actor, input, dependencies);

    expect(exactReplay.resumeSecret).toBe(retry.resumeSecret);
    expect(resume).toHaveBeenCalledTimes(3);
    expect(resume.mock.calls[0][0].newResumeSecretHash).toBe(resume.mock.calls[1][0].newResumeSecretHash);
    expect(resume.mock.calls[1][0].newResumeSecretHash).toBe(resume.mock.calls[2][0].newResumeSecretHash);
    expect(resume.mock.calls[0][0].previousResumeSecretHash).toMatch(/^[0-9a-f]{64}$/);

    const later = await resumeWorkplaceLease(actor, {
      ...input,
      leaderEpoch: 3,
      leaseVersion: 5,
      resumeSecret: retry.resumeSecret,
    }, dependencies);
    expect(later.resumeSecret).not.toBe(retry.resumeSecret);
  });
});

function presenceClient() {
  return {
    from(table: string) {
      const data = table === "motorist_workplace_leases"
        ? { extension_id: "88888888-8888-4888-8888-888888888888" }
        : { id: "88888888-8888-4888-8888-888888888888", extension: "20" };
      const query = new Proxy<Record<string, unknown>>({}, {
        get(_target, property) {
          if (property === "then") {
            return (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve);
          }
          return () => property === "maybeSingle" ? Promise.resolve({ data, error: null }) : query;
        },
      });
      return query;
    },
  };
}
