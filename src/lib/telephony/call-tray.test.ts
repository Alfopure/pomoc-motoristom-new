import { describe, expect, it } from "vitest";
import type { PhoneBarCall, PhoneBarModel } from "./active-calls-model";
import { callTrayCapacity, callTrayOffers } from "./call-tray";

function call(id: string, patch: Partial<PhoneBarCall> = {}): PhoneBarCall {
  return { sessionId: id, kind: "offer", state: "ringing", operatorProfileId: null,
    timerSince: "2026-09-19T12:00:00Z", startedAt: "2026-09-19T11:00:00Z", ...patch } as PhoneBarCall;
}
function model(calls: PhoneBarCall[], active: PhoneBarCall | null = null): PhoneBarModel {
  return { teamCalls: calls, offers: [], active } as unknown as PhoneBarModel;
}
describe("call tray", () => {
  it("excludes IVR/greeting, waiting and answered-by-colleague transitions", () => {
    expect(callTrayOffers(model([call("greeting", { state: "greeting" }), call("ivr", { state: "ivr" }), call("waiting", { state: "waiting", kind: "waiting" }), call("answered", { operatorProfileId: "colleague" }), call("ringing")])).map((row) => row.sessionId)).toEqual(["ringing"]);
  });
  it("deduplicates enriched offers, orders by stable start and id, excludes pinned own session", () => {
    const own = call("own", { kind: "active" });
    const snapshot = model([call("b"), call("a"), own], own);
    snapshot.offers = [call("a", { callerName: "Anna", timerSince: "2026-09-19T13:00:00Z" })];
    expect(callTrayOffers(snapshot).map((row) => [row.sessionId, row.callerName])).toEqual([["a", "Anna"], ["b", undefined]]);
  });
  it.each([0, 1, 3, 4, 10])("keeps all %i offers accessible and counts the pinned bar in the visible limit", (count) => {
    const calls = callTrayOffers(model(Array.from({ length: count }, (_, i) => call(String(i)))));
    expect(calls).toHaveLength(count);
    expect(callTrayCapacity(true)).toBe(2); expect(callTrayCapacity(false)).toBe(3);
  });
});
