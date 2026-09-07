import { describe, expect, it } from "vitest";

import { PAUSE_ENDING_WARNING_LEAD_MS, pauseEndingSchedule, pauseEndingWindowStatus } from "./pause-ending";

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
  });
});
