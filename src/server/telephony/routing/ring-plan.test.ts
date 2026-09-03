import { describe, expect, it } from "vitest";

import { createTelephonyHarness, GROUPS, NUMBERS, ORG, PLAN_ID, PROFILES } from "@/test/telephony-harness";

import type { FrozenRingStep } from "../state/types";
import {
  advanceRingStep,
  clampRingSecs,
  findOverdueSessions,
  isRingStepOverdue,
  isWaitingTickStale,
  materialiseRingPlan,
  memberKey,
  planRingStep,
  stepDeadline,
  closeOrphanLegs,
  closeStaleRingAttempts,
  sweepOverdueRingSteps,
} from "./ring-plan";

const NOW = new Date("2026-09-03T08:00:00.000Z");
const seen = new Date(NOW.getTime() - 10_000).toISOString();

const presence = [
  { profileId: PROFILES.o1, status: "available" as const },
  { profileId: PROFILES.o2, status: "available" as const },
  { profileId: PROFILES.o3, status: "offline" as const },
  { profileId: PROFILES.o4, status: "paused" as const },
  { profileId: PROFILES.o5, status: "available" as const },
];
const devices = [PROFILES.o1, PROFILES.o2, PROFILES.o5].map((profileId, index) => ({ profileId, sipUsername: `gencred00${index + 1}`, deviceSeenAt: seen, registrationState: "registered" }));

const stepAll: FrozenRingStep = {
  index: 0,
  groupId: GROUPS.a,
  groupName: "A",
  strategy: "all",
  timeoutSecs: 20,
  members: [
    { kind: "operator", profileId: PROFILES.o1, externalNumber: null, position: 0, ringSecs: 20, memberId: "m1" },
    { kind: "operator", profileId: PROFILES.o2, externalNumber: null, position: 1, ringSecs: 20, memberId: "m2" },
    { kind: "operator", profileId: PROFILES.o5, externalNumber: null, position: 2, ringSecs: 20, memberId: "m5" },
    { kind: "operator", profileId: PROFILES.o3, externalNumber: null, position: 3, ringSecs: 20, memberId: "m3" },
  ],
};
const stepOrdered: FrozenRingStep = {
  index: 1,
  groupId: GROUPS.b,
  groupName: "B",
  strategy: "ordered",
  timeoutSecs: 15,
  members: [
    { kind: "operator", profileId: PROFILES.o4, externalNumber: null, position: 0, ringSecs: 15, memberId: "m4" },
    { kind: "operator", profileId: PROFILES.o2, externalNumber: null, position: 1, ringSecs: 7, memberId: "m2b" },
    { kind: "external_number", profileId: null, externalNumber: NUMBERS.external, position: 2, ringSecs: 15, memberId: "mx" },
  ],
};

function input(overrides: Partial<Parameters<typeof planRingStep>[1]> = {}) {
  return { sessionId: "s1", now: NOW, presence, devices, openOffers: [], attempted: new Set<string>(), ...overrides };
}

describe("materialiseRingPlan", () => {
  it("freezes plan, steps, groups and members with resolved ring times", async () => {
    const h = createTelephonyHarness();
    const plan = await materialiseRingPlan(h.admin, { organizationId: ORG, ringPlanId: PLAN_ID, now: NOW });
    expect(plan).toMatchObject({ planId: PLAN_ID, name: "Denný", fallback: { kind: "callback_prompt", number: null }, frozenAt: NOW.toISOString() });
    expect(plan?.steps.map((step) => [step.index, step.strategy, step.timeoutSecs, step.members.length])).toEqual([
      [0, "all", 20, 3],
      [1, "ordered", 15, 3],
    ]);
    expect(plan?.steps[0].members.map((member) => member.ringSecs)).toEqual([20, 20, 20]);
    expect(plan?.steps[1].members.map((member) => [member.kind, member.profileId ?? member.externalNumber, member.ringSecs])).toEqual([
      ["operator", PROFILES.o4, 15],
      ["operator", PROFILES.o3, 15],
      ["external_number", NUMBERS.external, 15],
    ]);
  });

  it("returns null for an inactive or unknown plan and skips inactive groups", async () => {
    const h = createTelephonyHarness();
    expect(await materialiseRingPlan(h.admin, { organizationId: ORG, ringPlanId: "00000000-0000-4000-8000-00000000dead" })).toBeNull();
    h.db.update("motorist_ring_groups", { active: false }, (row) => row.id === GROUPS.b);
    const plan = await materialiseRingPlan(h.admin, { organizationId: ORG, ringPlanId: PLAN_ID });
    expect(plan?.steps).toHaveLength(1);
    h.db.update("motorist_ring_plans", { active: false }, (row) => row.id === PLAN_ID);
    expect(await materialiseRingPlan(h.admin, { organizationId: ORG, ringPlanId: PLAN_ID })).toBeNull();
  });
});

describe("planRingStep", () => {
  it("dials every eligible member of an 'all' step and skips offline/paused ones", () => {
    const planned = planRingStep(stepAll, input());
    expect(planned.attempts.map((attempt) => attempt.profileId)).toEqual([PROFILES.o1, PROFILES.o2, PROFILES.o5]);
    expect(planned.attempts.every((attempt) => attempt.ringSecs === 20 && attempt.stepIndex === 0 && attempt.ringGroupId === GROUPS.a)).toBe(true);
    expect(planned.skipped).toEqual([{ member: stepAll.members[3], reason: "offline" }]);
    expect(planned.ringSecs).toBe(20);
    expect(planned.exhaustedAfter).toBe(true);
  });

  it("honours the fan-out cap and the concurrent-leg capacity", () => {
    const capped = planRingStep(stepAll, input({ maxFanout: 2 }));
    expect(capped.attempts.map((attempt) => attempt.profileId)).toEqual([PROFILES.o1, PROFILES.o2]);
    expect(capped.skipped.map((skip) => skip.reason)).toContain("fanout");

    const limited = planRingStep(stepAll, input({ maxConcurrentLegs: 9, activeLegCount: 8 }));
    expect(limited.attempts).toHaveLength(1);
    expect(limited.capacityLimited).toBe(true);
    expect(limited.skipped.filter((skip) => skip.reason === "capacity")).toHaveLength(2);

    const none = planRingStep(stepAll, input({ maxConcurrentLegs: 9, activeLegCount: 9 }));
    expect(none.attempts).toHaveLength(0);
  });

  it("rings one member at a time in position order for an 'ordered' step with its own ring time", () => {
    const first = planRingStep(stepOrdered, input());
    // o4 is paused → o2 is next, for its own 7 s.
    expect(first.attempts).toEqual([expect.objectContaining({ profileId: PROFILES.o2, ringSecs: 7, position: 1 })]);
    expect(first.ringSecs).toBe(7);
    expect(first.exhaustedAfter).toBe(false);

    const second = planRingStep(stepOrdered, input({ attempted: new Set([memberKey({ profileId: PROFILES.o2, externalNumber: null })]) }));
    expect(second.attempts).toEqual([expect.objectContaining({ externalNumber: NUMBERS.external, memberKind: "external_number", ringSecs: 15 })]);
    expect(second.exhaustedAfter).toBe(true);

    const third = planRingStep(stepOrdered, input({ attempted: new Set([memberKey({ profileId: PROFILES.o2, externalNumber: null }), memberKey({ profileId: null, externalNumber: NUMBERS.external })]) }));
    expect(third.attempts).toHaveLength(0);
  });

  it("always includes external numbers even when every operator is unreachable", () => {
    const planned = planRingStep(stepOrdered, input({ presence: [], devices: [] }));
    expect(planned.attempts.map((attempt) => attempt.externalNumber)).toEqual([NUMBERS.external]);
  });

  it("skips operators offered elsewhere and stale devices", () => {
    const planned = planRingStep(stepAll, input({ openOffers: [PROFILES.o1], devices: devices.map((device) => (device.profileId === PROFILES.o2 ? { ...device, deviceSeenAt: new Date(NOW.getTime() - 200_000).toISOString() } : device)) }));
    expect(planned.attempts.map((attempt) => attempt.profileId)).toEqual([PROFILES.o5]);
    expect(planned.skipped.map((skip) => skip.reason).sort()).toEqual(["device_stale", "offline", "open_offer"]);
  });
});

describe("ring timing helpers", () => {
  it("clamps member ring seconds to 5-120 with the step timeout as default", () => {
    expect(clampRingSecs(3, 20)).toBe(5);
    expect(clampRingSecs(null, 20)).toBe(20);
    expect(clampRingSecs(500, 20)).toBe(120);
    expect(clampRingSecs(undefined, 2)).toBe(5);
  });

  it("adds the grace period to the step deadline", () => {
    expect(stepDeadline(NOW, 20)).toBe(new Date(NOW.getTime() + 25_000).toISOString());
    expect(stepDeadline(NOW, 20, 0)).toBe(new Date(NOW.getTime() + 20_000).toISOString());
  });

  it("detects overdue ring steps and stale waiting ticks", () => {
    const base = { id: "s", state: "ringing", metadata: { ring: { step_deadline_at: new Date(NOW.getTime() - 1).toISOString() } }, updated_at: NOW.toISOString(), parked_at: null } as never;
    expect(isRingStepOverdue(base, NOW)).toBe(true);
    expect(isRingStepOverdue({ ...(base as object), state: "talking" } as never, NOW)).toBe(false);
    const waiting = { id: "w", state: "waiting", metadata: { waiting: { last_tick_at: new Date(NOW.getTime() - 121_000).toISOString() } }, updated_at: NOW.toISOString(), parked_at: null } as never;
    expect(isWaitingTickStale(waiting, NOW)).toBe(true);
    expect(isWaitingTickStale({ ...(waiting as object), metadata: { waiting: { last_tick_at: NOW.toISOString() } } } as never, NOW)).toBe(false);
  });
});

describe("advanceRingStep and sweep", () => {
  it("only the first compare-and-set wins", async () => {
    const h = createTelephonyHarness();
    const [session] = h.db.seed("motorist_call_sessions", [{ organization_id: ORG, direction: "inbound", state: "ringing", current_step: 0 }]);
    expect(await advanceRingStep(h.admin, String(session.id), 0)).toBe(true);
    expect(await advanceRingStep(h.admin, String(session.id), 0)).toBe(false);
    expect(h.session(String(session.id)).current_step).toBe(1);
  });

  it("finds overdue sessions and runs the sweep event for each, collecting errors", async () => {
    const h = createTelephonyHarness();
    const overdue = new Date(h.now().getTime() - 1_000).toISOString();
    const fresh = new Date(h.now().getTime() + 60_000).toISOString();
    const [a, , c, d] = h.db.seed("motorist_call_sessions", [
      { organization_id: ORG, direction: "inbound", state: "ringing", metadata: { ring: { step_deadline_at: overdue } } },
      { organization_id: ORG, direction: "inbound", state: "ringing", metadata: { ring: { step_deadline_at: fresh } } },
      { organization_id: ORG, direction: "inbound", state: "waiting", metadata: { waiting: { since: new Date(h.now().getTime() - 200_000).toISOString(), last_tick_at: new Date(h.now().getTime() - 130_000).toISOString() } } },
      { organization_id: ORG, direction: "inbound", state: "wrap_up", updated_at: new Date(h.now().getTime() - 200_000).toISOString() },
    ]);
    const found = await findOverdueSessions(h.admin, { organizationId: ORG, now: h.now() });
    expect(found.ringing.map((row) => row.id)).toEqual([a.id]);
    expect(found.waiting.map((row) => row.id)).toEqual([c.id]);
    expect(found.stale.map((row) => row.id)).toEqual([d.id]);

    const ran: string[] = [];
    const result = await sweepOverdueRingSteps({
      admin: h.admin,
      organizationId: ORG,
      now: () => h.now(),
      runSessionEvent: async (sessionId, event) => {
        expect(event).toMatchObject({ kind: "app", type: "sweep" });
        ran.push(sessionId);
        if (sessionId === c.id) throw new Error("boom");
        return null;
      },
    });
    expect(ran).toEqual([a.id, c.id, d.id]);
    expect(result).toMatchObject({ checked: 3, swept: [a.id, d.id], deferred: [], errors: [{ sessionId: c.id, error: "boom" }] });
  });

  it("defers targets beyond the inline limit and the time budget", async () => {
    const h = createTelephonyHarness();
    const overdue = new Date(h.now().getTime() - 1_000).toISOString();
    const seeded = h.db.seed(
      "motorist_call_sessions",
      [0, 1, 2].map(() => ({ organization_id: ORG, direction: "inbound" as const, state: "ringing", metadata: { ring: { step_deadline_at: overdue } } })),
    );

    const ran: string[] = [];
    const limited = await sweepOverdueRingSteps({
      admin: h.admin,
      organizationId: ORG,
      now: () => h.now(),
      limit: 2,
      runSessionEvent: async (sessionId) => void ran.push(sessionId),
    });
    expect(ran).toHaveLength(2);
    expect(limited).toMatchObject({ checked: 3, deferred: [String(seeded[2].id)] });

    // The budget stops the pass before the second session even starts.
    let clock = 0;
    const budgeted = await sweepOverdueRingSteps({
      admin: h.admin,
      organizationId: ORG,
      now: () => h.now(),
      budgetMs: 100,
      clock: () => clock,
      runSessionEvent: async () => {
        clock += 200;
      },
    });
    expect(budgeted.swept).toHaveLength(1);
    expect(budgeted.deferred).toHaveLength(2);
  });

  it("closes legs whose session is terminal or that are older than the orphan window", async () => {
    const h = createTelephonyHarness();
    const [live, dead] = h.db.seed("motorist_call_sessions", [
      { organization_id: ORG, direction: "inbound", state: "talking" },
      { organization_id: ORG, direction: "inbound", state: "failed" },
    ]);
    const [fresh, orphanBySession, orphanByAge] = h.db.seed("motorist_call_legs", [
      { organization_id: ORG, session_id: live.id, telnyx_call_control_id: "cc-fresh", role: "customer", state: "answered", initiated_at: h.now().toISOString() },
      { organization_id: ORG, session_id: dead.id, telnyx_call_control_id: "cc-dead", role: "operator", state: "ringing", initiated_at: h.now().toISOString() },
      { organization_id: ORG, session_id: live.id, telnyx_call_control_id: "cc-old", role: "operator", state: "ringing", initiated_at: new Date(h.now().getTime() - 5 * 60 * 60 * 1000).toISOString() },
    ]);

    const closed = await closeOrphanLegs(h.admin, { organizationId: ORG, now: h.now() });

    expect(closed.sort()).toEqual([String(orphanBySession.id), String(orphanByAge.id)].sort());
    expect(h.db.find("motorist_call_legs", (row) => row.id === fresh.id)).toMatchObject({ ended_at: null });
    expect(h.db.find("motorist_call_legs", (row) => row.id === orphanBySession.id)).toMatchObject({ state: "ended", hangup_cause: "orphan_sweep" });
  });

  it("terminalises leaked open ring offers so their operator can be rung again", async () => {
    const h = createTelephonyHarness();
    const [live, dead] = h.db.seed("motorist_call_sessions", [
      { organization_id: ORG, direction: "inbound", state: "ringing" },
      { organization_id: ORG, direction: "inbound", state: "missed" },
    ]);
    const [fresh, leakedBySession, leakedByAge] = h.db.seed("motorist_ring_attempts", [
      { organization_id: ORG, session_id: live.id, step_index: 0, member_kind: "operator", profile_id: PROFILES.o1, result: "offered", offered_at: h.now().toISOString() },
      { organization_id: ORG, session_id: dead.id, step_index: 0, member_kind: "operator", profile_id: PROFILES.o2, result: "offered", offered_at: h.now().toISOString() },
      { organization_id: ORG, session_id: live.id, step_index: 1, member_kind: "operator", profile_id: PROFILES.o3, result: "offered", offered_at: new Date(h.now().getTime() - 10 * 60_000).toISOString() },
    ]);

    const closed = await closeStaleRingAttempts(h.admin, { organizationId: ORG, now: h.now() });

    expect(closed.sort()).toEqual([String(leakedBySession.id), String(leakedByAge.id)].sort());
    expect(h.db.find("motorist_ring_attempts", (row) => row.id === fresh.id)).toMatchObject({ result: "offered" });
    expect(h.db.find("motorist_ring_attempts", (row) => row.id === leakedByAge.id)).toMatchObject({ result: "failed", ended_at: h.now().toISOString() });
  });
});
