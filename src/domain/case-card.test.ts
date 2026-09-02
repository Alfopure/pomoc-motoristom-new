import { describe, expect, it } from "vitest";

import {
  canonicalCaseProblemDescription,
  defaultCustomerDetails,
  defaultIncidentDetails,
  defaultPaymentDetails,
  legacyVehicleProblemDescription,
} from "./case-card";

describe("empty case detail defaults", () => {
  it("does not silently classify the customer, incident or payment", () => {
    expect(defaultCustomerDetails()).toEqual({});
    expect(defaultIncidentDetails()).toEqual({ damageAreas: [] });
    expect(defaultPaymentDetails()).toEqual({});
  });
});

describe("canonical case problem description", () => {
  it("deduplicates the single problem value without changing its content", () => {
    expect(canonicalCaseProblemDescription("Defekt predného kolesa", " Defekt predného kolesa ")).toBe("Defekt predného kolesa");
  });

  it("preserves distinct legacy vehicle and incident descriptions", () => {
    expect(canonicalCaseProblemDescription("Motor zhasol", "Vozidlo stojí v odstavnom pruhu")).toBe(
      "Motor zhasol · Vozidlo stojí v odstavnom pruhu",
    );
  });

  it("removes every duplicated trailing vehicle note from legacy storage", () => {
    expect(legacyVehicleProblemDescription("Defekt · Disk poškodený · Disk poškodený", "Disk poškodený")).toBe("Defekt");
    expect(legacyVehicleProblemDescription("Disk poškodený", "Disk poškodený")).toBeUndefined();
  });
});
