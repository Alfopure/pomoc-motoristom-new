import { beforeEach, describe, expect, it } from "vitest";

import { fakeError, type FakeRow } from "@/test/fake-supabase";
import { createTelephonyHarness, LINES, NUMBERS, ORG, PROFILES, type TelephonyHarness } from "@/test/telephony-harness";

import { loadTelephonyStats, loadTelephonyStatsCached, resetTelephonyStatsCache, STATS_CACHE_TTL_MS, type TelephonyStatsDeps } from "./stats";

/**
 * The wallboard payload. Three things are worth testing here and nothing else
 * is: that the two daily numbers come out the same whether the Phase 4 views
 * answered or the raw fallback did, that a real database error is never
 * mistaken for a missing view, and that the cache is what stops a wall of
 * screens from becoming a wall of queries.
 */

const DAY = "2026-09-03";

function deps(h: TelephonyHarness): TelephonyStatsDeps {
  return { admin: h.deps.admin, organizationId: h.deps.organizationId, now: h.deps.now, logger: h.deps.logger };
}

/** Marks both statistics views as "not in the schema cache", as PostgREST does. */
function hideViews(h: TelephonyHarness): void {
  for (const view of ["motorist_call_stats_daily", "motorist_operator_status_durations"]) {
    h.db.failNext(view, "select", fakeError(`Could not find the table 'public.${view}' in the schema cache`, "PGRST205"));
  }
}

function seedCall(h: TelephonyHarness, row: FakeRow): void {
  h.db.insert("motorist_calls", {
    organization_id: ORG,
    provider: "telnyx",
    direction: "inbound",
    status: "ended",
    caller_number: NUMBERS.customer,
    line_id: LINES.allianz,
    started_at: h.now().toISOString(),
    answered_at: null,
    ended_at: h.now().toISOString(),
    end_reason: null,
    wait_seconds: null,
    duration_seconds: null,
    operator_id: null,
    ...row,
  });
}

/**
 * One shift's worth of calls: two answered fast, one answered slowly, one
 * caller who gave up, one closed after hours, one outbound.
 */
function seedShift(h: TelephonyHarness): void {
  const at = (minutesAgo: number) => new Date(h.now().getTime() - minutesAgo * 60_000).toISOString();
  seedCall(h, { started_at: at(60), answered_at: at(59.9), ended_at: at(55), duration_seconds: 294, operator_id: PROFILES.o1, status: "ended" });
  seedCall(h, { started_at: at(40), answered_at: at(39.8), ended_at: at(38), duration_seconds: 108, operator_id: PROFILES.o1, status: "ended" });
  seedCall(h, { started_at: at(30), answered_at: at(29), ended_at: at(28), duration_seconds: 60, operator_id: PROFILES.o2, status: "ended" });
  seedCall(h, { started_at: at(20), ended_at: at(19), status: "missed", end_reason: "no_answer" });
  seedCall(h, { started_at: at(10), ended_at: at(9), status: "missed", end_reason: "after_hours" });
  seedCall(h, { direction: "outbound", started_at: at(5), answered_at: at(4.9), ended_at: at(3), duration_seconds: 114, operator_id: PROFILES.o2, status: "ended" });
}

/**
 * The same shift as `motorist_call_stats_daily` would group it, written out by
 * hand. If the SQL in `20260921100000_telephony_stats_views.sql` and
 * `aggregateCallStats` ever drift apart, the "agree" test below fails on these
 * literals rather than on two implementations agreeing with each other.
 */
function seedStatsView(h: TelephonyHarness): void {
  h.db.seed("motorist_call_stats_daily", [
    {
      organization_id: ORG,
      day: DAY,
      direction: "inbound",
      operator_id: PROFILES.o1,
      calls: 2,
      answered: 2,
      unanswered: 0,
      system_handled: 0,
      abandoned: 0,
      answered_with_wait: 2,
      answered_within_20s: 2,
      answer_seconds_total: 18,
      talk_seconds: 402,
    },
    {
      organization_id: ORG,
      day: DAY,
      direction: "inbound",
      operator_id: PROFILES.o2,
      calls: 1,
      answered: 1,
      unanswered: 0,
      system_handled: 0,
      abandoned: 0,
      answered_with_wait: 1,
      answered_within_20s: 0,
      answer_seconds_total: 60,
      talk_seconds: 60,
    },
    {
      organization_id: ORG,
      day: DAY,
      direction: "inbound",
      operator_id: null,
      calls: 2,
      answered: 0,
      unanswered: 2,
      system_handled: 1,
      abandoned: 1,
      answered_with_wait: 0,
      answered_within_20s: 0,
      answer_seconds_total: 0,
      talk_seconds: 0,
    },
    {
      organization_id: ORG,
      day: DAY,
      direction: "outbound",
      operator_id: PROFILES.o2,
      calls: 1,
      answered: 1,
      unanswered: 0,
      system_handled: 0,
      abandoned: 0,
      answered_with_wait: 1,
      answered_within_20s: 1,
      answer_seconds_total: 6,
      talk_seconds: 114,
    },
  ]);
}

beforeEach(() => {
  resetTelephonyStatsCache();
});

describe("loadTelephonyStats — daily numbers", () => {
  it("reads today's totals from the statistics view", async () => {
    const h = createTelephonyHarness();
    seedStatsView(h);

    const stats = await loadTelephonyStats(deps(h));

    expect(stats.source).toBe("view");
    expect(stats.day).toBe(DAY);
    expect(stats.today).toMatchObject({
      calls: 5,
      answered: 3,
      abandoned: 1,
      systemHandled: 1,
      // 3 of 4 offered callers reached a human; the after-hours one is neither
      // answered nor abandoned.
      answerRate: 75,
      abandonRate: 25,
      // (18 + 60) / 3
      averageAnswerSeconds: 26,
      serviceLevel: 67,
      outbound: 1,
    });
  });

  it("falls back to the raw call log while the views are not applied yet", async () => {
    const h = createTelephonyHarness();
    seedShift(h);
    hideViews(h);

    const stats = await loadTelephonyStats(deps(h));

    expect(stats.source).toBe("fallback");
    expect(stats.today).toMatchObject({ calls: 5, answered: 3, abandoned: 1, systemHandled: 1, outbound: 1 });
    expect(h.logs.some((entry) => entry.scope === "stats")).toBe(true);
  });

  it("gives the same answer whichever path served it", async () => {
    const viewHarness = createTelephonyHarness();
    seedStatsView(viewHarness);
    const fromView = await loadTelephonyStats(deps(viewHarness));

    resetTelephonyStatsCache();
    const rawHarness = createTelephonyHarness();
    seedShift(rawHarness);
    hideViews(rawHarness);
    const fromRaw = await loadTelephonyStats(deps(rawHarness));

    expect(fromRaw.today).toEqual(fromView.today);
  });

  it("counts an unanswered call only once it has ended", async () => {
    const h = createTelephonyHarness();
    // Still ringing: neither answered nor abandoned, so it cannot drag the
    // abandonment rate up while the phones are still ringing.
    seedCall(h, { status: "ringing_agent", ended_at: null, end_reason: null });
    hideViews(h);

    const stats = await loadTelephonyStats(deps(h));

    expect(stats.today).toMatchObject({ calls: 1, answered: 0, unanswered: 0, abandoned: 0, answerRate: null, abandonRate: null });
  });

  it("does not mistake a real database failure for a missing view", async () => {
    const h = createTelephonyHarness();
    h.db.failNext("motorist_call_stats_daily", "select", fakeError("connection reset", "08006"));

    await expect(loadTelephonyStats(deps(h))).rejects.toThrow(/call stats load failed/);
  });
});

describe("loadTelephonyStats — live queue", () => {
  function seedSession(h: TelephonyHarness, row: FakeRow): void {
    h.db.insert("motorist_call_sessions", {
      organization_id: ORG,
      direction: "inbound",
      caller_number: NUMBERS.customer,
      called_number: NUMBERS.allianz,
      line_id: LINES.allianz,
      started_at: h.now().toISOString(),
      current_step: 0,
      metadata: {},
      ...row,
    });
  }

  it("lists waiting callers oldest first, with the line and who parked them", async () => {
    const h = createTelephonyHarness();
    const parkedAt = new Date(h.now().getTime() - 5 * 60_000).toISOString();
    const waitingSince = new Date(h.now().getTime() - 9 * 60_000).toISOString();
    seedSession(h, { state: "parked", parked_at: parkedAt, metadata: { waiting: { since: parkedAt, reason: "parked", ticks: 1 }, park: { by: PROFILES.o1, at: parkedAt } } });
    seedSession(h, { state: "waiting", metadata: { waiting: { since: waitingSince, reason: "ring_exhausted", ticks: 2 } } });
    seedSession(h, { state: "talking", answered_by_profile_id: PROFILES.o2 });
    seedSession(h, { state: "ringing" });
    seedSession(h, { state: "ended" });

    const stats = await loadTelephonyStats(deps(h));

    expect(stats.live.waiting.map((call) => call.state)).toEqual(["waiting", "parked"]);
    expect(stats.live.waiting[1]).toMatchObject({ lineLabel: "Allianz Assistance", parkedByName: "Jana Dispečerka", since: parkedAt });
    expect(stats.live.waiting[0].parkedByName).toBeNull();
    expect(stats.live).toMatchObject({ ringing: 1, talking: 1, parked: 1 });
  });
});

describe("loadTelephonyStats — operators", () => {
  it("reports each operator's state, registration and time spent today", async () => {
    const h = createTelephonyHarness();
    seedStatsView(h);
    h.db.seed("motorist_operator_status_durations", [
      { organization_id: ORG, profile_id: PROFILES.o1, day: DAY, status: "available", entries: 3, seconds: 5_400, last_started_at: h.now().toISOString(), open_since: null },
      { organization_id: ORG, profile_id: PROFILES.o1, day: DAY, status: "paused", entries: 1, seconds: 600, last_started_at: h.now().toISOString(), open_since: null },
    ]);

    const stats = await loadTelephonyStats(deps(h));
    const jana = stats.operators.find((operator) => operator.profileId === PROFILES.o1);

    expect(jana).toMatchObject({
      name: "Jana Dispečerka",
      state: "available",
      registered: true,
      answeredToday: 2,
      talkSecondsToday: 402,
      availableSecondsToday: 5_400,
      pausedSecondsToday: 600,
    });
    // The senior dispatcher never registered a browser phone in the harness.
    expect(stats.operators.find((operator) => operator.profileId === PROFILES.o3)).toMatchObject({ state: "offline", registered: false });
    expect(stats.operators.map((operator) => operator.name)).toEqual([...stats.operators.map((operator) => operator.name)].sort((a, b) => a.localeCompare(b, "sk")));
  });

  it("derives the durations from the status log when the view is missing", async () => {
    const h = createTelephonyHarness();
    h.db.insert("motorist_operator_statuses", [
      { organization_id: ORG, profile_id: PROFILES.o1, status: "available", source: "manual", started_at: new Date(h.now().getTime() - 40 * 60_000).toISOString(), ended_at: new Date(h.now().getTime() - 10 * 60_000).toISOString() },
      // Still open: it counts up to now, which is what a live wallboard needs.
      { organization_id: ORG, profile_id: PROFILES.o1, status: "paused", source: "manual", started_at: new Date(h.now().getTime() - 10 * 60_000).toISOString(), ended_at: null },
    ]);
    hideViews(h);

    const stats = await loadTelephonyStats(deps(h));

    expect(stats.operators.find((operator) => operator.profileId === PROFILES.o1)).toMatchObject({ availableSecondsToday: 1_800, pausedSecondsToday: 600 });
  });

  it("shows a pause reason by its label", async () => {
    const h = createTelephonyHarness();
    h.setPresence(PROFILES.o1, { status: "paused", pause_reason_id: "00000000-0000-4000-8000-000000002501" });

    const stats = await loadTelephonyStats(deps(h));

    expect(stats.operators.find((operator) => operator.profileId === PROFILES.o1)).toMatchObject({ state: "paused", pauseReason: "Obed" });
  });
});

describe("loadTelephonyStats — callbacks", () => {
  it("counts the open queue and the broken 30-minute promises", async () => {
    const h = createTelephonyHarness();
    const createdAt = (minutesAgo: number) => new Date(h.now().getTime() - minutesAgo * 60_000).toISOString();
    h.db.insert("motorist_callback_requests", [
      { organization_id: ORG, caller_number: NUMBERS.customer, source: "missed", status: "open", created_at: createdAt(45), due_at: createdAt(15) },
      { organization_id: ORG, caller_number: NUMBERS.customer, source: "ivr", status: "scheduled", claimed_by: PROFILES.o1, created_at: createdAt(5), due_at: new Date(h.now().getTime() + 25 * 60_000).toISOString() },
      { organization_id: ORG, caller_number: NUMBERS.customer, source: "missed", status: "done", created_at: createdAt(90), resolved_at: createdAt(80) },
    ]);

    const stats = await loadTelephonyStats(deps(h));

    expect(stats.callbacks).toMatchObject({ open: 2, unclaimed: 1, overdue: 1, oldestSince: createdAt(45) });
  });
});

describe("loadTelephonyStatsCached", () => {
  it("serves one snapshot to every reader inside the TTL and re-reads after it", async () => {
    const h = createTelephonyHarness();
    seedStatsView(h);

    const first = await loadTelephonyStatsCached(deps(h));
    h.db.log.length = 0;
    const second = await loadTelephonyStatsCached(deps(h));

    expect(second).toBe(first);
    expect(h.db.log).toHaveLength(0);

    h.advance(STATS_CACHE_TTL_MS + 1);
    const third = await loadTelephonyStatsCached(deps(h));

    expect(third).not.toBe(first);
    expect(h.db.log.length).toBeGreaterThan(0);
    expect(third.checkedAt).not.toBe(first.checkedAt);
  });
});
