import { describe, expect, it } from "vitest";
import { dueDateInput, taskRecurrenceIssue, taskDayKey, taskDueLabel, customDueDate, duePreset, taskOverdue, taskRecipientLabel } from "./presentation";

describe("simple task dates and ownership", () => {
  it("uses local end of day for the easy day presets", () => {
    const now = new Date(2026, 10, 6, 8, 30), tomorrow = new Date(duePreset(1, now));
    expect([tomorrow.getDate(), tomorrow.getMonth(), tomorrow.getHours(), tomorrow.getMinutes()]).toEqual([7, 10, 23, 59]);
  });
  it("rejects impossible dates instead of silently rolling them into another month", () => {
    expect(() => customDueDate("31. 2. 2026", "17:00")).toThrow();
    expect(() => customDueDate("18. 11. 2026", "25:00")).toThrow();
    const parsed = new Date(customDueDate("18. 11. 2026", "17:30"));
    expect([parsed.getDate(), parsed.getMonth(), parsed.getHours(), parsed.getMinutes()]).toEqual([18, 10, 17, 30]);
  });
  it("never labels a completed task overdue", () => {
    expect(taskOverdue({ state: "done", dueAt: "2026-01-01T00:00:00Z" })).toBe(false);
    expect(taskOverdue({ state: "todo", dueAt: "2026-01-01T00:00:00Z" }, Date.parse("2026-11-06T12:00:00Z"))).toBe(true);
  });
  it("keeps branch responsibility visible after delegation", () => {
    expect(taskRecipientLabel({ assignee: null, group: { id: "group", name: "Žilina" } })).toBe("Žilina · Čaká na pridelenie");
    expect(taskRecipientLabel({ assignee: { userId: "person", displayName: "Martin" }, group: { id: "group", name: "Žilina" } })).toBe("Martin · Žilina");
  });
});


it("uses organization days and clock labels across midnight and DST", () => {
  const now = new Date("2026-03-28T23:30:00Z");
  expect(taskDayKey(now, "Europe/Bratislava")).toBe("2026-03-29");
  expect(taskDueLabel("2026-03-29T01:30:00Z", now, "Europe/Bratislava")).toContain("Dnes");
  expect(taskDueLabel("2026-03-29T01:30:00Z", now, "Europe/Bratislava")).toContain("03:30");
  expect(taskDueLabel("2026-03-29T22:30:00Z", now, "Europe/Bratislava")).toContain("Zajtra");
});


it("explains inactive series without suggesting futile one-tap resume", () => {
  const series = { id: "00000000-0000-4000-8000-000000000003", revision: 1, frequency: "daily" as const, time: "09:00", weekday: null, timeZone: "Europe/Bratislava", state: "needs_attention" as const };
  expect(taskRecurrenceIssue({ ...series, issue: "creator_inactive" })).toContain("Autor série");
  expect(taskRecurrenceIssue({ ...series, issue: "recipient_unavailable" })).toContain("Príjemca série");
  expect(taskRecurrenceIssue({ ...series, state: "paused" })).toBeNull();
});


describe("organization timezone deadline input", () => {
  const zone = "Europe/Bratislava";
  it("keeps Today end-of-day inside the organization's day even on a UTC device", () => {
    const now = new Date("2026-11-06T12:00:00Z");
    expect(duePreset(0, now, zone)).toBe("2026-11-06T22:59:00.000Z");
    expect(duePreset(1, now, zone)).toBe("2026-11-07T22:59:00.000Z");
    expect(duePreset(7, now, zone)).toBe("2026-11-13T22:59:00.000Z");
    expect(taskDayKey(new Date(duePreset(0, now, zone)), zone)).toBe(taskDayKey(now, zone));
    expect(taskDueLabel(duePreset(0, now, zone), now, zone)).toContain("23:59");
  });
  it("anchors calendar shortcuts to the organization after UTC midnight boundaries and year rollover", () => {
    expect(duePreset(0, new Date("2026-07-14T22:30:00Z"), zone)).toBe("2026-07-15T21:59:00.000Z");
    expect(duePreset(1, new Date("2026-07-14T22:30:00Z"), zone)).toBe("2026-07-16T21:59:00.000Z");
    expect(duePreset(0, new Date("2026-12-31T23:30:00Z"), zone)).toBe("2027-01-01T22:59:00.000Z");
  });
  it("adds calendar days across 23-hour and 25-hour DST days", () => {
    const spring = new Date("2026-03-28T22:30:00Z"), fall = new Date("2026-10-24T21:30:00Z");
    expect(duePreset(1, spring, zone)).toBe("2026-03-29T21:59:00.000Z");
    expect(Date.parse(duePreset(1, spring, zone)) - Date.parse(duePreset(0, spring, zone))).toBe(23 * 3_600_000);
    expect(duePreset(1, fall, zone)).toBe("2026-10-25T22:59:00.000Z");
    expect(Date.parse(duePreset(1, fall, zone)) - Date.parse(duePreset(0, fall, zone))).toBe(25 * 3_600_000);
  });
  it("initializes the date and clock using the organization rather than the device", () => {
    const instant = new Date("2026-11-06T23:30:00Z");
    expect(dueDateInput(instant, "UTC")).toEqual({ date: "6. 11. 2026", time: "23:30" });
    expect(dueDateInput(instant, zone)).toEqual({ date: "7. 11. 2026", time: "00:30" });
    expect(customDueDate("7. 11. 2026", "00:30", zone)).toBe("2026-11-06T23:30:00.000Z");
    expect(customDueDate("7. 7. 2026", "00:30", zone)).toBe("2026-07-06T22:30:00.000Z");
  });
  it("rejects a missing spring clock time and impossible calendar dates", () => {
    expect(() => customDueDate("29. 3. 2026", "02:30", zone)).toThrow(/neexistuje/);
    expect(customDueDate("29. 3. 2026", "03:30", zone)).toBe("2026-03-29T01:30:00.000Z");
    expect(() => customDueDate("29. 2. 2026", "09:00", zone)).toThrow();
    expect(() => customDueDate("6. 11. 2026", "24:00", zone)).toThrow();
  });
  it("selects the earlier instant consistently in an autumn clock overlap", () => {
    expect(customDueDate("25. 10. 2026", "02:30", zone)).toBe("2026-10-25T00:30:00.000Z");
    expect(customDueDate("25. 10. 2026", "02:30", zone)).toBe(customDueDate("25. 10. 2026", "02:30", zone));
  });
  it("supports fractional-hour zones without assuming a whole-hour offset", () => {
    expect(customDueDate("6. 11. 2026", "08:00", "Asia/Kathmandu")).toBe("2026-11-06T02:15:00.000Z");
    expect(() => customDueDate("4. 10. 2026", "02:15", "Australia/Lord_Howe")).toThrow(/neexistuje/);
    expect(customDueDate("4. 10. 2026", "03:00", "Australia/Lord_Howe")).toBe("2026-10-03T16:00:00.000Z");
  });
});
