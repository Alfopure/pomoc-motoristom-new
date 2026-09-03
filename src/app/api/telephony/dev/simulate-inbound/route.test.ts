import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MutationError } from "@/server/motorist-mutations";
import { createTelephonyHarness, NUMBERS, ORG, PROFILES } from "@/test/telephony-harness";

let harness: ReturnType<typeof createTelephonyHarness>;
const requireDefaultMotoristActor = vi.fn();

vi.mock("@/server/api-auth", () => ({
  requireDefaultMotoristActor: (...args: unknown[]) => requireDefaultMotoristActor(...args),
  assertSameOriginRequest: () => {},
}));

vi.mock("@/server/telephony/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/runtime")>();
  return { ...actual, createTelephonyDeps: async () => harness.deps };
});

import { POST } from "./route";

function request(body: Record<string, unknown>) {
  return new Request("https://app.test/api/telephony/dev/simulate-inbound", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("POST /api/telephony/dev/simulate-inbound", () => {
  beforeEach(() => {
    process.env.TELNYX_API_KEY = "KEYtest";
    delete process.env.VERCEL_ENV;
    harness = createTelephonyHarness({ ivrOnNeutralLine: false });
    requireDefaultMotoristActor.mockReset().mockResolvedValue({ userId: "user-1", profileId: PROFILES.o5, organizationId: ORG, displayName: "Admin", role: "admin" as const });
  });

  afterEach(() => {
    delete process.env.TELNYX_API_KEY;
    delete process.env.VERCEL_ENV;
  });

  it("drives a synthetic inbound call through the real webhook processor", async () => {
    const response = await POST(request({ from: NUMBERS.customer, to: NUMBERS.allianz }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { sessionId: string; results: Array<{ type: string; outcome: string }> };
    expect(body.results.map((result) => result.type)).toEqual(["call.initiated", "call.answered"]);
    expect(body.results.every((result) => result.outcome === "processed")).toBe(true);
    expect(harness.session(body.sessionId)).toMatchObject({ state: "ringing", direction: "inbound", caller_number: NUMBERS.customer });
  });

  it("stops after call.initiated when answering is not requested", async () => {
    const response = await POST(request({ to: NUMBERS.allianz, answer: false }));

    const body = (await response.json()) as { results: Array<{ type: string }> };
    expect(body.results.map((result) => result.type)).toEqual(["call.initiated"]);
  });

  it("requires the called number", async () => {
    const response = await POST(request({ from: NUMBERS.customer }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Chýba volané číslo (to)." });
  });

  it("is refused on the production deployment", async () => {
    process.env.VERCEL_ENV = "production";

    const response = await POST(request({ to: NUMBERS.allianz }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Simulácia hovoru nie je v produkcii dostupná." });
  });

  it("is admin-only", async () => {
    requireDefaultMotoristActor.mockRejectedValue(new MutationError("Na túto operáciu nemáš oprávnenie.", 403));

    const response = await POST(request({ to: NUMBERS.allianz }));

    expect(response.status).toBe(403);
    expect(requireDefaultMotoristActor).toHaveBeenCalledWith(["admin"]);
  });

  it("returns 503 while telephony is not configured", async () => {
    delete process.env.TELNYX_API_KEY;

    expect((await POST(request({ to: NUMBERS.allianz }))).status).toBe(503);
  });
});
