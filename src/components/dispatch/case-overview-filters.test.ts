import { describe, expect, it } from "vitest";
import { countCaseOverviewFilters, matchesCaseOverviewFilters } from "./case-overview-filters";

const item = { branchId: "bratislava", jobTypes: ["tow", "replacement_vehicle"] as const, createdAt: "2026-11-05T23:30:00Z" };
const sample = { ...item, jobTypes: [...item.jobTypes] };

describe("case overview filters", () => {
  it("keeps the existing snapshot unchanged when no additional filters are selected", () => {
    expect(matchesCaseOverviewFilters(sample, {})).toBe(true);
    expect(matchesCaseOverviewFilters(sample, { branchId: "all", jobType: "all", createdFrom: "", createdTo: "" })).toBe(true);
    expect(countCaseOverviewFilters({})).toBe(0);
  });
  it("intersects branch and work type without excluding a combined case", () => {
    expect(matchesCaseOverviewFilters(sample, { branchId: "bratislava", jobType: "replacement_vehicle" })).toBe(true);
    expect(matchesCaseOverviewFilters(sample, { branchId: "kosice", jobType: "tow" })).toBe(false);
    expect(matchesCaseOverviewFilters(sample, { jobType: "onsite_assistance" })).toBe(false);
  });
  it("uses inclusive Bratislava calendar dates rather than UTC midnight", () => {
    expect(matchesCaseOverviewFilters(sample, { createdFrom: "2026-11-06", createdTo: "2026-11-06" })).toBe(true);
    expect(matchesCaseOverviewFilters(sample, { createdTo: "2026-11-05" })).toBe(false);
    expect(matchesCaseOverviewFilters({ ...sample, createdAt: "2026-11-05T22:59:59Z" }, { createdFrom: "2026-11-06" })).toBe(false);
    expect(matchesCaseOverviewFilters({ ...sample, createdAt: "2026-11-06T22:59:59Z" }, { createdTo: "2026-11-06" })).toBe(true);
  });
  it("keeps the local calendar day correct across summer time", () => {
    expect(matchesCaseOverviewFilters({ ...sample, createdAt: "2026-07-05T22:00:00Z" }, { createdFrom: "2026-07-06", createdTo: "2026-07-06" })).toBe(true);
    expect(matchesCaseOverviewFilters({ ...sample, createdAt: "2026-07-05T21:59:59Z" }, { createdFrom: "2026-07-06" })).toBe(false);
  });
  it("does not match an inverted period or an unknown creation date", () => {
    expect(matchesCaseOverviewFilters(sample, { createdFrom: "2026-11-07", createdTo: "2026-11-05" })).toBe(false);
    expect(matchesCaseOverviewFilters({ ...sample, createdAt: "invalid" }, { createdTo: "2026-11-06" })).toBe(false);
    expect(matchesCaseOverviewFilters({ ...sample, createdAt: "invalid" }, {})).toBe(true);
  });
  it("counts only selected extra filters", () => {
    expect(countCaseOverviewFilters({ branchId: "all", jobType: "all" })).toBe(0);
    expect(countCaseOverviewFilters({ branchId: "bratislava", jobType: "tow", createdFrom: "2026-11-01", createdTo: "2026-11-30" })).toBe(4);
  });
});
