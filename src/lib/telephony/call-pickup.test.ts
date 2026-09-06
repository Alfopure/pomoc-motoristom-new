import { describe, expect, it } from "vitest";
import { canPickUpCall } from "./call-pickup";

describe("manual pickup eligibility", () => {
  const inbound = { state: "ringing", direction: "inbound", answered: false, operatorProfileId: null };
  it("permits an unanswered inbound call and parked calls that were previously answered", () => {
    expect(canPickUpCall(inbound)).toBe(true);
    expect(canPickUpCall({ ...inbound, state: "parked", answered: true })).toBe(true);
    expect(canPickUpCall({ ...inbound, state: "waiting" })).toBe(true);
  });
  it.each(["received", "greeting", "ivr", "talking", "held", "conference", "ended", "missed", "failed"])("does not interrupt %s", (state) => {
    expect(canPickUpCall({ ...inbound, state })).toBe(false);
  });
  it("does not intercept outbound, internal, owned, or transferred connected calls", () => {
    expect(canPickUpCall({ ...inbound, direction: "outbound" })).toBe(false);
    expect(canPickUpCall({ ...inbound, direction: "internal" })).toBe(false);
    expect(canPickUpCall({ ...inbound, operatorProfileId: "colleague" })).toBe(false);
    expect(canPickUpCall({ ...inbound, answered: true })).toBe(false);
  });
});
