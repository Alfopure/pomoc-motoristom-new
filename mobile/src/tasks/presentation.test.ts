import { describe, expect, it } from "vitest";
import { customDueDate, duePreset, taskOverdue, taskRecipientLabel } from "./presentation";

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
