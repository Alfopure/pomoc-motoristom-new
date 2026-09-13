import { describe, expect, it } from "vitest";
import type { WorkspaceTask } from "@/domain/task-workspace";
import { groupWorkflowBoard, taskWorkflowCardActions, workflowDropAction } from "./task-workflow-board";

const task = (patch: Partial<WorkspaceTask> = {}): WorkspaceTask => ({ id: "task", title: "Úloha", status: "open", workflowState: "todo", assignedTo: "solver", dueAt: "2026-01-01T10:00:00Z", priority: "normal", kind: "other", caseId: "", caseIds: [], caseLinks: [], revision: 1, updatedAt: "2026-09-10T10:00:00Z", originLocked: false, provenance: "manual", origins: [], ...patch });
describe("workflow board presentation", () => {
  it("groups by work stage regardless of late, future or missing deadlines, exactly once", () => {
    const tasks = [task(), task({ id: "progress", workflowState: "in_progress", dueAt: "2099-01-01T10:00:00Z" }), task({ id: "review", workflowState: "in_review", dueAt: "", reviewerProfileId: "reviewer" }), task({ id: "done", status: "done", workflowState: "done" })];
    expect(groupWorkflowBoard(tasks, new Date("2026-09-12T12:00:00Z")).map(column => [column.id, column.tasks.map(task => task.id)])).toEqual([["todo", ["task"]], ["in_progress", ["progress"]], ["in_review", ["review"]], ["done", ["done"]]]);
  });
  it("keeps deadline and reminder out of every drop command", () => {
    const original = task({ reminderAt: "2027-01-01T10:00:00Z" }), before = structuredClone(original);
    expect(workflowDropAction(original, "in_progress", "solver")).toBe("start");
    expect(workflowDropAction(original, "in_review", "solver")).toBe("submit_review");
    expect(workflowDropAction(original, "done", "solver")).toBe("complete");
    expect(original).toEqual(before);
  });
  it("never offers a generic completion path around an assigned review", () => {
    const returned = task({ workflowState: "in_progress", reviewerProfileId: "reviewer", reviewReturnReason: "Doplniť" });
    expect(workflowDropAction(returned, "done", "solver")).toBeNull();
    expect(taskWorkflowCardActions(returned, "solver")).toEqual(["submit_review"]);
  });
  it("restricts approval and return drops to the designated reviewer", () => {
    const review = task({ workflowState: "in_review", reviewerProfileId: "reviewer" });
    expect(workflowDropAction(review, "done", "solver")).toBeNull();
    expect(workflowDropAction(review, "in_progress", "other")).toBeNull();
    expect(workflowDropAction(review, "todo", "reviewer")).toBeNull();
    expect(workflowDropAction(review, "done", "reviewer")).toBe("approve");
    expect(workflowDropAction(review, "in_progress", "reviewer")).toBe("return");
    expect(taskWorkflowCardActions(review, "reviewer")).toEqual(["approve", "return"]);
    expect(taskWorkflowCardActions(review, "solver")).toEqual([]);
  });
  it("reopens completed work to the actual todo destination only", () => {
    const done = task({ status: "done", workflowState: "done", reviewerProfileId: "reviewer" });
    expect(workflowDropAction(done, "todo", "solver")).toBe("reopen");
    for (const target of ["in_progress", "in_review", "done", "today", "invalid"]) expect(workflowDropAction(done, target, "solver")).toBeNull();
  });
});
