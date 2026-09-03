import { describe, expect, it } from "vitest";

import { buildBusinessHoursSchedule, evaluateBusinessHours, isOpenAt, localDateParts, parseClock, type BusinessHoursSchedule } from "./business-hours";

const weekdays = [1, 2, 3, 4, 5];

/** Mon-Fri 07:00-12:00 and 12:30-19:00 (the seeded "Pracovný čas"). */
const schedule: BusinessHoursSchedule = {
  timezone: "Europe/Bratislava",
  intervals: weekdays.flatMap((weekday) => [
    { weekday, opens: "07:00", closes: "12:00" },
    { weekday, opens: "12:30", closes: "19:00" },
  ]),
  exceptions: [
    { date: "2026-12-24", closed: true, label: "Štedrý deň" },
    { date: "2026-12-31", closed: false, intervals: [{ opens: "08:00", closes: "12:00" }], label: "Silvester" },
    { date: "2026-05-01", closed: false, intervals: [], label: "Otvorené celý deň" },
  ],
};

const at = (iso: string) => new Date(iso);

describe("localDateParts", () => {
  it("converts UTC instants to Bratislava wall-clock time on both sides of DST", () => {
    // CET (UTC+1) in January, CEST (UTC+2) in July.
    expect(localDateParts(at("2026-01-15T06:30:00Z"))).toMatchObject({ date: "2026-01-15", weekday: 4, hour: 7, minute: 30, minutes: 450 });
    expect(localDateParts(at("2026-07-15T05:30:00Z"))).toMatchObject({ date: "2026-07-15", weekday: 3, hour: 7, minute: 30 });
    // Local midnight: 22:30Z on the 14th is already the 15th in Bratislava (summer).
    expect(localDateParts(at("2026-07-14T22:30:00Z"))).toMatchObject({ date: "2026-07-15", hour: 0, minute: 30 });
  });

  it("falls back to Europe/Bratislava for an unknown zone", () => {
    expect(localDateParts(at("2026-01-15T06:30:00Z"), "Mars/Olympus")).toMatchObject({ hour: 7 });
  });
});

describe("parseClock", () => {
  it("accepts HH:MM and HH:MM:SS", () => {
    expect(parseClock("07:00")).toBe(420);
    expect(parseClock("19:00:00")).toBe(1140);
    expect(parseClock("7:5")).toBeNull();
    expect(parseClock("25:00")).toBeNull();
    expect(parseClock(undefined)).toBeNull();
  });
});

describe("evaluateBusinessHours", () => {
  it("is open inside weekday intervals and closed in the lunch gap and after closing", () => {
    // Monday 2026-06-15, CEST (UTC+2).
    expect(isOpenAt(schedule, at("2026-06-15T05:00:00Z"))).toBe(true); // 07:00 boundary inclusive
    expect(isOpenAt(schedule, at("2026-06-15T04:59:00Z"))).toBe(false);
    expect(isOpenAt(schedule, at("2026-06-15T10:15:00Z"))).toBe(false); // 12:15 lunch gap
    expect(isOpenAt(schedule, at("2026-06-15T10:30:00Z"))).toBe(true); // 12:30
    expect(isOpenAt(schedule, at("2026-06-15T16:59:00Z"))).toBe(true); // 18:59
    expect(isOpenAt(schedule, at("2026-06-15T17:00:00Z"))).toBe(false); // 19:00 closes exclusive
    expect(evaluateBusinessHours(schedule, at("2026-06-15T17:00:00Z"))).toMatchObject({ open: false, reason: "outside" });
  });

  it("is closed at weekends", () => {
    expect(isOpenAt(schedule, at("2026-06-13T08:00:00Z"))).toBe(false); // Saturday 10:00
    expect(isOpenAt(schedule, at("2026-06-14T08:00:00Z"))).toBe(false); // Sunday
  });

  it("handles the spring DST change (29 March 2026) without shifting the opening time", () => {
    // Friday 27 March: still CET, 07:30 local = 06:30Z.
    expect(isOpenAt(schedule, at("2026-03-27T06:30:00Z"))).toBe(true);
    expect(isOpenAt(schedule, at("2026-03-27T05:30:00Z"))).toBe(false);
    // Monday 30 March: CEST, 07:30 local = 05:30Z.
    expect(isOpenAt(schedule, at("2026-03-30T05:30:00Z"))).toBe(true);
    expect(isOpenAt(schedule, at("2026-03-30T05:00:00Z"))).toBe(true);
    expect(isOpenAt(schedule, at("2026-03-30T04:59:00Z"))).toBe(false);
  });

  it("handles the autumn DST change (25 October 2026)", () => {
    // Friday 23 October: CEST → 18:59 local = 16:59Z open, 19:00 = 17:00Z closed.
    expect(isOpenAt(schedule, at("2026-10-23T16:59:00Z"))).toBe(true);
    expect(isOpenAt(schedule, at("2026-10-23T17:00:00Z"))).toBe(false);
    // Monday 26 October: CET → 18:59 local = 17:59Z open, 07:00 local = 06:00Z open.
    expect(isOpenAt(schedule, at("2026-10-26T17:59:00Z"))).toBe(true);
    expect(isOpenAt(schedule, at("2026-10-26T18:00:00Z"))).toBe(false);
    expect(isOpenAt(schedule, at("2026-10-26T06:00:00Z"))).toBe(true);
    expect(isOpenAt(schedule, at("2026-10-26T05:30:00Z"))).toBe(false);
  });

  it("applies closed exceptions and replacement intervals", () => {
    expect(evaluateBusinessHours(schedule, at("2026-12-24T09:00:00Z"))).toMatchObject({ open: false, reason: "exception_closed", exceptionLabel: "Štedrý deň" });
    // 31 December (Thursday): replacement 08:00-12:00 → 07:30 local closed, 09:00 open, 12:30 (normally open) closed.
    expect(evaluateBusinessHours(schedule, at("2026-12-31T06:30:00Z"))).toMatchObject({ open: false, reason: "exception_outside" });
    expect(evaluateBusinessHours(schedule, at("2026-12-31T08:00:00Z"))).toMatchObject({ open: true, reason: "exception_open" });
    expect(isOpenAt(schedule, at("2026-12-31T11:30:00Z"))).toBe(false);
    // An open exception without intervals keeps the whole day open (Friday 1 May 22:00 local).
    expect(isOpenAt(schedule, at("2026-05-01T20:00:00Z"))).toBe(true);
  });

  it("treats a missing schedule as always open", () => {
    expect(evaluateBusinessHours(null, at("2026-06-14T02:00:00Z"))).toEqual({ open: true, reason: "no_schedule", local: null });
  });

  it("supports split shifts across several intervals and other time zones", () => {
    const night: BusinessHoursSchedule = {
      timezone: "Europe/London",
      intervals: [
        { weekday: 1, opens: "06:00", closes: "08:00" },
        { weekday: 1, opens: "22:00", closes: "24:00" },
      ],
      exceptions: [],
    };
    // Monday 15 June, BST (UTC+1): 06:30 local = 05:30Z open; 09:00 local closed; 23:30 local = 22:30Z open.
    expect(isOpenAt(night, at("2026-06-15T05:30:00Z"))).toBe(true);
    expect(isOpenAt(night, at("2026-06-15T08:00:00Z"))).toBe(false);
    expect(isOpenAt(night, at("2026-06-15T22:30:00Z"))).toBe(true);
  });
});

describe("buildBusinessHoursSchedule", () => {
  it("maps database rows and ignores malformed exception intervals", () => {
    const built = buildBusinessHoursSchedule({
      timezone: " ",
      intervals: [
        { weekday: 1, opens: "07:00:00", closes: "12:00:00" },
        { weekday: 9, opens: "07:00", closes: "12:00" },
      ],
      exceptions: [
        { date: "2026-12-31", closed: false, intervals: [{ opens: "08:00", closes: "12:00" }, { opens: "x" }, "junk"], label: null },
        { date: "2026-12-24", closed: true, intervals: null },
      ],
    });
    expect(built.timezone).toBe("Europe/Bratislava");
    expect(built.intervals).toEqual([{ weekday: 1, opens: "07:00:00", closes: "12:00:00" }]);
    expect(built.exceptions[0].intervals).toEqual([{ opens: "08:00", closes: "12:00" }]);
    expect(built.exceptions[1]).toMatchObject({ closed: true, intervals: [] });
    expect(isOpenAt(built, at("2026-01-12T08:00:00Z"))).toBe(true); // Monday 09:00 local
  });
});
