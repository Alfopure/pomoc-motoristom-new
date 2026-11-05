import { describe, expect, it } from "vitest";
import { defaultCaseTableColumns, moveCaseTableColumn, parseCaseTableColumns } from "./case-table-columns";

describe("case table column preferences", () => {
  it("retains saved order, removes unknown/duplicate entries and anchors case identity", () => {
    expect(parseCaseTableColumns('["vehicle","unknown","status","vehicle"]')).toEqual(["caseNumber", "vehicle", "status"]);
    expect(parseCaseTableColumns('["status","caseNumber","caller"]')).toEqual(["caseNumber", "status", "caller"]);
  });
  it("uses compact defaults for unavailable, broken or empty preferences", () => {
    for (const raw of [null, "{", "{}", "[]", '["unknown"]']) expect(parseCaseTableColumns(raw)).toEqual(defaultCaseTableColumns);
  });
  it("moves optional columns while preserving identity and valid boundaries", () => {
    const columns = ["caseNumber", "status", "vehicle"] as const;
    expect(moveCaseTableColumn([...columns], "vehicle", -1)).toEqual(["caseNumber", "vehicle", "status"]);
    expect(moveCaseTableColumn([...columns], "status", -1)).toEqual(columns);
    expect(moveCaseTableColumn([...columns], "caseNumber", 1)).toEqual(columns);
    expect(moveCaseTableColumn([...columns], "vehicle", 1)).toEqual(columns);
    expect(moveCaseTableColumn([...columns], "caller", 1)).toEqual(columns);
  });
});
