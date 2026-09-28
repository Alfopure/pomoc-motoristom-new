import { describe, expect, it } from "vitest";
import { normalizeEditablePhone, previewEditablePhone, storedPhoneForDial } from "./phone-entry";

describe("phone numbers entered by an operator", () => {
  it.each([
    ["0905 123 456", "+421905123456"],
    ["+420 777 123 456", "+420777123456"],
    ["0036 30 123 4567", "+36301234567"],
    ["+48 501 234 567", "+48501234567"],
    ["+43 660 123 4567", "+436601234567"],
    ["+49 151 1234 5678", "+4915112345678"],
    ["+380 50 123 4567", "+380501234567"],
  ])("stores %s as %s", (input, expected) => {
    expect(normalizeEditablePhone(input)).toBe(expected);
  });

  it("requires an explicit country prefix for a bare international number", () => {
    expect(previewEditablePhone("420777123456")).toBeNull();
    expect(previewEditablePhone("421905123456")).toBeNull();
  });

  it("does not turn an incomplete Slovak number into a different destination", () => {
    expect(previewEditablePhone("0905 123")).toBeNull();
    expect(previewEditablePhone("+421905123")).toBeNull();
  });

  it("permits short PBX extensions only where the directory explicitly allows them", () => {
    expect(previewEditablePhone("1234")).toBeNull();
    expect(normalizeEditablePhone("1234", { allowExtension: true })).toBe("1234");
  });

  it("keeps legacy stored numbers callable without relaxing manual entry", () => {
    expect(previewEditablePhone("420777123456")).toBeNull();
    expect(storedPhoneForDial("420777123456")).toBe("+420777123456");
    expect(storedPhoneForDial("421905123456")).toBe("+421905123456");
    expect(storedPhoneForDial("unavailable")).toBe("unavailable");
  });
});
