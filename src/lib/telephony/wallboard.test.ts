import { describe, expect, it } from "vitest";

import {
  abandonTone,
  aggregateCallStats,
  callAnswerSeconds,
  deriveCallMetrics,
  elapsedSeconds,
  formatClock,
  longestWaitSeconds,
  serviceLevelTone,
  sumCallStats,
  toCallStatsRow,
  waitTone,
  type RawCallRow,
  type WallboardWaitingCall,
} from "./wallboard";

/**
 * The arithmetic and the colour rules behind the wallboard.
 *
 * `stats.test.ts` proves the server hands the same numbers down whichever
 * source answered; this file pins the definitions themselves, because they are
 * what a manager will read off a wall and act on. The awkward cases are the
 * point: a call still ringing, an operator who answered before the row was
 * written, a day with nothing in it.
 */

const NOW = Date.parse("2026-09-03T10:00:00.000Z");

function raw(row: Partial<RawCallRow>): RawCallRow {
  return {
    direction: "inbound",
    operator_id: null,
    started_at: "2026-09-03T09:00:00.000Z",
    answered_at: null,
    ended_at: null,
    end_reason: null,
    wait_seconds: null,
    duration_seconds: null,
    ...row,
  };
}

describe("callAnswerSeconds", () => {
  it("measures from the timestamps", () => {
    expect(callAnswerSeconds(raw({ started_at: "2026-09-03T09:00:00.000Z", answered_at: "2026-09-03T09:00:12.000Z" }))).toBe(12);
  });

  it("has no answer time for a call nobody answered", () => {
    expect(callAnswerSeconds(raw({ answered_at: null, wait_seconds: 30 }))).toBeNull();
  });

  it("falls back to the stored wait only when the timestamps cannot be trusted", () => {
    // `answered_at` before `started_at` is impossible; the stored column is the
    // only remaining evidence.
    const row = raw({ started_at: "2026-09-03T09:00:10.000Z", answered_at: "2026-09-03T09:00:00.000Z", wait_seconds: 7 });
    expect(callAnswerSeconds(row)).toBe(7);
  });

  it("treats a stored zero as no measurement rather than a perfect answer", () => {
    // `wait_seconds` is rewritten at several points in a call's life; a zero
    // left behind by an early write would otherwise pull the ASA to nothing.
    const row = raw({ started_at: "2026-09-03T09:00:10.000Z", answered_at: "2026-09-03T09:00:00.000Z", wait_seconds: 0 });
    expect(callAnswerSeconds(row)).toBeNull();
  });
});

describe("aggregateCallStats", () => {
  it("groups by direction and operator and counts each definition once", () => {
    const rows = aggregateCallStats(
      [
        raw({ answered_at: "2026-09-03T09:00:05.000Z", ended_at: "2026-09-03T09:05:00.000Z", duration_seconds: 295, operator_id: "op-1" }),
        raw({ answered_at: "2026-09-03T09:00:45.000Z", ended_at: "2026-09-03T09:02:00.000Z", duration_seconds: 75, operator_id: "op-1" }),
        raw({ ended_at: "2026-09-03T09:00:30.000Z", end_reason: "no_answer" }),
        raw({ ended_at: "2026-09-03T09:00:30.000Z", end_reason: "after_hours" }),
        raw({ direction: "outbound", answered_at: "2026-09-03T09:00:03.000Z", ended_at: "2026-09-03T09:01:00.000Z", duration_seconds: 57, operator_id: "op-2" }),
      ],
      "2026-09-03",
    );

    expect(rows).toHaveLength(3);
    const op1 = rows.find((row) => row.operatorId === "op-1");
    expect(op1).toMatchObject({ direction: "inbound", calls: 2, answered: 2, answeredWithWait: 2, answeredWithin20s: 1, answerSecondsTotal: 50, talkSeconds: 370 });
    const unassigned = rows.find((row) => row.direction === "inbound" && row.operatorId === null);
    expect(unassigned).toMatchObject({ calls: 2, unanswered: 2, abandoned: 1, systemHandled: 1 });
    expect(rows.find((row) => row.direction === "outbound")).toMatchObject({ calls: 1, answered: 1 });
  });

  it("counts a call still in progress but neither answers nor abandons it", () => {
    // A ringing phone must not raise the abandonment rate while it is still
    // ringing: the caller has not given up yet.
    const rows = aggregateCallStats([raw({ ended_at: null })], "2026-09-03");
    expect(rows[0]).toMatchObject({ calls: 1, answered: 0, unanswered: 0, abandoned: 0 });
  });

  it("skips rows that cannot be placed on a day or a direction", () => {
    expect(aggregateCallStats([raw({ started_at: null }), raw({ direction: "sideways" })], "2026-09-03")).toEqual([]);
  });
});

describe("toCallStatsRow", () => {
  it("coerces PostgREST numerics, which arrive as strings", () => {
    const row = toCallStatsRow({
      day: "2026-09-03",
      direction: "inbound",
      operator_id: null,
      calls: "5",
      answered: "3",
      unanswered: "2",
      system_handled: "1",
      abandoned: "1",
      answered_with_wait: "3",
      answered_within_20s: "2",
      answer_seconds_total: "78.5",
      talk_seconds: "402",
    });

    expect(row).toMatchObject({ calls: 5, answerSecondsTotal: 78.5, talkSeconds: 402 });
  });

  it("drops a row whose direction it does not understand", () => {
    expect(toCallStatsRow({ direction: "sideways" })).toBeNull();
  });
});

describe("deriveCallMetrics", () => {
  it("keeps a deliberately closed caller out of the abandonment rate", () => {
    const totals = sumCallStats(
      aggregateCallStats(
        [
          raw({ answered_at: "2026-09-03T09:00:05.000Z", ended_at: "2026-09-03T09:05:00.000Z", duration_seconds: 295 }),
          raw({ ended_at: "2026-09-03T09:00:30.000Z", end_reason: "no_answer" }),
          // Three callers the application served on purpose.
          raw({ ended_at: "2026-09-03T09:00:30.000Z", end_reason: "after_hours" }),
          raw({ ended_at: "2026-09-03T09:00:30.000Z", end_reason: "callback_requested" }),
          raw({ ended_at: "2026-09-03T09:00:30.000Z", end_reason: "all_busy" }),
        ],
        "2026-09-03",
      ),
    );

    const metrics = deriveCallMetrics(totals);

    expect(metrics).toMatchObject({ calls: 5, answered: 1, abandoned: 1, systemHandled: 3 });
    // 1 answered of 2 offered — not 1 of 5.
    expect(metrics.answerRate).toBe(50);
    expect(metrics.abandonRate).toBe(50);
  });

  it("says nothing rather than zero on a day with no calls", () => {
    const metrics = deriveCallMetrics(sumCallStats([]));
    expect(metrics).toMatchObject({ answerRate: null, abandonRate: null, averageAnswerSeconds: null, serviceLevel: null, averageTalkSeconds: null });
  });

  it("measures the service level against the answered calls it could time", () => {
    const totals = sumCallStats(
      aggregateCallStats(
        [
          raw({ answered_at: "2026-09-03T09:00:05.000Z", ended_at: "2026-09-03T09:05:00.000Z", duration_seconds: 295 }),
          raw({ answered_at: "2026-09-03T09:00:20.000Z", ended_at: "2026-09-03T09:05:00.000Z", duration_seconds: 280 }),
          raw({ answered_at: "2026-09-03T09:00:50.000Z", ended_at: "2026-09-03T09:05:00.000Z", duration_seconds: 250 }),
        ],
        "2026-09-03",
      ),
    );

    // Twenty seconds exactly still counts as inside the level.
    expect(deriveCallMetrics(totals)).toMatchObject({ serviceLevel: 67, averageAnswerSeconds: 25 });
  });
});

describe("presentation", () => {
  it("colours a wait by how long the caller has been holding", () => {
    expect(waitTone(0)).toBe("ok");
    expect(waitTone(19)).toBe("ok");
    expect(waitTone(20)).toBe("warn");
    expect(waitTone(60)).toBe("alert");
  });

  it("colours the service level and abandonment from the same thresholds everywhere", () => {
    expect(serviceLevelTone(null)).toBe("idle");
    expect(serviceLevelTone(80)).toBe("ok");
    expect(serviceLevelTone(60)).toBe("warn");
    expect(serviceLevelTone(59)).toBe("alert");
    expect(abandonTone(null)).toBe("idle");
    expect(abandonTone(5)).toBe("ok");
    expect(abandonTone(10)).toBe("warn");
    expect(abandonTone(11)).toBe("alert");
  });

  it("formats a clock a wall display can read from across the room", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(42)).toBe("0:42");
    expect(formatClock(725)).toBe("12:05");
    expect(formatClock(3_753)).toBe("1:02:33");
    expect(formatClock(-5)).toBe("0:00");
  });

  it("never counts a wait backwards from an unparsable or future timestamp", () => {
    expect(elapsedSeconds(null, NOW)).toBe(0);
    expect(elapsedSeconds("nonsense", NOW)).toBe(0);
    expect(elapsedSeconds("2026-09-03T10:00:30.000Z", NOW)).toBe(0);
    expect(elapsedSeconds("2026-09-03T09:59:00.000Z", NOW)).toBe(60);
  });

  it("reports the longest wait on screen, not the newest", () => {
    const waiting: WallboardWaitingCall[] = [
      { sessionId: "a", callerNumber: null, lineLabel: null, state: "waiting", since: "2026-09-03T09:58:00.000Z", parkedByName: null },
      { sessionId: "b", callerNumber: null, lineLabel: null, state: "parked", since: "2026-09-03T09:55:00.000Z", parkedByName: "Jana" },
    ];
    expect(longestWaitSeconds(waiting, NOW)).toBe(300);
    expect(longestWaitSeconds([], NOW)).toBe(0);
  });
});
