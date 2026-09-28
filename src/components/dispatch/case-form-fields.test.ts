import { describe, expect, it } from "vitest";
import { joinContactPhone, type ContactDraft } from "./case-form-fields";

function contact(phone: string): ContactDraft {
  return {
    id: "contact-1",
    firstName: "Test",
    lastName: "Customer",
    phone,
    email: "",
    role: "primary_customer",
    note: "",
    isPrimary: true,
  };
}

describe("international case contact phones", () => {
  it("keeps an Italian +39 number instead of changing it to +421", () => {
    expect(joinContactPhone(contact("+39 9123456789"))).toBe("+399123456789");
  });

  it("accepts a manually entered international prefix", () => {
    expect(joinContactPhone(contact("+971 50 123 4567"))).toBe("+971501234567");
  });

  it("canonicalizes Slovak national and pasted Czech numbers for case storage", () => {
    expect(joinContactPhone(contact("0905 123 456"))).toBe("+421905123456");
    expect(joinContactPhone(contact("00420 777 123 456"))).toBe("+420777123456");
  });

  it("leaves ambiguous bare international input visible for correction", () => {
    expect(joinContactPhone(contact("421905123456"))).toBe("421905123456");
  });
});
