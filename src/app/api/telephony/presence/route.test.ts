import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";

let harness: ReturnType<typeof createTelephonyHarness>;
let actorProfileId: string = PROFILES.o1;
let actorRole: "dispatcher" | "senior_dispatcher" | "manager" | "admin" = "dispatcher";

vi.mock("@/server/api-auth", () => ({
  requireDefaultMotoristActor: async () => ({ userId: "user-1", profileId: actorProfileId, organizationId: ORG, displayName: "Jana", role: actorRole }),
  assertSameOriginRequest: () => {},
}));

vi.mock("@/server/telephony/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/runtime")>();
  return { ...actual, createTelephonyDeps: async () => harness.deps };
});

import { GET, POST } from "./route";

function postRequest(body: Record<string, unknown>) {
  return new Request("https://app.test/api/telephony/presence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("/api/telephony/presence", () => {
  beforeEach(() => {
    process.env.TELNYX_API_KEY = "KEYtest";
    harness = createTelephonyHarness();
    actorProfileId = PROFILES.o1;
    actorRole = "dispatcher";
  });

  afterEach(() => {
    delete process.env.TELNYX_API_KEY;
  });

  it("returns the org presence snapshot, the caller's own row and the pause reasons", async () => {
    const body = (await (await GET()).json()) as Record<string, never>;

    expect(body.snapshot).toMatchObject({ actorProfileId: PROFILES.o1, canManageAssignments: false });
    expect(body.own).toMatchObject({ profileId: PROFILES.o1, status: "available" });
    expect((body.pauseReasons as unknown as Array<{ code: string }>).map((reason) => reason.code)).toEqual(["obed"]);
  });

  it("stores a pause with its reason and answers with the fresh snapshot", async () => {
    const response = await POST(postRequest({ status: "paused", pauseReasonId: "00000000-0000-4000-8000-000000002501" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, own: { status: "paused" } });
    expect(harness.presence(PROFILES.o1)).toMatchObject({ status: "paused", pause_reason_id: "00000000-0000-4000-8000-000000002501" });
  });

  it("rejects a status the operator may not set", async () => {
    const response = await POST(postRequest({ status: "on_call" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Neplatný stav prezencie." });
  });

  it("refuses a manual change during a call", async () => {
    harness.setPresence(PROFILES.o1, { status: "on_call", current_session_id: "00000000-0000-4000-8000-00000000ffff" });

    const response = await POST(postRequest({ status: "offline" }));

    expect(response.status).toBe(409);
  });

  it("marks a senior dispatcher as able to manage assignments", async () => {
    actorProfileId = PROFILES.o3;
    actorRole = "senior_dispatcher";
    const body = (await (await GET()).json()) as { snapshot: { canManageAssignments: boolean; actorProfileId: string } };

    expect(body.snapshot).toMatchObject({ actorProfileId: PROFILES.o3, canManageAssignments: true });
  });

  it("returns 503 while telephony is not configured", async () => {
    delete process.env.TELNYX_API_KEY;

    expect((await GET()).status).toBe(503);
    expect((await POST(postRequest({ status: "available" }))).status).toBe(503);
  });
});
