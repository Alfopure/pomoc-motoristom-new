import { describe, expect, it } from "vitest";
import type { CaseTask } from "./types";
import { compareOperationalTasks, isTaskDueToday, isTaskHandoverRelevant, isTaskOpen, isTaskOverdue, taskStatusLabel } from "./tasks";

const now = new Date("2026-06-08T10:00:00.000Z");

function task(overrides: Partial<CaseTask> = {}): CaseTask {
  return {
    id: "task-1",
    caseId: "case-1",
    title: "Zavolať zákazníkovi",
    assignedTo: "operator-1",
    dueAt: "2026-06-08T11:00:00.000Z",
    status: "open",
    priority: "normal",
    kind: "callback",
    ...overrides,
  };
}

describe("task inbox domain rules", () => {
  it("derives open and overdue from status and due time", () => {
    expect(isTaskOpen(task({ status: "open" }))).toBe(true);
    expect(isTaskOpen(task({ status: "done" }))).toBe(false);
    expect(isTaskOverdue(task({ dueAt: "2026-06-08T09:59:00.000Z" }), now)).toBe(true);
    expect(isTaskOverdue(task({ dueAt: "2026-06-08T09:00:00.000Z", status: "done" }), now)).toBe(false);
    expect(taskStatusLabel(task({ dueAt: "2026-06-08T09:00:00.000Z" }), now)).toBe("Po termíne");
  });

  it("keeps the today view limited to open tasks due on the same local date", () => {
    expect(isTaskDueToday(task({ dueAt: "2026-06-08T18:00:00.000Z" }), now)).toBe(true);
    expect(isTaskDueToday(task({ dueAt: "2026-06-09T08:00:00.000Z" }), now)).toBe(false);
    expect(isTaskDueToday(task({ dueAt: "2026-06-08T18:00:00.000Z", status: "done" }), now)).toBe(false);
  });

  it("marks handover-relevant tasks by missing assignee or near due time", () => {
    expect(isTaskHandoverRelevant(task({ assignedTo: "unassigned", dueAt: "2026-06-08T15:00:00.000Z" }), now)).toBe(true);
    expect(isTaskHandoverRelevant(task({ assignedTo: "operator-1", dueAt: "2026-06-08T11:30:00.000Z" }), now)).toBe(true);
    expect(isTaskHandoverRelevant(task({ assignedTo: "operator-1", dueAt: "2026-06-08T13:30:00.000Z" }), now)).toBe(false);
    expect(isTaskHandoverRelevant(task({ assignedTo: "unassigned", status: "done" }), now)).toBe(false);
  });

  it("sorts operational tasks by overdue state, priority and due time", () => {
    const ordered = [
      task({ id: "future-low", dueAt: "2026-06-08T10:30:00.000Z", priority: "low" }),
      task({ id: "future-urgent", dueAt: "2026-06-08T12:00:00.000Z", priority: "urgent" }),
      task({ id: "overdue-normal", dueAt: "2026-06-08T09:30:00.000Z", priority: "normal" }),
      task({ id: "overdue-high", dueAt: "2026-06-08T09:45:00.000Z", priority: "high" }),
    ].sort((left, right) => compareOperationalTasks(left, right, now));

    expect(ordered.map((item) => item.id)).toEqual(["overdue-high", "overdue-normal", "future-urgent", "future-low"]);
  });
});
