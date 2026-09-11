import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, ORG, PROFILES } from "@/test/telephony-harness";

let harness: ReturnType<typeof createTelephonyHarness>;
let sweepClock = Date.now();
const background = vi.hoisted(() => ({ after: vi.fn(), sweep: vi.fn() }));

vi.mock("next/server", async (importOriginal) => ({
  ...await importOriginal<typeof import("next/server")>(), after: background.after,
}));

vi.mock("@/server/telephony/routing/ring-plan", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/telephony/routing/ring-plan")>(), sweepOverdueRingSteps: background.sweep,
}));

vi.mock("@/server/api-auth", () => ({
  requireDefaultMotoristActor: async () => ({ userId: "user-1", profileId: PROFILES.o1, organizationId: ORG, displayName: "Jana", role: "dispatcher" as const }),
  assertSameOriginRequest: () => {},
}));

vi.mock("@/server/telephony/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/telephony/runtime")>();
  return { ...actual, createTelephonyDeps: async () => harness.deps };
});

import { GET } from "./route";

function leaveEndedCallPresence() {
  const sessionId = String(harness.db.insert("motorist_call_sessions", {
    organization_id: ORG, state: "ended", ended_at: harness.now().toISOString(),
  })[0].id);
  harness.db.insert("motorist_call_legs", { organization_id: ORG, session_id: sessionId,
    profile_id: PROFILES.o1, telnyx_call_control_id: "ended-console-leg", role: "operator",
    state: "ended", ended_at: harness.now().toISOString() });
  harness.setPresence(PROFILES.o1, { status: "on_call", current_session_id: sessionId, offer_token: null });
  harness.advance(300_000);
  return sessionId;
}

describe("GET /api/telephony/calls/active", () => {
  beforeEach(() => {
    process.env.TELNYX_API_KEY = "KEYtest";
    harness = createTelephonyHarness({ ivrOnNeutralLine: false });
    background.after.mockReset();
    background.sweep.mockReset().mockResolvedValue({ checked: 0, swept: [], deferred: [], errors: [] });
    sweepClock += 10_000;
    vi.spyOn(Date, "now").mockReturnValue(sweepClock);
  });

  afterEach(() => {
    delete process.env.TELNYX_API_KEY;
    vi.restoreAllMocks();
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

  it("returns repaired presence when the ended call is already absent from active calls", async () => {
    leaveEndedCallPresence();

    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.calls).toEqual([]);
    expect(body.ownPresence).toMatchObject({ status: "available", automaticOffersAllowed: true });
    expect(body.presence.presence.find((row: { profileId: string }) => row.profileId === PROFILES.o1))
      .toMatchObject({ status: "available", currentSessionId: null });
    expect(harness.presence(PROFILES.o1)).toMatchObject({ status: "available", current_session_id: null });
    expect(harness.telnyx.calls).toHaveLength(0);
  });

  it.each(["live_session", "open_leg"])("keeps call ownership when recovery proof is incomplete: %s", async scenario => {
    const sessionId = leaveEndedCallPresence();
    if (scenario === "live_session") harness.db.update("motorist_call_sessions", { state: "talking", ended_at: null }, row => row.id === sessionId);
    else harness.db.update("motorist_call_legs", { state: "answered", ended_at: null }, row => row.session_id === sessionId);

    const response = await GET();
    expect(response.status).toBe(200);
    expect((await response.json()).ownPresence).toMatchObject({ status: "on_call" });
    expect(harness.presence(PROFILES.o1)).toMatchObject({ status: "on_call", current_session_id: sessionId });
    expect(harness.telnyx.calls).toHaveLength(0);
  });

  it("still serves the phone snapshot and logs a failed presence repair", async () => {
    const sessionId = leaveEndedCallPresence();
    harness.db.failNext("motorist_call_legs", "select", "temporary database failure");

    const response = await GET();
    expect(response.status).toBe(200);
    expect((await response.json()).calls).toEqual([]);
    expect(harness.presence(PROFILES.o1)).toMatchObject({ status: "on_call", current_session_id: sessionId });
    expect(harness.logs).toContainEqual(expect.objectContaining({ scope: "presence_recovery", source: "calls/active",
      error: expect.stringContaining("temporary database failure") }));
  });

  it("returns snapshots while an overdue-session sweep is still waiting", async () => {
    let finishSweep!: () => void;
    background.sweep.mockImplementationOnce(() => new Promise<void>(resolve => { finishSweep = resolve; }));

    const response = await GET();
    expect(response.status).toBe(200);
    expect((await response.json()).calls).toEqual([]);
    expect(background.sweep).not.toHaveBeenCalled();
    expect(background.after).toHaveBeenCalledTimes(1);

    const pendingSweep = background.after.mock.calls[0][0]();
    expect(background.sweep).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: ORG, limit: 4, budgetMs: 2_000,
    }));
    try {
      const nextResponse = await GET();
      expect(nextResponse.status).toBe(200);
      expect((await nextResponse.json()).calls).toEqual([]);
      await background.after.mock.calls[1][0]();
      expect(background.sweep).toHaveBeenCalledTimes(1);
    } finally {
      finishSweep();
      await pendingSweep;
    }
  });

  it("logs a failed background sweep without changing the successful snapshot", async () => {
    background.sweep.mockRejectedValueOnce(new Error("session lease unavailable"));

    const response = await GET();
    expect(response.status).toBe(200);
    await expect(background.after.mock.calls[0][0]()).resolves.toBeUndefined();
    expect(harness.logs).toContainEqual(expect.objectContaining({
      level: "warn", scope: "sweep", source: "calls/active", error: "session lease unavailable",
    }));
    expect((await response.json()).calls).toEqual([]);
  });

  it("returns 503 while telephony is not configured", async () => {
    delete process.env.TELNYX_API_KEY;

    const response = await GET();
    expect(response.status).toBe(503);
    expect(background.after).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ error: "Telefónia nie je nakonfigurovaná.", code: "not_configured" });
  });
});
