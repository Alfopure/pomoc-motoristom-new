import { describe, expect, it } from "vitest";
import { decodeHistoryCursor, encodeHistoryCursor, parseCallHistoryQuery } from "./call-history-query";

describe("history query boundaries", () => {
  it("uses complete local days across both Bratislava DST transitions", () => {
    const spring = parseCallHistoryQuery(new URLSearchParams({ from: "2026-03-29", to: "2026-03-29" }));
    expect(spring.from).toBe("2026-03-28T23:00:00.000Z");
    expect(spring.to).toBe("2026-03-29T22:00:00.000Z");
    const autumn = parseCallHistoryQuery(new URLSearchParams({ from: "2026-10-25", to: "2026-10-25" }));
    expect(autumn.from).toBe("2026-10-24T22:00:00.000Z");
    expect(autumn.to).toBe("2026-10-25T23:00:00.000Z");
  });
  it.each(["2026-02-30", "bad", "2026-13-01"])("rejects invalid dates %s", from => {
    expect(() => parseCallHistoryQuery(new URLSearchParams({ from }))).toThrow();
  });
  it.each([{ from: "2026-09-20", to: "2026-09-19" }, { limit: "101" }, { limit: "NaN" }, { operatorId: "other" }, { direction: "bad" }, { q: "a".repeat(161) }])("rejects invalid filter %j", params => {
    expect(() => parseCallHistoryQuery(new URLSearchParams(Object.entries(params).filter((entry): entry is [string, string] => typeof entry[1] === "string")))).toThrow();
  });
  it("retains null timestamps and stable identity in the cursor", () => {
    for (const startedAt of [null, "2026-09-19T12:00:00.000Z"]) {
      const cursor = { startedAt, id: "00000000-0000-4000-8000-000000000001" };
      expect(decodeHistoryCursor(encodeHistoryCursor(cursor))).toEqual(cursor);
    }
    expect(() => decodeHistoryCursor("malformed")).toThrow();
    expect(() => decodeHistoryCursor(encodeURIComponent('{"id":"bad","startedAt":null}'))).toThrow();
  });
});
