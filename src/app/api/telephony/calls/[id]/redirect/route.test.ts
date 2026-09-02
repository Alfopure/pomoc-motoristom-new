import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  requireActor: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/integrations/viptel/client", () => ({
  serializeViptelError: (error: unknown) => ({ message: error instanceof Error ? error.message : "error", status: 500 }),
}));
vi.mock("@/server/telephony-access", () => ({
  readWorkplaceLeaseFence: (value: Record<string, unknown>) => ({
    assignmentGeneration: value.assignmentGeneration,
    browserInstanceId: value.browserInstanceId,
    leaderEpoch: value.leaderEpoch,
    leaseId: value.leaseId,
    leaseVersion: value.leaseVersion,
  }),
  requireTelephonyActor: mocks.requireActor,
}));
vi.mock("@/server/telephony/call-commands", () => ({ enqueueRedirectCommand: mocks.enqueue }));

import { MutationError } from "@/server/motorist-mutations";
import { POST } from "./route";

const actor = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  profileId: "22222222-2222-4222-8222-222222222222",
};
const callId = "33333333-3333-4333-8333-333333333333";
const destinationProfileId = "44444444-4444-4444-8444-444444444444";
const fence = {
  assignmentGeneration: "55555555-5555-4555-8555-555555555555",
  browserInstanceId: "66666666-6666-4666-8666-666666666666",
  leaderEpoch: 2,
  leaseId: "77777777-7777-4777-8777-777777777777",
  leaseVersion: 3,
};
const context = { params: Promise.resolve({ id: callId }) };

describe("call redirect route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireActor.mockResolvedValue(actor);
    mocks.enqueue.mockResolvedValue({ id: "88888888-8888-4888-8888-888888888888" });
  });

  it("forwards the exact workplace lease fence into redirect authorization", async () => {
    const response = await POST(request({ destinationProfileId, ...fence }), context);

    expect(response.status).toBe(202);
    expect(mocks.enqueue).toHaveBeenCalledWith(actor, callId, {
      destinationNumber: undefined,
      destinationProfileId,
    }, fence);
  });

  it("keeps the legacy body parseable while the server capability gate decides whether a fence is required", async () => {
    await POST(request({ destinationProfileId }), context);

    expect(mocks.enqueue).toHaveBeenCalledWith(actor, callId, {
      destinationNumber: undefined,
      destinationProfileId,
    }, undefined);
  });

  it("forwards a manually entered phone number through the same authenticated command", async () => {
    await POST(request({ destinationNumber: "+421 900 111 222", ...fence }), context);

    expect(mocks.enqueue).toHaveBeenCalledWith(actor, callId, {
      destinationNumber: "+421 900 111 222",
      destinationProfileId: undefined,
    }, fence);
  });

  it("returns the machine-readable stale-lease code", async () => {
    mocks.enqueue.mockRejectedValueOnce(new MutationError("Relácia už neplatí.", 409, "lease_lost"));

    const response = await POST(request({ destinationProfileId, ...fence }), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "lease_lost", ok: false });
  });
});

function request(body: Record<string, unknown>) {
  return new Request(`https://app.test/api/telephony/calls/${callId}/redirect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
