import { describe, expect, it } from "vitest";
import type { CallCenterCall } from "@/data/dispatch-types";
import { historyCallbackLabel, historyResult, historySeconds, parseHistoryColumns } from "./history-display";

const call = (fields: Partial<CallCenterCall>) => ({ direction: "inbound", status: "ended", ...fields }) as CallCenterCall;
describe("history display meaning", () => {
  it("does not turn an ended but unconfirmed call into an accepted conversation", () => {
    expect(historyResult(call({})).label).toBe("Ukončený");
    expect(historyResult(call({ answeredAt: "2026-09-20T10:00:00Z" })).label).toBe("Prijatý");
    expect(historyResult(call({ direction: "outbound", answeredAt: "2026-09-20T10:00:00Z" })).label).toBe("Spojený");
    expect(historyResult(call({ direction: "outbound", status: "missed" })).label).toBe("Nedovolané");
    expect(historyResult(call({ status: "abandoned_queue", endReason: "callback_requested" })).label).toBe("Spätné volanie");
  });
  it("keeps unknown duration distinct from zero seconds", () => {
    for (const seconds of [undefined, NaN, Infinity, -1]) expect(historySeconds(seconds)).toBe("—");
    expect(historySeconds(0)).toBe("0:00");
    expect(historySeconds(137.8)).toBe("2:17");
    expect(historySeconds(3601)).toBe("60:01");
  });
  it("uses an actual callback obligation, never infers completion from a call outcome", () => {
    expect(historyCallbackLabel(call({ outcome: "callback" }))).toBe("—");
    expect(historyCallbackLabel(call({ callback: { status: "scheduled" } }))).toBe("Naplánované");
    expect(historyCallbackLabel(call({ callback: { status: "scheduled", claimedByName: "Jana" } }))).toBe("Prevzaté");
    expect(historyCallbackLabel(call({ callback: { status: "done" } }))).toBe("Vybavené");
  });
  it("recovers saved columns without enabling unknown or duplicated keys", () => {
    expect(parseHistoryColumns(null)).toEqual(["duration", "recording"]);
    expect(parseHistoryColumns(["note", "unknown", "note", "duration"])).toEqual(["duration", "note"]);
    expect(parseHistoryColumns([])).toEqual([]);
  });
});
