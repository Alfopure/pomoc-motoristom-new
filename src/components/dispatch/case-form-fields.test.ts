import { describe, expect, it } from "vitest";
import { joinContactPhone, splitContactPhone, type ContactDraft } from "./case-form-fields";

function contact(phonePrefix: string, phoneNational: string): ContactDraft {
  return {
    id: "contact-1",
    firstName: "Test",
    lastName: "Customer",
    phonePrefix,
    phoneNational,
    email: "",
    role: "primary_customer",
    note: "",
    isPrimary: true,
  };
}

describe("international case contact phones", () => {
  it("keeps known country prefixes separate for convenient editing", () => {
    expect(splitContactPhone("+420 123 456 789")).toEqual({ prefix: "+420", national: "123456789" });
  });

  it("keeps an Italian +39 number instead of changing it to +421", () => {
    const split = splitContactPhone("+399 123 456 789");

    expect(split).toEqual({ prefix: "+39", national: "9123456789" });
    expect(joinContactPhone(contact(split.prefix, split.national))).toBe("+39 9123456789");
  });

  it("round-trips a manually entered prefix that is not in the suggestion list", () => {
    const split = splitContactPhone("+971 50 123 4567");

    expect(split).toEqual({ prefix: "+", national: "971501234567" });
    expect(joinContactPhone(contact(split.prefix, split.national))).toBe("+971501234567");
  });
});
