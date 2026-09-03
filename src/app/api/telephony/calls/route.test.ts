import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MutationError } from "@/server/motorist-mutations";
import { CallActionError } from "@/server/telephony/call-actions";

const startOutboundCall = vi.fn();
const assertSameOriginRequest = vi.fn();

vi.mock("@/server/api-auth", () => ({
  requireDefaultMotoristActor: async () => ({ userId: "user-1", profileId: "profile-1", organizationId: "org-1", displayName: "Jana", role: "dispatcher" as const }),
  assertSameOriginRequest: (...args: unknown[]) => assertSameOriginRequest(...args),
}));

vi.mock("@/server/telephony/call-actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/call-actions")>();
  return { ...actual, startOutboundCall: (...args: unknown[]) => startOutboundCall(...args) };
});

vi.mock("@/server/telephony/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/runtime")>();
  return { ...actual, createTelephonyDeps: async () => ({ marker: "deps" }) };
});

import { POST } from "./route";

function request(body: Record<string, unknown>) {
  return new Request("https://app.test/api/telephony/calls", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("POST /api/telephony/calls (click-to-call)", () => {
  beforeEach(() => {
    process.env.TELNYX_API_KEY = "KEYtest";
    startOutboundCall.mockReset();
    assertSameOriginRequest.mockReset();
  });

  afterEach(() => {
    delete process.env.TELNYX_API_KEY;
  });

  it("dials and returns the operator leg the browser must auto-answer", async () => {
    startOutboundCall.mockResolvedValue({ sessionId: "sess-1", operatorLegCallControlId: "cc-op", telnyxSessionId: "tsess-1", to: "+421905123456", from: "+421232408718" });

    const response = await POST(request({ to: "0905 123 456", caseId: "case-1" }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ ok: true, sessionId: "sess-1", operatorLegCallControlId: "cc-op" });
    expect(startOutboundCall).toHaveBeenCalledWith({ marker: "deps" }, { profileId: "profile-1", role: "dispatcher", displayName: "Jana" }, { to: "0905 123 456", caseId: "case-1", lineId: null });
  });

  it("returns 429 when the per-operator rate limit trips", async () => {
    startOutboundCall.mockRejectedValue(new CallActionError("Príliš veľa odchádzajúcich hovorov za minútu.", 429, "rate_limited"));

    const response = await POST(request({ to: "+421905123456" }));

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ code: "rate_limited" });
  });

  it("returns 403 for a destination outside the allowlist", async () => {
    startOutboundCall.mockRejectedValue(new CallActionError("Cieľové číslo nie je povolené (allowlist).", 403, "destination_not_allowed"));

    const response = await POST(request({ to: "+15551234567" }));

    expect(response.status).toBe(403);
  });

  it("enforces the same-origin check before dialling", async () => {
    assertSameOriginRequest.mockImplementation(() => {
      throw new MutationError("Požiadavka neprešla bezpečnostnou kontrolou.", 403);
    });

    const response = await POST(request({ to: "+421905123456" }));

    expect(response.status).toBe(403);
    expect(startOutboundCall).not.toHaveBeenCalled();
  });

  it("returns 503 while telephony is not configured", async () => {
    delete process.env.TELNYX_API_KEY;

    const response = await POST(request({ to: "+421905123456" }));

    expect(response.status).toBe(503);
    expect(startOutboundCall).not.toHaveBeenCalled();
  });
});
