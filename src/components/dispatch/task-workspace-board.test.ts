import { describe, expect, it } from "vitest";
import type { WorkspaceTask } from "@/domain/task-workspace";
import { groupTaskBoard, taskBoardColumn, taskBoardDropStatus } from "./task-workspace-board";

const now = new Date(2026, 8, 10, 12, 0);
function task(id: string, patch: Partial<WorkspaceTask> = {}): WorkspaceTask {
  return {
    id, title: id, status: "open", dueAt: "", assignedTo: "unassigned", priority: "normal", kind: "other",
    caseId: "", caseIds: [], caseLinks: [], revision: 1, originLocked: false, provenance: "manual", origins: [],
    updatedAt: now.toISOString(), ...patch,
  };
}
const at = (day: number, hour: number) => new Date(2026, 8, day, hour, 0).toISOString();

describe("task board", () => {
  it("only completes open tasks and reopens completed tasks without mapping date buckets to statuses", () => {
    for (const column of ["overdue", "today", "scheduled", "undated"]) {
      expect(taskBoardDropStatus(task("open"), column)).toBeNull();
      expect(taskBoardDropStatus(task("done", { status: "done" }), column)).toBe("open");
    }
    expect(taskBoardDropStatus(task("open"), "done")).toBe("done");
    expect(taskBoardDropStatus(task("legacy", { status: "overdue" }), "done")).toBe("done");
    expect(taskBoardDropStatus(task("done", { status: "done" }), "done")).toBeNull();
    expect(taskBoardDropStatus(task("done", { status: "done" }), "outside")).toBeNull();
  });
  it("places elapsed deadlines only in overdue, including earlier today, and completed tasks only in done", () => {
    const tasks = [
      task("yesterday", { dueAt: at(9, 18) }), task("earlier-today", { dueAt: at(10, 9) }),
      task("later-today", { dueAt: at(10, 15) }), task("tomorrow", { dueAt: at(11, 9) }),
      task("standalone"), task("done", { dueAt: at(9, 9), status: "done" }),
    ];
    const columns = groupTaskBoard(tasks, now);
    expect(Object.fromEntries(columns.map(column => [column.id, column.tasks.map(item => item.id)]))).toEqual({
      overdue: ["yesterday", "earlier-today"], today: ["later-today"], scheduled: ["tomorrow"], undated: ["standalone"], done: ["done"],
    });
    expect(new Set(columns.flatMap(column => column.tasks.map(item => item.id))).size).toBe(tasks.length);
  });

  it("keeps undated legacy values visible and honors an explicit overdue status", () => {
    expect(taskBoardColumn(task("invalid", { dueAt: "not-a-date" }), now)).toBe("undated");
    expect(taskBoardColumn(task("legacy-overdue", { status: "overdue" }), now)).toBe("overdue");
  });

  it("moves a saved task between columns from canonical status and orders urgent work first", () => {
    const normal = task("normal", { dueAt: at(10, 13) });
    const urgent = task("urgent", { dueAt: at(10, 17), priority: "urgent" });
    expect(groupTaskBoard([normal, urgent], now).find(column => column.id === "today")?.tasks.map(item => item.id)).toEqual(["urgent", "normal"]);
    const columns = groupTaskBoard([normal, { ...urgent, status: "done" }], now);
    expect(columns.find(column => column.id === "today")?.tasks.map(item => item.id)).toEqual(["normal"]);
    expect(columns.find(column => column.id === "done")?.tasks.map(item => item.id)).toEqual(["urgent"]);
  });
});
