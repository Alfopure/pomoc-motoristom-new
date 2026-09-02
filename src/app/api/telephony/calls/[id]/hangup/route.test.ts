import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  requireActor: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/integrations/viptel/client", () => ({
  serializeViptelError: (error: unknown) => ({
    message: error instanceof Error ? error.message : "provider error",
    status: 500,
  }),
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
vi.mock("@/server/telephony/call-commands", () => ({ enqueueHangupCommand: mocks.enqueue }));

import { POST } from "./route";

const actor = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  profileId: "00000000-0000-4000-8000-000000000002",
};
const callId = "00000000-0000-4000-8000-000000000003";
const fence = {
  assignmentGeneration: "00000000-0000-4000-8000-000000000004",
  browserInstanceId: "00000000-0000-4000-8000-000000000005",
  leaderEpoch: 2,
  leaseId: "00000000-0000-4000-8000-000000000006",
  leaseVersion: 3,
};
const context = { params: Promise.resolve({ id: callId }) };

describe("call hangup route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireActor.mockResolvedValue(actor);
    mocks.enqueue.mockResolvedValue({ id: "00000000-0000-4000-8000-000000000007" });
  });

  it("marks only an explicit ringing queue decline for the handoff-safe ownership rule", async () => {
    const response = await POST(request({
      ...fence,
      intent: "decline_incoming_queue",
    }), context);

    expect(response.status).toBe(202);
    expect(mocks.enqueue).toHaveBeenCalledWith(actor, callId, fence, {
      incomingQueueDecline: true,
    });
  });

  it("keeps ordinary hangup strict even when the client supplies another intent", async () => {
    await POST(request({ ...fence, intent: "something_else" }), context);

    expect(mocks.enqueue).toHaveBeenCalledWith(actor, callId, fence, {
      incomingQueueDecline: false,
    });
  });
});

function request(body: Record<string, unknown>) {
  return new Request(`https://app.test/api/telephony/calls/${callId}/hangup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
