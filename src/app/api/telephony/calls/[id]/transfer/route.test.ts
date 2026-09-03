import { beforeEach, describe, expect, it, vi } from "vitest";

import { CallActionError } from "@/server/telephony/call-actions";

const blindTransfer = vi.fn();

vi.mock("@/server/api-auth", () => ({
  requireDefaultMotoristActor: async () => ({ userId: "user-1", profileId: "profile-1", organizationId: "org-1", displayName: "Jana", role: "dispatcher" as const }),
  assertSameOriginRequest: () => {},
}));

vi.mock("@/server/telephony/call-actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/call-actions")>();
  return { ...actual, blindTransfer: (...args: unknown[]) => blindTransfer(...args) };
});

vi.mock("@/server/telephony/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/runtime")>();
  return { ...actual, createTelephonyDeps: async () => ({ marker: "deps" }) };
});

import { POST } from "./route";

function request(body: Record<string, unknown>) {
  return new Request("https://app.test/api/telephony/calls/sess-1/transfer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

const context = { params: Promise.resolve({ id: "sess-1" }) };

describe("POST /api/telephony/calls/[id]/transfer", () => {
  beforeEach(() => {
    process.env.TELNYX_API_KEY = "KEYtest";
    blindTransfer.mockReset().mockResolvedValue({ sessionId: "sess-1", state: "ringing", commands: [], ignored: null });
  });

  it("passes a colleague target through", async () => {
    await POST(request({ profileId: "profile-2" }), context);
    expect(blindTransfer).toHaveBeenCalledWith(expect.anything(), expect.anything(), "sess-1", { profileId: "profile-2", number: null });
  });

  it("passes an external number target through", async () => {
    await POST(request({ number: " +421900000000 " }), context);
    expect(blindTransfer).toHaveBeenCalledWith(expect.anything(), expect.anything(), "sess-1", { profileId: null, number: "+421900000000" });
  });

  it("lets the service reject an empty target with 400", async () => {
    blindTransfer.mockRejectedValue(new CallActionError("Chýba cieľ prepojenia.", 400, "missing_target"));
    const response = await POST(request({}), context);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "missing_target" });
  });
});
