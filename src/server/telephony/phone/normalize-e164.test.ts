import { describe, expect, it } from "vitest";

import { e164Digits, normalizeE164, sameE164 } from "./normalize-e164";

describe("normalizeE164", () => {
  it("collapses both Telnyx representations of the first DID to one canonical string", () => {
    expect(normalizeE164("+4210232408700")).toBe("+421232408700");
    expect(normalizeE164("+421232408700")).toBe("+421232408700");
    expect(sameE164("+4210232408700", "+421232408700")).toBe(true);
  });

  it("keeps the other DIDs of the same block untouched", () => {
    expect(normalizeE164("+421232408718")).toBe("+421232408718");
    expect(normalizeE164("+421232408783")).toBe("+421232408783");
  });

  it("understands Slovak national formats", () => {
    expect(normalizeE164("0905 123 456")).toBe("+421905123456");
    expect(normalizeE164("0905123456")).toBe("+421905123456");
    expect(normalizeE164("02/32 408 700")).toBe("+421232408700");
    expect(normalizeE164("02 3240 8700")).toBe("+421232408700");
    expect(normalizeE164("905123456")).toBe("+421905123456");
    expect(normalizeE164("+421 (0) 905 123 456")).toBe("+421905123456");
    expect(normalizeE164("+421 905-123-456")).toBe("+421905123456");
  });

  it("handles international prefixes and other countries", () => {
    expect(normalizeE164("00420 777 123 456")).toBe("+420777123456");
    expect(normalizeE164("+420 (0)777 123 456")).toBe("+420777123456");
    expect(normalizeE164("+49 0151 12345678")).toBe("+4915112345678");
    expect(normalizeE164("421905123456")).toBe("+421905123456");
    expect(normalizeE164("+39 06 1234 5678")).toBe("+390612345678");
    expect(normalizeE164("tel:+421905123456")).toBe("+421905123456");
  });

  it("honours a different default country", () => {
    expect(normalizeE164("0777 123 456", { defaultCountryCode: "420" })).toBe("+420777123456");
    expect(normalizeE164("777123456", { defaultCountryCode: "420" })).toBeNull();
  });

  it("returns null for garbage, extensions and SIP URIs", () => {
    expect(normalizeE164("")).toBeNull();
    expect(normalizeE164("   ")).toBeNull();
    expect(normalizeE164(null)).toBeNull();
    expect(normalizeE164(undefined)).toBeNull();
    expect(normalizeE164({})).toBeNull();
    expect(normalizeE164("abc")).toBeNull();
    expect(normalizeE164("101")).toBeNull();
    expect(normalizeE164("+421")).toBeNull();
    expect(normalizeE164("+42100232408700")).toBeNull();
    expect(normalizeE164("sip:gencred123@sip.telnyx.com")).toBeNull();
    expect(normalizeE164("+4219051234561234567")).toBeNull();
    expect(normalizeE164("0905 123 456 x12")).toBeNull();
    expect(normalizeE164("1234567890123")).toBeNull();
  });

  it("exposes digits without the plus for API filters", () => {
    expect(e164Digits("+4210232408700")).toBe("421232408700");
    expect(e164Digits("nope")).toBeNull();
  });
});
