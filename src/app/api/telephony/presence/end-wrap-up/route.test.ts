import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";

let harness: ReturnType<typeof createTelephonyHarness>;

vi.mock("@/server/api-auth", () => ({
  requireDefaultMotoristActor: async () => ({ userId: "user-1", profileId: PROFILES.o1, organizationId: ORG, displayName: "Jana", role: "dispatcher" as const }),
  assertSameOriginRequest: () => {},
}));

vi.mock("@/server/telephony/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/runtime")>();
  return { ...actual, createTelephonyDeps: async () => harness.deps };
});

import { POST } from "./route";

const request = () => new Request("https://app.test/api/telephony/presence/end-wrap-up", { method: "POST" });

describe("POST /api/telephony/presence/end-wrap-up", () => {
  beforeEach(() => {
    process.env.TELNYX_API_KEY = "KEYtest";
    harness = createTelephonyHarness();
  });

  afterEach(() => {
    delete process.env.TELNYX_API_KEY;
  });

  it("ends after-call work early", async () => {
    harness.setPresence(PROFILES.o1, { status: "after_call_work", wrap_up_until: new Date(harness.now().getTime() + 30_000).toISOString() });

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, status: "available", wrapUpUntil: null });
    expect(harness.presence(PROFILES.o1)).toMatchObject({ status: "available" });
  });

  it("is a no-op in any other status", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "available" });
  });

  it("returns 503 while telephony is not configured", async () => {
    delete process.env.TELNYX_API_KEY;
    expect((await POST(request())).status).toBe(503);
  });
});
