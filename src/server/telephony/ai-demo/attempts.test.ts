import { beforeEach, describe, expect, it } from "vitest";

import { createTelephonyHarness, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";

import {
  adoptLeg, casCounter, claimProbe, countToday, findByRequestId, findDue, findPendingForIncoming, insertAttempt,
  loadActive, loadAttempt, markLegGone, transitionAttempt,
} from "./attempts";

const DEADLINE = new Date("2026-09-03T08:10:00.000Z");

function input(overrides: Partial<Parameters<typeof insertAttempt>[1]> = {}) {
  return {
    organizationId: ORG,
    environment: "development" as const,
    actorProfileId: PROFILES.o5,
    requestId: null,
    scenario: "replacement_vehicle_return",
    targetNumber: "+421910988882",
    fromNumber: "+421232408774",
    correlationToken: "PM-AI-DEMO-1a2b3c4d",
    sipDialCommandId: "cmd-sip-1",
    requestedAt: new Date("2026-09-03T08:00:00.000Z"),
    deadlineAt: DEADLINE,
    ...overrides,
  };
}

describe("insertAttempt", () => {
  let h: TelephonyHarness;
  beforeEach(() => {
    h = createTelephonyHarness();
  });

  it("creates the row before any provider call is made", async () => {
    const result = await insertAttempt(h.deps.admin, input());
    expect("attempt" in result).toBe(true);
    if (!("attempt" in result)) return;
    expect(result.attempt.state).toBe("requested");
    expect(result.attempt.direction).toBe("outbound");
  });

  it("refuses a second concurrent demo", async () => {
    await insertAttempt(h.deps.admin, input());
    await expect(insertAttempt(h.deps.admin, input())).resolves.toEqual({ conflict: "busy" });
  });

  it("allows a new demo once the previous one is terminal", async () => {
    const first = await insertAttempt(h.deps.admin, input());
    if (!("attempt" in first)) expect.unreachable();
    else await transitionAttempt(h.deps.admin, first.attempt.id, ["requested"], { state: "ended" });
    await expect(insertAttempt(h.deps.admin, input())).resolves.toHaveProperty("attempt");
  });

  it("finds a replayed request instead of creating a second attempt", async () => {
    const requestId = "11111111-2222-4333-8444-555555555555";
    const first = await insertAttempt(h.deps.admin, input({ requestId }));
    if (!("attempt" in first)) return expect.unreachable();
    const found = await findByRequestId(h.deps.admin, ORG, PROFILES.o5, requestId);
    expect(found?.id).toBe(first.attempt.id);
  });
});

describe("transitionAttempt", () => {
  let h: TelephonyHarness;
  let id: string;
  beforeEach(async () => {
    h = createTelephonyHarness();
    const created = await insertAttempt(h.deps.admin, input());
    id = "attempt" in created ? created.attempt.id : "";
  });

  it("moves the row only from one of the expected states", async () => {
    expect(await transitionAttempt(h.deps.admin, id, ["requested"], { state: "sip_dialing" })).not.toBeNull();
    // The second delivery of the same webhook finds the row already moved.
    expect(await transitionAttempt(h.deps.admin, id, ["requested"], { state: "sip_dialing" })).toBeNull();
  });

  it("lets exactly one of two racing transitions win", async () => {
    const [a, b] = await Promise.all([
      transitionAttempt(h.deps.admin, id, ["requested"], { state: "sip_dialing" }),
      transitionAttempt(h.deps.admin, id, ["requested"], { state: "ending", end_reason: "admin_stop" }),
    ]);
    expect([a, b].filter((row) => row !== null)).toHaveLength(1);
  });

  it("keeps the active attempt readable while it is not terminal", async () => {
    await transitionAttempt(h.deps.admin, id, ["requested"], { state: "talking" });
    expect((await loadActive(h.deps.admin, ORG))?.id).toBe(id);
    await transitionAttempt(h.deps.admin, id, ["talking"], { state: "ended" });
    expect(await loadActive(h.deps.admin, ORG)).toBeNull();
  });
});

describe("casCounter", () => {
  it("increments once even when two cleanups race", async () => {
    const h = createTelephonyHarness();
    const created = await insertAttempt(h.deps.admin, input());
    if (!("attempt" in created)) return expect.unreachable();
    const id = created.attempt.id;

    const [a, b] = await Promise.all([
      casCounter(h.deps.admin, id, "openai_hangup_attempts", 0),
      casCounter(h.deps.admin, id, "openai_hangup_attempts", 0),
    ]);

    expect([a, b].filter((row) => row !== null)).toHaveLength(1);
    expect((await loadAttempt(h.deps.admin, ORG, id))?.openai_hangup_attempts).toBe(1);
  });
});

describe("adoptLeg", () => {
  it("records provider ids from whichever event arrives first", async () => {
    const h = createTelephonyHarness();
    const created = await insertAttempt(h.deps.admin, input());
    if (!("attempt" in created)) return expect.unreachable();

    await adoptLeg(h.deps.admin, created.attempt.id, "sip", { callControlId: "cc-sip", callLegId: "leg-sip", callSessionId: "sess-1" });
    const row = await loadAttempt(h.deps.admin, ORG, created.attempt.id);
    expect(row?.telnyx_sip_call_control_id).toBe("cc-sip");
    expect(row?.telnyx_call_session_id).toBe("sess-1");
  });

  it("does not steal a call_control_id already owned by another attempt", async () => {
    const h = createTelephonyHarness();
    const first = await insertAttempt(h.deps.admin, input());
    if (!("attempt" in first)) return expect.unreachable();
    await adoptLeg(h.deps.admin, first.attempt.id, "sip", { callControlId: "cc-shared" });
    await transitionAttempt(h.deps.admin, first.attempt.id, ["requested"], { state: "ended" });

    const second = await insertAttempt(h.deps.admin, input());
    if (!("attempt" in second)) return expect.unreachable();
    await expect(adoptLeg(h.deps.admin, second.attempt.id, "sip", { callControlId: "cc-shared" })).resolves.toBeNull();
    expect((await loadAttempt(h.deps.admin, ORG, second.attempt.id))?.telnyx_sip_call_control_id).toBeNull();
  });
});

describe("markLegGone", () => {
  it("writes the receipt cleanup uses to avoid a second hangup", async () => {
    const h = createTelephonyHarness();
    const created = await insertAttempt(h.deps.admin, input());
    if (!("attempt" in created)) return expect.unreachable();
    await markLegGone(h.deps.admin, created.attempt.id, "mobile", "normal_clearing", h.now());
    const row = await loadAttempt(h.deps.admin, ORG, created.attempt.id);
    expect(row?.mobile_hangup_cause).toBe("normal_clearing");
    expect(row?.mobile_hangup_done_at).not.toBeNull();
  });
});

describe("findPendingForIncoming", () => {
  let h: TelephonyHarness;
  let id: string;

  beforeEach(async () => {
    h = createTelephonyHarness();
    const created = await insertAttempt(h.deps.admin, input());
    id = "attempt" in created ? created.attempt.id : "";
    await transitionAttempt(h.deps.admin, id, ["requested"], { state: "sip_dialing", sip_dialed_at: h.now().toISOString() });
  });

  it("matches the single attempt inside the correlation window", async () => {
    const match = await findPendingForIncoming(h.deps.admin, ORG, { now: h.now(), sessionId: "live_new", fromHeader: null });
    expect(match).toEqual({ match: expect.objectContaining({ id }), reason: "pending_dial" });
  });

  it("matches a redelivered webhook by its recorded session id", async () => {
    await transitionAttempt(h.deps.admin, id, ["sip_dialing"], { state: "ai_offered", openai_session_id: "live_known" });
    const match = await findPendingForIncoming(h.deps.admin, ORG, { now: h.now(), sessionId: "live_known", fromHeader: null });
    expect(match).toEqual({ match: expect.objectContaining({ id }), reason: "same_session" });
  });

  it("refuses a From display name carrying somebody else's token", async () => {
    const match = await findPendingForIncoming(h.deps.admin, ORG, {
      now: h.now(),
      sessionId: "live_new",
      fromHeader: '"PM-AI-DEMO-deadbeef" <sip:+421232408774@example>',
    });
    expect(match).toEqual({ ignored: "from_mismatch" });
  });

  it("accepts a From header with no token, because header retention is unverified", async () => {
    const match = await findPendingForIncoming(h.deps.admin, ORG, { now: h.now(), sessionId: "live_new", fromHeader: "<sip:anonymous@example>" });
    expect(match).toHaveProperty("match");
  });

  it("ignores an incoming with nothing pending at all", async () => {
    await transitionAttempt(h.deps.admin, id, ["sip_dialing"], { state: "ended" });
    const match = await findPendingForIncoming(h.deps.admin, ORG, { now: h.now(), sessionId: "live_new", fromHeader: null });
    expect(match).toEqual({ ignored: "no_pending" });
  });

  it("distinguishes an expired window from nothing pending", async () => {
    h.advance(120_000);
    const match = await findPendingForIncoming(h.deps.admin, ORG, { now: h.now(), sessionId: "live_new", fromHeader: null });
    expect(match).toEqual({ ignored: "window_expired" });
  });
});

describe("findDue and countToday", () => {
  it("lists only open attempts and counts the ones started today", async () => {
    const h = createTelephonyHarness();
    const created = await insertAttempt(h.deps.admin, input());
    if (!("attempt" in created)) return expect.unreachable();

    const midnight = new Date(h.now());
    midnight.setUTCHours(0, 0, 0, 0);
    expect(await countToday(h.deps.admin, ORG, midnight)).toBe(1);
    expect(await findDue(h.deps.admin, ORG, 5)).toHaveLength(1);

    await transitionAttempt(h.deps.admin, created.attempt.id, ["requested"], { state: "failed", error_code: "dial_failed" });
    expect(await findDue(h.deps.admin, ORG, 5)).toHaveLength(0);
    // A failed attempt still counts against the daily limit; it cost money.
    expect(await countToday(h.deps.admin, ORG, midnight)).toBe(1);
  });
});

describe("claimProbe", () => {
  it("lets exactly one caller through", async () => {
    const h = createTelephonyHarness();
    const created = await insertAttempt(h.deps.admin, input());
    if (!("attempt" in created)) return expect.unreachable();

    expect(await claimProbe(h.deps.admin, created.attempt.id, h.now())).not.toBeNull();
    expect(await claimProbe(h.deps.admin, created.attempt.id, h.now())).toBeNull();
  });

  it("says so rather than throwing when there is nowhere to record the claim", async () => {
    // Before the migration lands, a caller left in silence would be much worse
    // than one greeted twice.
    const h = createTelephonyHarness();
    const created = await insertAttempt(h.deps.admin, input());
    if (!("attempt" in created)) return expect.unreachable();
    h.db.failNext("motorist_ai_demo_attempts", "update", { message: "column does not exist", code: "PGRST204", details: null, hint: null });

    await expect(claimProbe(h.deps.admin, created.attempt.id, h.now())).resolves.toBe("unclaimable");
  });
});
