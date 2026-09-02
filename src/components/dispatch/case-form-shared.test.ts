import { describe, expect, it } from "vitest";
import {
  conditionFlags,
  decimalOnly,
  digitsOnly,
  getEmailValidationError,
  getCaseFormCompletionErrors,
  getCaseFormFieldErrors,
  getCaseFormValidation,
  normalizeLicensePlateInput,
  normalizeVinInput,
  validateCaseFormBasics,
} from "./case-form-shared";

describe("case form validation", () => {
  it("maps format problems to the field that the employee can correct", () => {
    const errors = getCaseFormFieldErrors({
      contactEmail: "wrong-email",
      contactPhone: "+421 12",
      productionYear: "1940",
      vin: "SHORT",
    });

    expect(errors).toEqual({
      contactPhone: "Telefón musí obsahovať 9 až 15 číslic vrátane predvoľby.",
      contactEmail: "Email nemá správny formát.",
      vin: "VIN musí mať 17 znakov a nesmie obsahovať I, O ani Q.",
      productionYear: "Rok výroby musí byť medzi 1950 a budúcim rokom.",
    });
    expect(validateCaseFormBasics({ contactEmail: "wrong-email" })).toEqual(["Email nemá správny formát."]);
  });

  it("allows optional fields to stay empty on a draft card", () => {
    expect(getCaseFormFieldErrors({ requireCoreFields: false })).toEqual({});
  });

  it("uses the same completion rules for create and edit", () => {
    expect(getCaseFormCompletionErrors({})).toContain("Vyberte aspoň jeden typ zákazky.");

    expect(getCaseFormCompletionErrors({
      contactName: "Ján Novák",
      contactPhone: "+421 900 123 456",
      customerType: "private_person",
      destinationSelected: true,
      incidentType: "breakdown",
      jobTypes: ["tow"],
      licensePlate: "BA123AB",
      needsDestination: true,
      paymentMethod: "cash",
      paymentStatus: "unpaid",
      pickupSelected: true,
      replacementVehicleNeeded: false,
      sourceType: "client",
      vehicleDriveable: true,
      vehicleIssue: "Porucha motora",
    })).toEqual([]);
  });

  it("groups identical create and edit validation into the five visible sections", () => {
    const validation = getCaseFormValidation({
      contactEmail: "wrong",
      contactName: "Ján Novák",
      contactPhone: "+421 900123456",
      customerType: "private_person",
      incidentType: "breakdown",
      jobTypes: ["tow"],
      licensePlate: "BA123AB",
      needsDestination: true,
      paymentMethod: "cash",
      paymentStatus: "unpaid",
      pickupSelected: true,
      replacementVehicleNeeded: false,
      sourceType: "client",
      vehicleDriveable: true,
      vehicleIssue: "Porucha motora",
    });

    expect(validation.sectionValid).toEqual({
      basic: true,
      customer: false,
      vehicle: true,
      location: false,
      extras: true,
    });
    expect(validation.sectionErrors.customer).toContain("Email nemá správny formát.");
    expect(validation.sectionErrors.location).toContain("Vyberte cieľ odťahu.");
  });

  it("relaxes tow-oriented fields for a replacement-vehicle-only case (P-03/P-04)", () => {
    const errors = getCaseFormCompletionErrors({
      contactName: "Ján Novák",
      contactPhone: "+421 900 123 456",
      customerType: "private_person",
      jobTypes: ["replacement_vehicle"],
      paymentMethod: "cash",
      paymentStatus: "unpaid",
      replacementVehicleDeliveryPlace: "Pobočka Bratislava",
      replacementVehicleNeeded: true,
      replacementVehicleType: "Kombi",
      sourceType: "client",
    });

    expect(errors).toEqual([]);
  });

  it("requires the delivery place for a replacement-only case and keeps tow rules for mixed cases", () => {
    const replacementOnlyErrors = getCaseFormCompletionErrors({
      contactName: "Ján Novák",
      contactPhone: "+421 900 123 456",
      customerType: "private_person",
      jobTypes: ["replacement_vehicle"],
      paymentMethod: "cash",
      paymentStatus: "unpaid",
      replacementVehicleNeeded: true,
      replacementVehicleType: "Kombi",
      sourceType: "client",
    });
    expect(replacementOnlyErrors).toContain("Doplňte miesto pristavenia náhradného vozidla.");
    expect(replacementOnlyErrors).not.toContain("Doplňte EČV vozidla.");
    expect(replacementOnlyErrors).not.toContain("Vyberte typ incidentu.");

    const mixedErrors = getCaseFormCompletionErrors({
      jobTypes: ["replacement_vehicle", "tow"],
    });
    expect(mixedErrors).toContain("Doplňte EČV vozidla.");
    expect(mixedErrors).toContain("Vyberte typ incidentu.");
  });

  it("normalizes constrained values before they reach form state", () => {
    expect(digitsOnly("20hello26", 4)).toBe("2026");
    expect(decimalOnly("12km,50")).toBe("12.50");
    expect(normalizeLicensePlateInput("ba<123_xy")).toBe("BA123XY");
    expect(normalizeVinInput("wbaio-q123456789012345")).toBe("WBA12345678901234");
  });

  it("keeps driveability in the dedicated switch and validates every entered email", () => {
    expect(conditionFlags).not.toContain("driveable");
    expect(conditionFlags).not.toContain("immobile");
    expect(getEmailValidationError("operator@assistance.sk")).toBeUndefined();
    expect(getEmailValidationError("operator@assistance")).toBe("Email nemá správny formát.");
  });
});
