import { describe, expect, it } from "vitest";
import { normalizeViptelSmsMsisdn } from "./sms-client";

describe("VIPTel SMS destination normalization", () => {
  it.each([
    ["0900 123 456", "00421900123456"],
    ["+421 900 123 456", "00421900123456"],
    ["+399 123 456 789", "00399123456789"],
    ["00399 123 456 789", "00399123456789"],
  ])("normalizes %s as %s", (input, expected) => {
    expect(normalizeViptelSmsMsisdn(input)).toBe(expected);
  });

  it("does not guess the country for an unprefixed foreign number", () => {
    expect(() => normalizeViptelSmsMsisdn("399123456789")).toThrow(/international/);
  });
});
