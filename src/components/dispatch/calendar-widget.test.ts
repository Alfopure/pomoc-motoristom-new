import { describe, expect, it } from "vitest";
import type { WorkspaceTask } from "@/domain/task-workspace";
import { calendarDayKey, calendarMonthDays, calendarTasksByDay } from "./calendar-widget";

const task = (id: string, dueAt: string, status: WorkspaceTask["status"] = "open") => ({ id, title: id, dueAt, status }) as WorkspaceTask;

describe("calendar view of existing task deadlines", () => {
  it("starts each month on Monday, ends on Sunday and includes a leap day once", () => {
    const days = calendarMonthDays(new Date(2028, 1, 9));
    expect(days[0].getDay()).toBe(1);
    expect(days.at(-1)!.getDay()).toBe(0);
    expect(days.length % 7).toBe(0);
    expect(days.filter(day => day.getMonth() === 1)).toHaveLength(29);
    expect(new Set(days.map(calendarDayKey)).size).toBe(days.length);
    expect(days.filter(day => calendarDayKey(day) === "2028-02-29")).toHaveLength(1);
  });
  it("crosses year and daylight-saving month boundaries by calendar days", () => {
    for (const month of [new Date(2026, 0, 1), new Date(2026, 2, 1), new Date(2026, 9, 1), new Date(2026, 11, 1)]) {
      const days = calendarMonthDays(month);
      for (let index = 1; index < days.length; index++) {
        const previous = new Date(days[index - 1]); previous.setDate(previous.getDate() + 1);
        expect(calendarDayKey(days[index])).toBe(calendarDayKey(previous));
      }
      expect(days.filter(day => day.getMonth() === month.getMonth())).toHaveLength(new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate());
    }
  });
  it("omits undated/invalid deadlines, optionally includes completed tasks and sorts without mutating the store", () => {
    const morning = task("morning", new Date(2026, 8, 12, 9).toISOString());
    const afternoon = task("afternoon", new Date(2026, 8, 12, 14).toISOString(), "overdue");
    const done = task("done", new Date(2026, 8, 12, 12).toISOString(), "done");
    const source = [afternoon, task("missing", ""), done, task("invalid", "invalid"), morning];
    const order = source.map(item => item.id);
    expect(calendarTasksByDay(source, false).get("2026-09-12")).toEqual([morning, afternoon]);
    expect(calendarTasksByDay(source, true).get("2026-09-12")).toEqual([morning, done, afternoon]);
    expect([...calendarTasksByDay(source, true).keys()]).toEqual(["2026-09-12"]);
    expect(source.map(item => item.id)).toEqual(order);
    expect(calendarTasksByDay(source, true).get("2026-09-12")![0]).toBe(morning);
  });
});
