import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CallActionError } from "@/server/telephony/call-actions";

const callColleague = vi.fn();

vi.mock("@/server/api-auth", () => ({
  requireDefaultMotoristActor: async () => ({ userId: "user-1", profileId: "profile-1", organizationId: "org-1", displayName: "Jana", role: "dispatcher" as const }),
  assertSameOriginRequest: () => {},
}));

vi.mock("@/server/telephony/call-actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/call-actions")>();
  return { ...actual, callColleague: (...args: unknown[]) => callColleague(...args) };
});

vi.mock("@/server/telephony/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/runtime")>();
  return { ...actual, createTelephonyDeps: async () => ({ marker: "deps" }) };
});

import { POST } from "./route";

function request(body: Record<string, unknown>) {
  return new Request("https://app.test/api/telephony/calls/internal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("POST /api/telephony/calls/internal", () => {
  beforeEach(() => {
    process.env.TELNYX_API_KEY = "KEYtest";
    callColleague.mockReset();
  });

  afterEach(() => {
    delete process.env.TELNYX_API_KEY;
  });

  it("calls the colleague and returns the caller leg", async () => {
    callColleague.mockResolvedValue({ sessionId: "sess-1", operatorLegCallControlId: "cc-op", telnyxSessionId: null, to: "sip:gencred002@sip.telnyx.com", from: "+421232408718" });

    const response = await POST(request({ targetProfileId: "profile-2" }));

    expect(response.status).toBe(201);
    expect(callColleague).toHaveBeenCalledWith({ marker: "deps" }, expect.objectContaining({ profileId: "profile-1" }), { targetProfileId: "profile-2" });
  });

  it("returns 409 when the colleague is not available", async () => {
    callColleague.mockRejectedValue(new CallActionError("Kolega nie je dostupný.", 409, "target_unavailable"));

    const response = await POST(request({ targetProfileId: "profile-2" }));

    expect(response.status).toBe(409);
  });
});
