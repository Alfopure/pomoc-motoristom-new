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

describe("GET /api/telephony/calls/active", () => {
  beforeEach(() => {
    process.env.TELNYX_API_KEY = "KEYtest";
    harness = createTelephonyHarness({ ivrOnNeutralLine: false });
  });

  afterEach(() => {
    delete process.env.TELNYX_API_KEY;
  });

  it("returns an uncached snapshot with presence even when nothing is ringing", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = (await response.json()) as { calls: unknown[]; presence: { presence: unknown[] } };
    expect(body.calls).toEqual([]);
    expect(body.presence.presence.length).toBeGreaterThan(0);
  });

  it("projects a live inbound call with its line label and matched-case fields", async () => {
    const { sessionId } = await harness.inbound({ to: "+421232408718" });

    const body = (await (await GET()).json()) as { calls: Array<Record<string, unknown>>; waiting: unknown[] };
    expect(body.calls).toHaveLength(1);
    expect(body.calls[0]).toMatchObject({ sessionId, state: "ringing", lineLabel: "Allianz Assistance", mine: true, caseId: null });
    expect(body.waiting).toEqual([]);
  });

  it("returns 503 while telephony is not configured", async () => {
    delete process.env.TELNYX_API_KEY;

    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Telefónia nie je nakonfigurovaná." });
  });
});
