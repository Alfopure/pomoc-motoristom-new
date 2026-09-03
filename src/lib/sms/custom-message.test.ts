import { describe, expect, it } from "vitest";
import { MAX_CUSTOM_SMS_LENGTH, validateCustomSmsDraft } from "./custom-message";

describe("custom SMS validation", () => {
  it("trims the recipient and message", () => {
    expect(validateCustomSmsDraft({ toNumber: " 0904 123 456 ", message: " Dobrý deň. " })).toEqual({
      toNumber: "0904 123 456",
      message: "Dobrý deň.",
    });
  });

  it("requires both recipient and message", () => {
    expect(() => validateCustomSmsDraft({ toNumber: "", message: "Text" })).toThrow("telefónne číslo");
    expect(() => validateCustomSmsDraft({ toNumber: "0904123456", message: "  " })).toThrow("text SMS");
  });

  it("guards the maximum body length before the SMS transport is reached", () => {
    expect(() => validateCustomSmsDraft({ toNumber: "0904123456", message: "x".repeat(MAX_CUSTOM_SMS_LENGTH + 1) })).toThrow(
      `${MAX_CUSTOM_SMS_LENGTH} znakov`,
    );
  });
});
