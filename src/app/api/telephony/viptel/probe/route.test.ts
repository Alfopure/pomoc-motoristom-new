import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requestSnapshot: vi.fn(),
  requireActor: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/api-auth", () => ({ requireDefaultMotoristActor: mocks.requireActor }));
vi.mock("@/server/telephony/provider-snapshot-bridge", () => ({
  requestViptelProviderSnapshot: mocks.requestSnapshot,
}));

import { MutationError } from "@/server/motorist-mutations";
import { GET } from "./route";

const actor = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  profileId: "22222222-2222-4222-8222-222222222222",
};

describe("VIPTel listener bridge probe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireActor.mockResolvedValue(actor);
    mocks.requestSnapshot.mockResolvedValue({
      capturedAt: "2026-08-05T12:00:00.000Z",
      personalExtensions: ["20", "21", "22", "23"],
      extensions: [{ extension: "20", outboundCid: "0412289240" }],
      activeCalls: [],
      queueStatuses: [
        { queue: "601", waitingCalls: 0, members: [] },
        { queue: "602", waitingCalls: 0, members: [] },
        { queue: "603", waitingCalls: 0, members: [] },
      ],
    });
  });

  it("uses only a fresh Hetzner snapshot for the authenticated admin probe", async () => {
    const response = await GET(new Request("https://app.test/api/telephony/viptel/probe?extension=20"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      extensionFound: true,
      callerIdAllowed: true,
      rest: { transport: "hetzner_listener_snapshot_bridge", queueCount: 3 },
    });
    expect(mocks.requireActor).toHaveBeenCalledWith(["admin"]);
    expect(mocks.requestSnapshot).toHaveBeenCalledWith(actor.organizationId, actor.profileId, { maxAgeMs: 2_000 });
  });

  it("propagates bridge failure and never reports a guessed healthy state", async () => {
    mocks.requestSnapshot.mockRejectedValueOnce(new MutationError("Listener timeout.", 504));
    const response = await GET(new Request("https://app.test/api/telephony/viptel/probe"));
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "Listener timeout." });
  });

  it("does not request provider state when admin authentication fails", async () => {
    mocks.requireActor.mockRejectedValueOnce(new MutationError("Forbidden.", 403));
    const response = await GET(new Request("https://app.test/api/telephony/viptel/probe"));
    expect(response.status).toBe(403);
    expect(mocks.requestSnapshot).not.toHaveBeenCalled();
  });
});
