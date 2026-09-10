import { describe, expect, it } from "vitest";

import { PAUSE_ENDING_WARNING_LEAD_MS, pauseEndingSchedule, pauseEndingWindowStatus, pausePlan } from "./pause-ending";

describe("pause ending schedule", () => {
  it("opens the delivery window exactly one minute before the configured end", () => {
    const schedule = pauseEndingSchedule({ status: "paused", statusSince: "2026-09-07T10:00:00.000Z", maxMinutes: 30 });
    expect(schedule).toEqual({
      pauseStartedAt: "2026-09-07T10:00:00.000Z",
      warningAt: "2026-09-07T10:29:00.000Z",
      plannedEndAt: "2026-09-07T10:30:00.000Z",
    });
    expect(Date.parse(schedule!.plannedEndAt) - Date.parse(schedule!.warningAt)).toBe(PAUSE_ENDING_WARNING_LEAD_MS);
    expect(pauseEndingWindowStatus(schedule!, new Date("2026-09-07T10:28:59.999Z"))).toBe("early");
    expect(pauseEndingWindowStatus(schedule!, new Date("2026-09-07T10:29:00.000Z"))).toBe("due");
    expect(pauseEndingWindowStatus(schedule!, new Date("2026-09-07T10:30:00.000Z"))).toBe("expired");
  });

  it.each([
    { status: "available", statusSince: "2026-09-07T10:00:00.000Z", maxMinutes: 30 },
    { status: "paused", statusSince: "invalid", maxMinutes: 30 },
    { status: "paused", statusSince: "2026-09-07T10:00:00.000Z", maxMinutes: null },
    { status: "paused", statusSince: "2026-09-07T10:00:00.000Z", maxMinutes: 0 },
  ])("does not schedule a warning without an active timed pause: %j", (input) => {
    expect(pauseEndingSchedule(input)).toBeNull();
    expect(pausePlan(input, new Date("2026-09-07T10:00:00.000Z"))).toBeNull();
  });
});

describe("pausePlan", () => {
  const input = { status: "paused", statusSince: "2026-09-07T10:00:00.000Z", maxMinutes: 2 };

  it("carries the planned end while the pause is still within its time", () => {
    expect(pausePlan(input, new Date("2026-09-07T10:01:59.999Z"))).toEqual({ plannedEndAt: "2026-09-07T10:02:00.000Z", overdue: false, overdueMinutes: 0 });
  });

  it("turns overdue at the planned end and counts whole minutes past it", () => {
    expect(pausePlan(input, new Date("2026-09-07T10:02:00.000Z"))).toMatchObject({ overdue: true, overdueMinutes: 0 });
    expect(pausePlan(input, new Date("2026-09-07T10:09:30.000Z"))).toMatchObject({ overdue: true, overdueMinutes: 7 });
  });
});
