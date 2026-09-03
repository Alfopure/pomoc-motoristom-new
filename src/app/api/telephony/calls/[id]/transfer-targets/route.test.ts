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

import { GET } from "./route";

describe("GET /api/telephony/calls/[id]/transfer-targets", () => {
  beforeEach(() => {
    process.env.TELNYX_API_KEY = "KEYtest";
    harness = createTelephonyHarness();
  });

  afterEach(() => {
    delete process.env.TELNYX_API_KEY;
  });

  it("lists colleagues with availability, never the caller", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    const body = (await response.json()) as { targets: Array<{ profileId: string; available: boolean; deviceLive: boolean }> };
    expect(body.targets.map((target) => target.profileId)).not.toContain(PROFILES.o1);
    expect(body.targets.find((target) => target.profileId === PROFILES.o2)).toMatchObject({ available: true, deviceLive: true });
    // Offline operator without a device row.
    expect(body.targets.find((target) => target.profileId === PROFILES.o3)).toMatchObject({ available: false, deviceLive: false });
  });

  it("returns 503 while telephony is not configured", async () => {
    delete process.env.TELNYX_API_KEY;
    expect((await GET()).status).toBe(503);
  });
});
