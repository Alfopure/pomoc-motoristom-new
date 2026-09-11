import { describe, expect, it } from "vitest";
import { compareCaseRevisions, mergeCaseDetail } from "./case-detail";
import type { DispatchData } from "./dispatch-types";
import type { DispatchCase } from "@/domain/types";
describe("case receipt merges", () => {
  it("preserves independently refreshed tasks and rejects an older read at microsecond precision", () => {
    const item = { id: "case", priority: "urgent", updatedAt: "2026-09-11T10:00:00.000002Z", tasks: [{ id: "new-task" }] } as DispatchCase;
    const current = { dispatchCases: [item], users: [] } as unknown as DispatchData;
    expect(mergeCaseDetail(current, { ...item, priority: "low", updatedAt: "2026-09-11T10:00:00.000001Z" }).dispatchCases[0]).toBe(item);
    const result = mergeCaseDetail(current, { ...item, priority: "high", updatedAt: "2026-09-11T10:00:00.000003Z" });
    expect(result.dispatchCases[0].tasks).toBe(item.tasks);
    expect(result.users).toBe(current.users);
  });
  it("compares equivalent timestamps across timezone and fractional formats", () => {
    expect(compareCaseRevisions("2026-09-11T12:00:00.123001+02:00", "2026-09-11T10:00:00.123001Z")).toBe(0);
    expect(compareCaseRevisions("2026-09-11T10:00:00Z", "2026-09-11T10:00:00.000000Z")).toBe(0);
  });
});
