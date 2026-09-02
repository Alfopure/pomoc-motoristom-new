import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertGate: vi.fn(),
  assertPending: vi.fn(),
  begin: vi.fn(),
  claim: vi.fn(),
  requestSnapshot: vi.fn(),
  requireActor: vi.fn(),
  requireLease: vi.fn(),
  resolveOwned: vi.fn(),
  resolvePlanned: vi.fn(),
}));

vi.mock("@/server/telephony/provider-snapshot-bridge", () => ({
  requestViptelProviderSnapshot: mocks.requestSnapshot,
}));
vi.mock("@/server/telephony-access", () => ({
  readWorkplaceLeaseFence: (value: Record<string, unknown>) => ({
    leaseId: value.leaseId,
    assignmentGeneration: value.assignmentGeneration,
    browserInstanceId: value.browserInstanceId,
    leaderEpoch: value.leaderEpoch,
    leaseVersion: value.leaseVersion,
  }),
  requireActiveWorkplaceLease: mocks.requireLease,
  requireTelephonyActor: mocks.requireActor,
  resolveOwnedTelephonyExtension: mocks.resolveOwned,
}));
vi.mock("@/server/telephony/assignment-interlock", () => ({ claimOwnedExtensionAction: mocks.claim }));
vi.mock("@/server/telephony/dispatch-routing", () => ({
  assertNoPendingDispatchAvailabilityCommand: mocks.assertPending,
  dispatchAvailabilityPayload: (input: unknown) => ({ routingAvailability: { kind: "availability", ...(input as object) } }),
  resolvePlannedDispatchQueue: mocks.resolvePlanned,
}));
vi.mock("@/server/telephony/live-mutation-gate", () => ({ assertTelephonyLiveMutationEnabled: mocks.assertGate }));
vi.mock("@/server/telephony/telephony-commands", () => ({ beginTelephonyCommand: mocks.begin }));

import { MutationError } from "@/server/motorist-mutations";
import { POST } from "./route";

const actor = { organizationId: "org-1", profileId: "profile-1", role: "dispatcher" };

describe("operator dispatch availability API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireActor.mockResolvedValue(actor);
    mocks.resolveOwned.mockResolvedValue({ id: "extension-id-20", extension: "20" });
    mocks.claim.mockResolvedValue({
      id: "extension-id-20",
      extension: "20",
      assignmentGuard: {
        claimId: "claim-availability-20",
        extension: "20",
        extensionId: "extension-id-20",
        generation: "generation-20",
        profileId: "profile-1",
      },
    });
    mocks.resolvePlanned.mockResolvedValue({ queue: "601", queueId: "queue-id-601", revision: 4 });
    mocks.requestSnapshot.mockResolvedValue({
      queueStatuses: [{ queue: "601", waitingCalls: 0, members: [] }],
    });
    mocks.begin.mockResolvedValue({ id: "command-1" });
  });

  it("rejects a client-selected queue", async () => {
    const response = await POST(request({ queue: "603", extension: "20", action: "available" }));
    expect(response.status).toBe(400);
    expect(mocks.resolvePlanned).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it("derives queue and revision server-side before enqueuing availability", async () => {
    const response = await POST(request({ extension: "20", action: "available" }));
    expect(response.status).toBe(202);
    expect(mocks.resolvePlanned).toHaveBeenCalledWith("org-1", "20");
    expect(mocks.assertPending).toHaveBeenCalledWith("org-1", "601", "20");
    expect(mocks.begin).toHaveBeenCalledWith(expect.objectContaining({
      commandType: "queue.add",
      queueId: "queue-id-601",
      extensionId: "extension-id-20",
      assignmentGuard: expect.objectContaining({ claimId: "claim-availability-20", profileId: "profile-1" }),
      requestPayload: expect.objectContaining({
        queue: "601",
        extension: "20",
        routingAvailability: expect.objectContaining({ revision: 4, intent: "available" }),
      }),
    }));
  });

  it("returns a provider-observed no-op instead of optimistic queued success", async () => {
    mocks.requestSnapshot.mockResolvedValue({
      queueStatuses: [{
        queue: "601",
        waitingCalls: 0,
        members: [{ extension: "20", paused: true }],
      }],
    });
    const response = await POST(request({ extension: "20", action: "pause" }));
    expect(response.status).toBe(200);
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ ok: true, noOp: true, queue: "601", state: "pause" });
  });

  it("fails closed when the personal extension is outside the current plan", async () => {
    mocks.resolvePlanned.mockRejectedValue(new MutationError("not planned", 403));
    const response = await POST(request({ extension: "20", action: "available" }));
    expect(response.status).toBe(403);
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it("stops before command creation when an assignment transition wins the extension CAS", async () => {
    mocks.claim.mockRejectedValue(new MutationError("assignment transition in progress", 409));

    const response = await POST(request({ extension: "20", action: "available" }));

    expect(response.status).toBe(409);
    expect(mocks.claim).toHaveBeenCalledWith(actor, "extension-id-20", "queue.availability", {
      leaseFence: undefined,
    });
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it.each([
    { label: "an empty object", request: () => request({}) },
    { label: "malformed JSON", request: () => rawRequest("{broken") },
    { label: "a Unicode action", request: () => request({ action: " dostupný ", extension: "20" }) },
    { label: "an oversized action", request: () => request({ action: "a".repeat(4096), extension: "20" }) },
    { label: "an injected extension", request: () => request({ action: "available", extension: "20,603" }) },
    { label: "Unicode digits", request: () => request({ action: "available", extension: "２０" }) },
  ])("rejects $label before gate, ownership, or provider access", async ({ request: makeRequest }) => {
    const response = await POST(makeRequest());

    expect(response.status).toBe(400);
    expect(mocks.assertGate).not.toHaveBeenCalled();
    expect(mocks.resolveOwned).not.toHaveBeenCalled();
    expect(mocks.requestSnapshot).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it("fails closed at the live gate before ownership or provider access", async () => {
    mocks.assertGate.mockImplementationOnce(() => {
      throw new MutationError("Preview je read-only.", 503);
    });

    const response = await POST(request({ action: "available", extension: "20" }));

    expect(response.status).toBe(503);
    expect(mocks.resolveOwned).not.toHaveBeenCalled();
    expect(mocks.requestSnapshot).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it("rejects a repeated pending availability request before provider access", async () => {
    mocks.assertPending.mockRejectedValueOnce(new MutationError("availability already pending", 409));

    const response = await POST(request({ action: "available", extension: "20" }));

    expect(response.status).toBe(409);
    expect(mocks.requestSnapshot).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
  });

  it("blocks a stale browser lease before queue planning or provider access", async () => {
    mocks.requireLease.mockRejectedValueOnce(new MutationError("Relácia bola prevzatá.", 409, "lease_lost"));
    const response = await POST(request({
      action: "available",
      extension: "20",
      leaseId: "11111111-1111-4111-8111-111111111111",
      assignmentGeneration: "22222222-2222-4222-8222-222222222222",
      browserInstanceId: "33333333-3333-4333-8333-333333333333",
      leaderEpoch: 1,
      leaseVersion: 1,
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "lease_lost" });
    expect(mocks.resolvePlanned).not.toHaveBeenCalled();
    expect(mocks.requestSnapshot).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
  });
});

function request(body: unknown) {
  return rawRequest(JSON.stringify(body));
}

function rawRequest(body: string) {
  return new Request("https://app.test/api/telephony/queues/agent", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://app.test" },
    body,
  });
}
