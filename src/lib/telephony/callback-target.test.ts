import { describe, expect, it } from "vitest";
import { callbackTargetAuthorization, confirmedCallbackTarget, type CallbackTargetResolution } from "./callback-target";
const resolution: CallbackTargetResolution = { originalNumber: "02/32 408 700", dialNumber: "+421905123456", status: "verified_alternative", sourceContactId: "source", sourceName: "Switchboard", targetContactId: "target", targetName: "Operator", verificationId: "verification" };
const binding = { version: 1, requestId: "request-a", verificationId: "verification", originalNumber: "+421232408700", targetNumber: "+421905123456", actorProfileId: "actor-a", approvedAt: "2026-09-10T10:00:00Z" };
describe("verified callback target", () => {
  it("keeps unknown/unconfigured original input exact and never infers from a name", () => {
    expect(confirmedCallbackTarget({ ...resolution, status: "original" })).toBe("02/32 408 700");
    expect(confirmedCallbackTarget({ ...resolution, status: "blocked" }, "verification")).toBeNull();
    expect(confirmedCallbackTarget(resolution)).toBeNull();
    expect(confirmedCallbackTarget(resolution, "old-verification")).toBeNull();
    expect(confirmedCallbackTarget(resolution, "verification")).toBe("+421905123456");
  });
  it("freezes only exact request and actual dialed number, preserving original separately", () => {
    expect(callbackTargetAuthorization(binding, "request-a", "0905 123 456")).toEqual(binding);
    expect(callbackTargetAuthorization(binding, "request-b", binding.targetNumber)).toBeUndefined();
    expect(callbackTargetAuthorization(binding, "request-a", binding.originalNumber)).toBeUndefined();
    expect(callbackTargetAuthorization({ ...binding, targetNumber: binding.originalNumber }, "request-a", binding.originalNumber)).toBeUndefined();
    expect(callbackTargetAuthorization({ ...binding, approvedAt: "invalid" }, "request-a", binding.targetNumber)).toBeUndefined();
  });
});
