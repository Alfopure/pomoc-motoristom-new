import { describe, expect, it } from "vitest";
import type { MobileActiveCall } from "../../../src/lib/mobile-api";
import type { PhoneState } from "../voice/phone";
import { callBarCall, elapsed } from "./call-bar-model";

const start = Date.parse("2026-10-19T08:00:00Z");
function active(id: string, patch: Partial<MobileActiveCall> = {}): MobileActiveCall {
  return { id, direction: "inbound", state: "talking", number: "+421905123456", name: null, lineLabel: "Allianz", startedAt: new Date(start).toISOString(), ...patch };
}
const phone = (patch: Partial<NonNullable<PhoneState["call"]>> = {}): PhoneState["call"] =>
  ({ id: "c", sessionId: "s", number: "+421905111222", displayName: null, state: "ACTIVE", outgoing: false, connected: true, ...patch });

describe("call bar", () => {
  it("shows nothing without a call", () => {
    expect(callBarCall(null, [])).toBeNull();
  });
  it("prefers the call in this phone over calls the server knows", () => {
    expect(callBarCall(phone({ displayName: "Ján" }), [active("a")])).toEqual({ kind: "phone", title: "Ján", status: "Prebieha" });
    expect(callBarCall(phone({ connected: false, outgoing: true }), [])!.status).toBe("Vytáča sa");
    expect(callBarCall(phone({ connected: false }), [])!.status).toBe("Zvoní");
    expect(callBarCall(phone({ state: "HELD" }), [])!.status).toBe("Podržaný");
    expect(callBarCall(phone({ state: "RECONNECTING" }), [])!.status).toBe("Obnovuje sa");
    expect(callBarCall(phone(), [])!.title).toBe("+421 905 111 222");
  });
  it("shows one server call with its state, several as a count", () => {
    expect(callBarCall(null, [active("a", { name: "MOCK zákazník" })])).toMatchObject({ kind: "server", id: "a", title: "MOCK zákazník", status: "Prebieha", count: 1 });
    expect(callBarCall(null, [active("a"), active("b")])).toMatchObject({ kind: "server", title: "2 hovory na vašom účte", status: "Otvoriť Ústredňu", count: 2 });
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
