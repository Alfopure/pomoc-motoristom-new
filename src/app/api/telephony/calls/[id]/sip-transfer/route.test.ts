import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  record: vi.fn(),
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
vi.mock("@/server/telephony/call-commands", () => ({
  enqueueBrowserSipReferTransferCommand: mocks.enqueue,
}));
vi.mock("@/server/telephony/telephony-commands", () => ({
  recordBrowserSipReferTransferDelivery: mocks.record,
}));

import { PATCH, POST } from "./route";

const actor = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  profileId: "00000000-0000-4000-8000-000000000002",
};
const callId = "00000000-0000-4000-8000-000000000003";
const commandId = "00000000-0000-4000-8000-000000000004";
const destinationProfileId = "00000000-0000-4000-8000-000000000005";
const fence = {
  assignmentGeneration: "00000000-0000-4000-8000-000000000006",
  browserInstanceId: "00000000-0000-4000-8000-000000000007",
  leaderEpoch: 2,
  leaseId: "00000000-0000-4000-8000-000000000008",
  leaseVersion: 3,
};
const context = { params: Promise.resolve({ id: callId }) };

describe("browser SIP transfer route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireActor.mockResolvedValue(actor);
    mocks.enqueue.mockResolvedValue({
      id: commandId,
      authorizedTarget: "21",
      authorizedViptelUniqueId: "provider-leg.1",
    });
    mocks.record.mockResolvedValue({ id: commandId, status: "confirmed_by_event" });
  });

  it("authorizes the destination and exact workplace lease before exposing a REFER target", async () => {
    const response = await POST(request("POST", { destinationProfileId, ...fence }), context);

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.enqueue).toHaveBeenCalledWith(actor, callId, {
      destinationNumber: undefined,
      destinationProfileId,
    }, fence);
    await expect(response.json()).resolves.toMatchObject({
      authorizedTarget: "21",
      authorizedViptelUniqueId: "provider-leg.1",
      command: { id: commandId, status: "accepted" },
      ok: true,
    });
  });

  it("records a final successful SIP response as provider confirmation", async () => {
    const response = await PATCH(request("PATCH", {
      commandId,
      outcome: "accepted",
      sipStatus: 202,
    }), context);

    expect(response.status).toBe(200);
    expect(mocks.record).toHaveBeenCalledWith({
      callId,
      commandId,
      organizationId: actor.organizationId,
      requestedBy: actor.profileId,
      report: { outcome: "accepted", sipStatus: 202 },
    });
  });

  it("records an explicit client failure without accepting arbitrary result shapes", async () => {
    await PATCH(request("PATCH", {
      commandId,
      error: "SIP 403",
      outcome: "failed",
    }), context);
    expect(mocks.record).toHaveBeenLastCalledWith(expect.objectContaining({
      report: { error: "SIP 403", outcome: "failed" },
    }));

    const malformed = await PATCH(request("PATCH", {
      commandId,
      outcome: "accepted",
      sipStatus: 603,
    }), context);
    expect(malformed.status).toBe(400);
    expect(mocks.record).toHaveBeenCalledTimes(1);
  });
});

function request(method: "PATCH" | "POST", body: Record<string, unknown>) {
  return new Request(`https://app.test/api/telephony/calls/${callId}/sip-transfer`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
