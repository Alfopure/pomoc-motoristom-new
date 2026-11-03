import { describe, expect, it } from "vitest";
import { canReviewCaseCreation, caseRecoverySelection, caseShortcut, statusForCategory } from "./filters";

describe("case list transitions and uncertain create review", () => {
  it("all overview shortcuts clear search, owner and status with canonical open filters", () => {
    expect(caseShortcut("open")).toEqual({ ownership: "all", category: "open", q: "", ownerId: null, status: null, priority: null });
    expect(caseShortcut("mine")).toMatchObject({ ownership: "mine", category: "open", q: "", ownerId: null, status: null, priority: null });
    expect(caseShortcut("unassigned")).toMatchObject({ ownership: "unassigned", category: "open", q: "", ownerId: null, status: null, priority: null });
    expect(caseShortcut("urgent")).toMatchObject({ ownership: "all", category: "open", q: "", ownerId: null, status: null, priority: "urgent" });
  });
  it("unknown create recovery includes all owners, statuses and priorities", () => {
    const recovery = caseRecoverySelection();
    expect(canReviewCaseCreation(recovery)).toBe(true);
    for (const change of [{ ownership: "mine" as const }, { ownership: "unassigned" as const }, { category: "open" as const }, { ownerId: "colleague" }, { q: "plate" }, { status: "open" as const }, { priority: "urgent" as const }]) {
      expect(canReviewCaseCreation({ ...recovery, ...change })).toBe(false);
    }
    for (const shortcut of ["open", "mine", "unassigned", "urgent"] as const) expect(canReviewCaseCreation(caseShortcut(shortcut))).toBe(false);
  });
  it("returning to open clears closed status but retains an open exact status", () => {
    expect(statusForCategory("cancelled", "open")).toBeNull();
    expect(statusForCategory("cancelled", "all")).toBe("cancelled");
    expect(statusForCategory("waiting_for_docs", "open")).toBe("waiting_for_docs");
  });
});
