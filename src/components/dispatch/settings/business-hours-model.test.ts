import { describe, expect, it } from "vitest";

import type { BusinessHoursDoc, LineDoc } from "@/server/telephony/config-service";

import {
  addException,
  addExceptionInterval,
  addInterval,
  addSchedule,
  businessHoursDirty,
  businessHoursPayload,
  copyDayToWeekdays,
  describeException,
  describeNow,
  describeWeek,
  evaluateDraft,
  isEmptySchedule,
  newScheduleDraft,
  overlappingWeekdays,
  removeException,
  removeInterval,
  removeSchedule,
  scheduleDraftsFromDocument,
  todayInSchedule,
  updateException,
  updateExceptionInterval,
  updateInterval,
  updateSchedule,
  validateScheduleDrafts,
  type ScheduleDraft,
} from "./business-hours-model";

function doc(overrides: Partial<BusinessHoursDoc> = {}): BusinessHoursDoc {
  return {
    id: "hours-1",
    name: "Dispečing",
    timezone: "Europe/Bratislava",
    active: true,
    // Monday with a lunch break: 07:00-12:00 and 12:30-19:00 (design §3 seed).
    intervals: [
      { weekday: 1, opens: "07:00", closes: "12:00" },
      { weekday: 1, opens: "12:30", closes: "19:00" },
      { weekday: 2, opens: "07:00", closes: "19:00" },
    ],
    exceptions: [{ date: "2026-12-24", closed: true, intervals: [], label: "Štedrý deň" }],
    ...overrides,
  };
}

function line(overrides: Partial<LineDoc> = {}): LineDoc {
  return {
    id: "line-1",
    phoneNumber: "+421222222222",
    label: "Hlavná linka",
    partnerName: null,
    telnyxNumberId: null,
    ringPlanId: null,
    ivrMenuId: null,
    businessHoursId: "hours-1",
    environment: "production",
    active: true,
    ...overrides,
  };
}

function draft(): ScheduleDraft {
  return scheduleDraftsFromDocument([doc()])[0];
}

const NO_LINES = { lines: [] as LineDoc[] };

describe("scheduleDraftsFromDocument", () => {
  it("groups intervals per weekday and keeps both intervals of a split day", () => {
    const schedule = draft();
    expect(schedule.days.get(1)).toHaveLength(2);
    expect(schedule.days.get(1)?.map((interval) => `${interval.opens}-${interval.closes}`)).toEqual(["07:00-12:00", "12:30-19:00"]);
    expect(schedule.days.get(2)).toHaveLength(1);
    expect(schedule.days.get(6)).toEqual([]);
    expect(schedule.exceptions[0]).toMatchObject({ date: "2026-12-24", closed: true, label: "Štedrý deň" });
  });

  it("falls back to Europe/Bratislava when the row has no zone", () => {
    expect(scheduleDraftsFromDocument([doc({ timezone: "" })])[0].timezone).toBe("Europe/Bratislava");
    expect(newScheduleDraft().timezone).toBe("Europe/Bratislava");
  });
});

describe("list operations", () => {
  it("adds a second interval starting where the first one ends (lunch break)", () => {
    const schedules = addInterval([newScheduleDraft("Nové")], newScheduleDraft().key, 1);
    // The freshly created draft has a different key, so nothing changed.
    expect(schedules[0].days.get(1)).toEqual([]);

    const base = [newScheduleDraft("Nové")];
    const withFirst = addInterval(base, base[0].key, 1);
    expect(withFirst[0].days.get(1)).toHaveLength(1);
    const withSecond = addInterval(withFirst, base[0].key, 1);
    const intervals = withSecond[0].days.get(1) ?? [];
    expect(intervals).toHaveLength(2);
    expect(intervals[1].opens).toBe(intervals[0].closes);
  });

  it("updates and removes an interval without touching the other days", () => {
    const schedules = [draft()];
    const key = schedules[0].days.get(1)?.[1].key ?? "";
    const updated = updateInterval(schedules, schedules[0].key, 1, key, { closes: "20:00" });
    expect(updated[0].days.get(1)?.[1].closes).toBe("20:00");
    expect(updated[0].days.get(2)).toEqual(schedules[0].days.get(2));

    const removed = removeInterval(updated, schedules[0].key, 1, key);
    expect(removed[0].days.get(1)).toHaveLength(1);
  });

  it("copies a weekday onto the requested weekdays", () => {
    const schedules = [draft()];
    const copied = copyDayToWeekdays(schedules, schedules[0].key, 1, [3, 4, 5]);
    expect(copied[0].days.get(3)?.map((interval) => interval.opens)).toEqual(["07:00", "12:30"]);
    // The source day and the untouched days keep their own rows.
    expect(copied[0].days.get(1)).toEqual(schedules[0].days.get(1));
    expect(copied[0].days.get(6)).toEqual([]);
  });

  it("adds, edits and removes exceptions and gives an open exception an interval", () => {
    const schedules = [draft()];
    const withException = addException(schedules, schedules[0].key, "2026-01-01");
    expect(withException[0].exceptions).toHaveLength(2);
    const key = withException[0].exceptions[1].key;

    const opened = updateException(withException, schedules[0].key, key, { closed: false, label: "Nový rok" });
    expect(opened[0].exceptions[1].intervals).toHaveLength(1);

    const retimed = updateExceptionInterval(opened, schedules[0].key, key, opened[0].exceptions[1].intervals[0].key, { opens: "09:00", closes: "13:00" });
    expect(retimed[0].exceptions[1].intervals[0]).toMatchObject({ opens: "09:00", closes: "13:00" });

    const twoIntervals = addExceptionInterval(retimed, schedules[0].key, key);
    expect(twoIntervals[0].exceptions[1].intervals).toHaveLength(2);

    expect(removeException(twoIntervals, schedules[0].key, key)[0].exceptions).toHaveLength(1);
  });

  it("adds and removes whole schedules", () => {
    const schedules = addSchedule([draft()]);
    expect(schedules).toHaveLength(2);
    expect(removeSchedule(schedules, schedules[1].key)).toHaveLength(1);
    expect(updateSchedule(schedules, schedules[0].key, { active: false })[0].active).toBe(false);
  });
});

describe("businessHoursPayload", () => {
  it("flattens the weekday map back into interval rows and drops intervals of a closed exception", () => {
    const schedules = [draft()];
    const payload = businessHoursPayload(schedules);
    expect(payload).toHaveLength(1);
    expect(payload[0].intervals).toEqual([
      { weekday: 1, opens: "07:00", closes: "12:00" },
      { weekday: 1, opens: "12:30", closes: "19:00" },
      { weekday: 2, opens: "07:00", closes: "19:00" },
    ]);
    expect(payload[0].exceptions).toEqual([{ date: "2026-12-24", closed: true, label: "Štedrý deň", intervals: [] }]);
  });

  it("keeps the intervals of an open exception", () => {
    const schedules = [draft()];
    const key = schedules[0].exceptions[0].key;
    const opened = updateException(schedules, schedules[0].key, key, { closed: false });
    const payload = businessHoursPayload(opened);
    expect(payload[0].exceptions[0].closed).toBe(false);
    expect(payload[0].exceptions[0].intervals).toHaveLength(1);
  });

  it("reports dirty only after a real change", () => {
    const original = [doc()];
    const schedules = scheduleDraftsFromDocument(original);
    expect(businessHoursDirty(schedules, original)).toBe(false);
    const changed = updateInterval(schedules, schedules[0].key, 2, schedules[0].days.get(2)?.[0].key ?? "", { closes: "18:00" });
    expect(businessHoursDirty(changed, original)).toBe(true);
  });
});

describe("validateScheduleDrafts", () => {
  it("accepts the seeded schedule", () => {
    expect(validateScheduleDrafts([draft()], { lines: [line()] })).toEqual([]);
  });

  it("requires a name and rejects duplicates", () => {
    const first = newScheduleDraft("");
    const second = newScheduleDraft("Dispečing");
    const third = newScheduleDraft("dispečing");
    const issues = validateScheduleDrafts([first, second, third], NO_LINES);
    expect(issues.map((entry) => entry.code)).toEqual(["name_required", "duplicate_name"]);
  });

  it("rejects a malformed or inverted interval", () => {
    const schedules = [draft()];
    const key = schedules[0].days.get(2)?.[0].key ?? "";
    const bad = updateInterval(schedules, schedules[0].key, 2, key, { closes: "6:0" });
    expect(validateScheduleDrafts(bad, NO_LINES).map((entry) => entry.code)).toEqual(["time_invalid"]);

    const inverted = updateInterval(schedules, schedules[0].key, 2, key, { closes: "06:00" });
    const issues = validateScheduleDrafts(inverted, NO_LINES);
    expect(issues[0]).toMatchObject({ path: key, code: "time_order" });
    expect(issues[0].message).toContain("Utorok");
  });

  it("rejects a malformed and a duplicated exception date", () => {
    const schedules = [draft()];
    const bad = updateException(schedules, schedules[0].key, schedules[0].exceptions[0].key, { date: "24.12.2026" });
    expect(validateScheduleDrafts(bad, NO_LINES).map((entry) => entry.code)).toEqual(["date_invalid"]);

    const twice = addException(schedules, schedules[0].key, "2026-12-24");
    expect(validateScheduleDrafts(twice, NO_LINES).map((entry) => entry.code)).toEqual(["duplicate_date"]);
  });

  it("requires an interval on an open exception", () => {
    const schedules = [draft()];
    const key = schedules[0].exceptions[0].key;
    const opened = updateException(schedules, schedules[0].key, key, { closed: false });
    const emptied = removeException(opened, schedules[0].key, key);
    expect(validateScheduleDrafts(emptied, NO_LINES)).toEqual([]);

    const withoutInterval: ScheduleDraft[] = [
      { ...opened[0], exceptions: opened[0].exceptions.map((exception) => ({ ...exception, intervals: [] })) },
    ];
    expect(validateScheduleDrafts(withoutInterval, NO_LINES).map((entry) => entry.code)).toEqual(["exception_intervals_required"]);
  });

  it("refuses to delete a schedule a line still points at", () => {
    const issues = validateScheduleDrafts([], { lines: [line()] });
    expect(issues[0]).toMatchObject({ path: "", code: "business_hours_in_use" });
    expect(issues[0].message).toContain("Hlavná linka");
    expect(validateScheduleDrafts([], { lines: [line({ businessHoursId: null })] })).toEqual([]);
  });
});

describe("overlappingWeekdays", () => {
  it("finds a day whose intervals overlap and ignores a clean split shift", () => {
    const schedules = [draft()];
    expect(overlappingWeekdays(schedules[0])).toEqual([]);
    const overlapping = updateInterval(schedules, schedules[0].key, 1, schedules[0].days.get(1)?.[1].key ?? "", { opens: "11:00" });
    expect(overlappingWeekdays(overlapping[0])).toEqual([1]);
  });
});

describe("preview", () => {
  // Monday 7 September 2026, 08:00 Bratislava = 06:00 UTC (summer time).
  const mondayMorning = new Date("2026-09-07T06:00:00Z");

  it("is open in the morning, closed in the lunch gap and after closing", () => {
    const schedule = draft();
    expect(evaluateDraft(schedule, mondayMorning).open).toBe(true);
    expect(evaluateDraft(schedule, new Date("2026-09-07T10:15:00Z")).open).toBe(false); // 12:15 local
    expect(evaluateDraft(schedule, new Date("2026-09-07T11:00:00Z")).open).toBe(true); // 13:00 local
    expect(evaluateDraft(schedule, new Date("2026-09-07T18:00:00Z")).open).toBe(false); // 20:00 local
  });

  it("closes the whole day on a dated exception", () => {
    const schedule = draft();
    // 24 December 2026 is a Thursday; the schedule has no Thursday interval
    // anyway, so the exception is checked on a day that would otherwise open.
    const withMonday = { ...schedule, exceptions: [{ ...schedule.exceptions[0], date: "2026-09-07" }] };
    const decision = evaluateDraft(withMonday, mondayMorning);
    expect(decision).toMatchObject({ open: false, reason: "exception_closed", exceptionLabel: "Štedrý deň" });
    expect(describeNow(withMonday, mondayMorning)).toContain("Štedrý deň");
  });

  it("keeps the wall-clock opening time across both DST boundaries", () => {
    const schedule = draft();
    // Sunday 29 March 2026 is the spring change; the following Monday opens at
    // 07:00 local = 05:00 UTC (CEST), not 06:00 UTC as the week before.
    const springMonday = { ...schedule, exceptions: [] };
    expect(evaluateDraft(springMonday, new Date("2026-03-30T04:59:00Z")).open).toBe(false);
    expect(evaluateDraft(springMonday, new Date("2026-03-30T05:00:00Z")).open).toBe(true);
    // Sunday 25 October 2026 is the autumn change; Monday opens at 07:00 CET =
    // 06:00 UTC again.
    expect(evaluateDraft(springMonday, new Date("2026-10-26T05:59:00Z")).open).toBe(false);
    expect(evaluateDraft(springMonday, new Date("2026-10-26T06:00:00Z")).open).toBe(true);
  });

  it("describes the week, the current state and one exception in Slovak", () => {
    const schedule = draft();
    const week = describeWeek(schedule);
    expect(week[0]).toMatchObject({ label: "Pondelok", text: "07:00 – 12:00, 12:30 – 19:00", open: true });
    expect(week[5]).toMatchObject({ label: "Sobota", text: "Zatvorené", open: false });
    expect(describeNow(schedule, mondayMorning)).toBe("Teraz otvorené (08:00, Europe/Bratislava).");
    expect(describeNow(schedule, new Date("2026-09-07T10:15:00Z"))).toContain("mimo otváracích hodín");
    expect(describeNow(newScheduleDraft("Prázdny"), mondayMorning)).toContain("zatvorená každý deň");
    expect(describeException(schedule.exceptions[0])).toBe("Zatvorené celý deň");
    expect(isEmptySchedule(schedule)).toBe(false);
    expect(isEmptySchedule(newScheduleDraft("Prázdny"))).toBe(true);
  });

  it("describes an open exception with its intervals", () => {
    const schedules = [draft()];
    const key = schedules[0].exceptions[0].key;
    const opened = updateException(schedules, schedules[0].key, key, { closed: false });
    const retimed = updateExceptionInterval(opened, schedules[0].key, key, opened[0].exceptions[0].intervals[0].key, { opens: "09:00", closes: "12:00" });
    expect(describeException(retimed[0].exceptions[0])).toBe("Otvorené 09:00 – 12:00");
    expect(describeNow(retimed[0], new Date("2026-12-24T09:00:00Z"))).toContain("otvorené podľa výnimky");
  });

  it("uses the schedule zone for the default exception date", () => {
    const schedule = draft();
    // 23:30 UTC on 6 September is already 7 September in Bratislava.
    expect(todayInSchedule(schedule, new Date("2026-09-06T23:30:00Z"))).toBe("2026-09-07");
  });
});
