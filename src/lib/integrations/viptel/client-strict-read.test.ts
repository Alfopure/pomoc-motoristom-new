import { afterEach, describe, expect, it, vi } from "vitest";

import { ViptelClient, ViptelHttpError } from "./client";

const client = new ViptelClient({
  restBaseUrl: "https://pbx.example.test/",
  websocketUrl: "wss://pbx.example.test/",
  username: "user",
  password: "secret",
  requestTimeoutMs: 1_000,
});

afterEach(() => vi.unstubAllGlobals());

describe("VIPTel strict live-read payloads", () => {
  it("accepts the observed extension payload and retains explicit registration booleans", async () => {
    stubJson([{
      extension: "20",
      name: "Operator 20",
      outboundcid: "0412289240",
      call_forwarding: false,
      is_registered: true,
      is_viptel_phone_active: true,
      allowed_changes: ["name"],
      dnd: false,
    }]);

    await expect(client.listExtensions()).resolves.toEqual([expect.objectContaining({
      extension: "20",
      isRegistered: true,
      isViptelPhoneActive: true,
      outboundCid: "0412289240",
    })]);
  });

  it("accepts the observed empty active-call object", async () => {
    stubJson({ calls_active: "0", calls: [] });
    await expect(client.listActiveCalls()).resolves.toEqual([]);
  });

  it("rejects a malformed successful active-call response instead of treating it as empty", async () => {
    stubJson({ calls_active: "0", result: "ok" });
    await expect(client.listActiveCalls()).rejects.toBeInstanceOf(ViptelHttpError);
  });

  it.each([
    { calls_active: "1", calls: ["not-a-call"] },
    { calls_active: "1", calls: [{}] },
  ])("rejects malformed entries in a recognized active-call list %#", async (payload) => {
    stubJson(payload);
    await expect(client.listActiveCalls()).rejects.toBeInstanceOf(ViptelHttpError);
  });

  it("accepts the observed empty queue shape with waiting_calls as an array", async () => {
    stubJson({ queue: "601", members: [], waiting_calls: [] });
    await expect(client.getQueueStatus("601")).resolves.toEqual({ queue: "601", members: [], waitingCalls: 0 });
  });

  it("accepts the observed non-empty member booleans and call counter", async () => {
    stubJson({
      queue: "601",
      waiting_calls: [],
      members: [{
        extension: "20",
        calls_taken: 3,
        dynamic: true,
        paused: false,
        in_use: true,
        last_call_taken_ago: null,
      }],
    });
    await expect(client.getQueueStatus("601")).resolves.toEqual({
      queue: "601",
      waitingCalls: 0,
      members: [{ extension: "20", callsTaken: 3, dynamic: true, paused: false, inUse: true }],
    });
  });

  it.each([
    { queue: "602", members: [], waiting_calls: [] },
    { queue: "601", members: [] },
    { queue: "601", members: [{ extension: "20", calls_taken: 0, dynamic: true, paused: false }], waiting_calls: [] },
    { queue: "601", members: [{ extension: "20", dynamic: true, paused: false, in_use: false }], waiting_calls: [] },
  ])("rejects malformed successful queue status %#", async (payload) => {
    stubJson(payload);
    await expect(client.getQueueStatus("601")).rejects.toBeInstanceOf(ViptelHttpError);
  });
});

function stubJson(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })));
}
