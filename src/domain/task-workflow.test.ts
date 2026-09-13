import { describe, expect, it } from "vitest";
import { canReviewTask, taskRequiresReview, taskWorkflowLabels, taskWorkflowState } from "./task-workflow";

describe("task workflow meaning", () => {
  it("keeps deadline state independent from board stage and maps old rows without a backfill", () => {
    expect(taskWorkflowState({ status: "overdue" })).toBe("todo");
    expect(taskWorkflowState({ status: "overdue", workflowState: "in_progress" })).toBe("in_progress");
    expect(taskWorkflowState({ status: "overdue", workflowState: "in_review" })).toBe("in_review");
    expect(taskWorkflowState({ status: "done" })).toBe("done");
    expect(taskWorkflowState({ status: "open", workflowState: "done" })).toBe("todo");
    expect(Object.values(taskWorkflowLabels)).toEqual(["Na vybavenie", "Rozpracované", "Na kontrolu", "Vybavené"]);
  });
  it("shows reviewer actions only to the designated colleague while retaining required review after return", () => {
    expect(canReviewTask({ status: "open", workflowState: "in_review", reviewerProfileId: "reviewer" }, "reviewer")).toBe(true);
    expect(canReviewTask({ status: "open", workflowState: "in_review", reviewerProfileId: "reviewer" }, "assignee")).toBe(false);
    expect(canReviewTask({ status: "done", workflowState: "done", reviewerProfileId: "reviewer" }, "reviewer")).toBe(false);
    expect(canReviewTask({ status: "open", workflowState: "in_progress", reviewerProfileId: "reviewer" }, "reviewer")).toBe(false);
    expect(taskRequiresReview({ reviewerProfileId: "reviewer" })).toBe(true);
    expect(taskRequiresReview({ reviewerProfileId: null })).toBe(false);
  });
});
