import { describe, expect, it } from "vitest";
import { formatPhoneNumberForDisplay, formatViptelDialTarget, isDialablePhoneInput } from "@/lib/telephony/phone";

describe("VIPTel dial target", () => {
  it.each([
    ["+421 910 988 882", "0910988882"],
    ["00421 910 988 882", "00421910988882"],
    ["+399 123 456 789", "00399123456789"],
    ["0910 988 882", "0910988882"],
    ["21", "21"],
  ])("normalizes %s to the SIP/REST dial form %s", (input, expected) => {
    expect(formatViptelDialTarget(input)).toBe(expected);
  });
});

describe("dialable caller identity", () => {
  it.each(["22", "+421 910 988 882", "041/228 92 40"])("accepts %s", (input) => {
    expect(isDialablePhoneInput(input)).toBe(true);
  });

  it.each(["", "Prichádzajúci hovor", "Bez aktívneho hovoru", "sip:22@example.test"])(
    "rejects non-number placeholder %s",
    (input) => {
      expect(isDialablePhoneInput(input)).toBe(false);
    },
  );
});

describe("human-facing phone identity", () => {
  it.each([
    ["00421 910 988 882", "+421 910 988 882"],
    ["00399 123 456 789", "+399123456789"],
    ["421910988882", "+421 910 988 882"],
    ["0910988882", "0910 988 882"],
    ["20", "20"],
  ])("formats %s as %s", (input, expected) => {
    expect(formatPhoneNumberForDisplay(input)).toBe(expected);
  });
});
