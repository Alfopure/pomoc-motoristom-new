import { describe, expect, it } from "vitest";
import type { WorkspaceTask } from "@/domain/task-workspace";
import { groupTaskBoard, taskBoardColumn, taskBoardDrop, taskBoardDateMutation, taskBoardColumns } from "./task-workspace-board";

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
  it("allows every different column but ignores the current column and unknown targets", () => {
    const tasks = [task("overdue", { dueAt: at(9, 10) }), task("today", { dueAt: at(10, 15) }),
      task("scheduled", { dueAt: at(11, 15) }), task("undated"), task("done", { status: "done" })];
    for (const item of tasks) for (const column of taskBoardColumns) {
      expect(Boolean(taskBoardDrop(item, column.id, now))).toBe(taskBoardColumn(item, now) !== column.id);
    }
    expect(taskBoardDrop(task("unknown"), "outside", now)).toBeNull();
  });

  it("completes without changing deadlines and clears deadlines on Undated while reopening", () => {
    expect(taskBoardDrop(task("open", { dueAt: at(10, 15) }), "done", now)).toEqual({ kind: "save", patch: { status: "done" } });
    expect(taskBoardDrop(task("done", { status: "done", dueAt: at(9, 10) }), "undated", now)).toEqual({ kind: "save", patch: { status: "open", dueAt: null } });
    expect(taskBoardDrop(task("legacy", { status: "overdue" }), "undated", now)).toEqual({ kind: "save", patch: { status: "open", dueAt: null } });
  });

  it("moves undated, overdue, planned and completed tasks to the end of the local day", () => {
    for (const item of [task("undated"), task("old", { dueAt: at(9, 10) }), task("future", { dueAt: at(11, 10) }), task("done", { status: "done", dueAt: at(9, 10) }), task("legacy", { status: "overdue", dueAt: "invalid" })]) {
      const drop = taskBoardDrop(item, "today", now);
      expect(drop).toEqual({ kind: "save", patch: { status: "open", dueAt: new Date(2026, 8, 10, 23, 59, 59, 999).toISOString() } });
      if (drop?.kind === "save") expect(taskBoardColumn({ ...item, ...drop.patch, dueAt: drop.patch.dueAt ?? "" }, now)).toBe("today");
    }
  });

  it("preserves a still-future deadline today when reopening and resets sticky legacy overdue", () => {
    for (const status of ["done", "overdue"] as const) expect(taskBoardDrop(task(status, { status, dueAt: at(10, 15) }), "today", now))
      .toEqual({ kind: "save", patch: { status: "open", dueAt: at(10, 15) } });
  });

  it("requests explicit future or past dates before saving and suggests valid local calendar days", () => {
    expect(taskBoardDrop(task("undated"), "scheduled", now)).toEqual({ kind: "date", column: "scheduled", suggestedDueAt: at(11, 9) });
    expect(taskBoardDrop(task("undated"), "overdue", now)).toEqual({ kind: "date", column: "overdue", suggestedDueAt: new Date(2026, 8, 9, 23, 59).toISOString() });
    expect(taskBoardDrop(task("done", { status: "done", dueAt: at(12, 10) }), "scheduled", now)).toEqual({ kind: "date", column: "scheduled", suggestedDueAt: at(12, 10) });
    expect(taskBoardDrop(task("done", { status: "done", dueAt: at(9, 10) }), "overdue", now)).toEqual({ kind: "date", column: "overdue", suggestedDueAt: at(9, 10) });
  });

  it("validates the confirmed date against the destination and current clock", () => {
    for (const value of ["", "invalid", at(9, 10), at(10, 15)]) expect(taskBoardDateMutation("scheduled", value, now)).toBeNull();
    expect(taskBoardDateMutation("scheduled", at(11, 0), now)).toEqual({ status: "open", dueAt: at(11, 0) });
    expect(taskBoardDateMutation("scheduled", at(11, 9), new Date(2026, 8, 11, 0))).toBeNull();
    for (const value of ["", "invalid", now.toISOString(), at(10, 15), at(11, 10)]) expect(taskBoardDateMutation("overdue", value, now)).toBeNull();
    expect(taskBoardDateMutation("overdue", at(10, 9), now)).toEqual({ status: "open", dueAt: at(10, 9) });
  });

  it.each([new Date(2026, 2, 28, 12), new Date(2026, 9, 24, 12), new Date(2026, 11, 31, 23, 59, 59)])("uses calendar arithmetic across DST and year boundaries at %s", clock => {
    const next = new Date(clock); next.setDate(next.getDate() + 1); next.setHours(9, 0, 0, 0);
    const end = new Date(clock); end.setHours(23, 59, 59, 999);
    expect(taskBoardDrop(task("undated"), "scheduled", clock)).toEqual({ kind: "date", column: "scheduled", suggestedDueAt: next.toISOString() });
    expect(taskBoardDrop(task("undated"), "today", clock)).toEqual({ kind: "save", patch: { status: "open", dueAt: end.toISOString() } });
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
