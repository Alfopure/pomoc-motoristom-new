import { describe, expect, it } from "vitest";
import type { MobileActiveCall } from "../../../src/lib/mobile-api";
import { callBarCall, elapsed } from "./call-bar-model";

const start = Date.parse("2026-10-19T08:00:00Z");
function active(id: string, patch: Partial<MobileActiveCall> = {}): MobileActiveCall {
  return { id, direction: "inbound", state: "talking", number: "+421905123456", name: null, contactName: null, lineLabel: "Allianz", startedAt: new Date(start).toISOString(), ...patch };
}

describe("call bar", () => {
  it("shows nothing without a call", () => {
    expect(callBarCall([], [])).toBeNull();
  });
  it("shows one server call with its state", () => {
    expect(callBarCall([active("a", { name: "MOCK zákazník" })], [])).toEqual({ id: "a", title: "MOCK zákazník", status: "Prebieha", startedAt: new Date(start).toISOString(), count: 1 });
    expect(callBarCall([active("a", { name: "Allianz", contactName: "Ján Kontakt" })], [])).toMatchObject({ title: "Ján Kontakt" });
    expect(callBarCall([active("a")], [])!.title).toBe("+421 905 123 456");
  });
  it("leaves out the phone's own and just-ended calls, case-insensitively", () => {
    expect(callBarCall([active("AAA")], ["aaa"])).toBeNull();
    expect(callBarCall([active("a"), active("b", { name: "Stolový" })], ["A"])).toMatchObject({ id: "b", title: "Stolový", count: 1 });
  });
  it("counts several calls in Slovak", () => {
    expect(callBarCall([active("a"), active("b")], [])).toMatchObject({ title: "2 hovory na vašom účte", status: "Ústredňa", count: 2 });
    expect(callBarCall(["a", "b", "c", "d", "e"].map(id => active(id)), [])!.title).toBe("5 hovorov na vašom účte");
  });
  it("formats the elapsed time", () => {
    const iso = new Date(start).toISOString();
    expect(elapsed(iso, start + 7_000)).toBe("0:07");
    expect(elapsed(iso, start + 751_000)).toBe("12:31");
    expect(elapsed(iso, start + 3_729_000)).toBe("1:02:09");
    expect(elapsed(iso, start - 5_000)).toBe("0:00");
    expect(elapsed("not a date", start)).toBe("");
  });
});
