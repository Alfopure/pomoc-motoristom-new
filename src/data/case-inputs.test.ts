import { describe, expect, it } from "vitest";

import { collectCaseInputWarnings } from "./case-inputs";

describe("collectCaseInputWarnings", () => {
  it("accepts a completely empty draft without warnings", () => {
    expect(collectCaseInputWarnings({})).toEqual([]);
  });

  it("returns non-blocking field warnings for incomplete formatted values", () => {
    expect(
      collectCaseInputWarnings({
        contactPhone: "123",
        contactEmail: "nie-email",
        vin: "short",
        productionYear: 1900,
        pickup: { label: "", address: "", lat: Number.NaN, lng: 17 },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid_phone", field: "contactPhone" }),
        expect.objectContaining({ code: "invalid_email", field: "contactEmail" }),
        expect.objectContaining({ code: "invalid_vin", field: "vin" }),
        expect.objectContaining({ code: "invalid_year", field: "productionYear" }),
        expect.objectContaining({ code: "invalid_location", field: "pickup" }),
      ]),
    );
  });

  it("does not warn about omitted optional values", () => {
    expect(
      collectCaseInputWarnings({
        contactName: "Ján Novák",
        contactPhone: "+421 900 123 456",
        vin: "WVWZZZ1JZXW000001",
        productionYear: 2020,
      }),
    ).toEqual([]);
  });

  it("keeps partial contacts non-blocking but reports their action readiness", () => {
    expect(
      collectCaseInputWarnings({
        contacts: [
          { name: "Sekundárny kontakt", phone: "", role: "other" },
          { email: "dispatch@example.com", phone: "", role: "assistance" },
        ],
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "incomplete_contact", field: "contacts.0" }),
        expect.objectContaining({ code: "incomplete_contact", field: "contacts.1" }),
      ]),
    );
  });
});
