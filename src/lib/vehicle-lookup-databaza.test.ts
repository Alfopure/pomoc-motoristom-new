import { afterEach, describe, expect, it, vi } from "vitest";
import { readVerifiedVehicleLookup, sealVehicleLookup, verifyVehicleLookup } from "@/server/vehicle-lookup/snapshot";
import {
  emptyVehicleFieldPatch, lookupIdentityConflict, preferredVehicleFacts, readVehicleLookupSnapshot,
  vehicleFactConflicts, type VehicleFacts, type VehicleLookupResult, type VehicleSource, type VehicleSourceResult,
} from "./vehicle-lookup";

const vin = "TESTTESTTEST00001";
const plate = "XX000XX";
const time = "2026-09-05T08:00:00Z";
const organization = "synthetic-org";
const key = "synthetic-contract-signing-key";
const urls: Record<VehicleSource, string> = {
  databazavozidiel: "https://www.databazavozidiel.sk/",
  skp: "https://www.skp.sk/",
  stkonline: "https://www.stkonline.sk/",
  haka: "https://www.hakasystem.eu/",
  vpic: "https://vpic.nhtsa.dot.gov/api/",
};
function source(name: VehicleSource, facts: VehicleFacts = {}): VehicleSourceResult {
  return { source: name, status: "found", url: urls[name], fetchedAt: time, facts, warnings: [] };
}
function result(sources: VehicleSourceResult[]): VehicleLookupResult {
  return { version: 1, id: "synthetic-lookup", query: { kind: "plate", value: plate, country: "SK", checkedForDate: "2026-09-05" }, fetchedAt: time, sources };
}
const technicalFacts = {
  fuel: { value: "Nafta", quality: "reported" },
  bodyType: { value: "Kombi", quality: "reported" },
  color: { value: "Biela", quality: "reported" },
  transmission: { value: "Automatická", quality: "reported" },
  transmissionGears: { value: "7", quality: "reported" },
  engineType: { value: "SYNTHETIC-ENGINE", quality: "reported" },
  engineCapacityCc: { value: "1968", quality: "reported" },
  powerKw: { value: "110", quality: "reported" },
  curbWeightKg: { value: "1540", quality: "reported" },
  grossWeightKg: { value: "2100", quality: "reported" },
  drivenAxles: { value: "2 / predná a zadná", quality: "reported" },
  axleCount: { value: "2", quality: "reported" },
  wheelbaseMm: { value: "2680", quality: "reported" },
  tireDimensions: { value: "205/55 R16", quality: "reported" },
} satisfies VehicleFacts;

afterEach(() => vi.unstubAllEnvs());

describe("DatabázaVozidiel source precedence and operator choices", () => {
  it("prefers the API representation of equivalent facts regardless of arrival order", () => {
    const lookup = result([
      source("vpic", { fuel: { value: "Diesel", quality: "decoded" } }),
      source("skp", { color: { value: " BIELA ", quality: "reported" }, insurer: { value: "Synthetic insurer", quality: "reported" } }),
      source("stkonline", { fuel: { value: "NAFTA", quality: "reported" } }),
      source("databazavozidiel", technicalFacts),
    ]);
    const originalOrder = lookup.sources.map(entry => entry.source);
    expect(vehicleFactConflicts(lookup)).toEqual({});
    expect(preferredVehicleFacts(lookup)).toMatchObject({ ...technicalFacts, insurer: { value: "Synthetic insurer", quality: "reported" } });
    expect(emptyVehicleFieldPatch(lookup, { fuel: "", color: "", engineType: "", grossWeightKg: "" })).toEqual({ fuel: "Nafta", color: "Biela", engineType: "SYNTHETIC-ENGINE", grossWeightKg: "2100" });
    expect(lookup.sources.map(entry => entry.source)).toEqual(originalOrder);
  });

  it("requires a choice for conflicting technical values and preserves manually entered fields", () => {
    const lookup = result([
      source("stkonline", { color: { value: "Čierna", quality: "reported" } }),
      source("vpic", { grossWeightKg: { value: "2400", quality: "decoded" } }),
      source("databazavozidiel", technicalFacts),
    ]);
    expect(Object.keys(vehicleFactConflicts(lookup)).sort()).toEqual(["color", "grossWeightKg"]);
    expect(emptyVehicleFieldPatch(lookup, { color: "", grossWeightKg: "", drivenAxles: "" })).toEqual({ drivenAxles: "2 / predná a zadná" });
    expect(emptyVehicleFieldPatch(lookup, { color: "", grossWeightKg: "" }, false, { color: "stkonline", grossWeightKg: "databazavozidiel" })).toEqual({ color: "Čierna", grossWeightKg: "2100" });
    expect(emptyVehicleFieldPatch(lookup, { color: "Manual color", grossWeightKg: "" }, false, { color: "databazavozidiel", grossWeightKg: "haka" })).toEqual({});
  });

  it("does not turn partial decoder output into a conflict until the operator includes it", () => {
    const lookup = result([
      source("databazavozidiel", { powerKw: technicalFacts.powerKw }),
      source("vpic", { powerKw: { value: "150", quality: "partial" } }),
    ]);
    expect(emptyVehicleFieldPatch(lookup, { powerKw: "" })).toEqual({ powerKw: "110" });
    expect(emptyVehicleFieldPatch(lookup, { powerKw: "" }, true)).toEqual({});
    expect(emptyVehicleFieldPatch(lookup, { powerKw: "" }, true, { powerKw: "vpic" })).toEqual({ powerKw: "150" });
  });

  it("ignores API facts when the provider did not establish a matching vehicle", () => {
    const api = { ...source("databazavozidiel", technicalFacts), status: "unavailable" as const };
    const lookup = result([api, source("stkonline", { fuel: { value: "Benzín", quality: "reported" } })]);
    expect(preferredVehicleFacts(lookup)).toEqual({ fuel: { value: "Benzín", quality: "reported" } });
    expect(vehicleFactConflicts(lookup)).toEqual({});
  });
});

describe("expanded signed vehicle observations", () => {
  it("reads a frozen legacy v1 signature with all four previous sources", () => {
    const legacy = { ...result([
      source("skp", { plate: { value: plate, quality: "reported" }, vin: { value: vin, quality: "reported" }, insurer: { value: "Synthetic insurer", quality: "reported" } }),
      source("stkonline", { vin: { value: vin, quality: "reported" }, fuel: { value: "Nafta", quality: "reported" } }),
      source("haka"),
      source("vpic", { powerKw: { value: "100", quality: "decoded" } }),
    ]), id: "synthetic-legacy-v1" };
    // Frozen signature of the pre-integration v1 shape: signing changes must not invalidate history.
    const stored = { result: legacy, proof: "Oupba2eUyBJWvtMw3usg6cat8kf_9Xde4JqYtJu_-g0" };
    vi.stubEnv("VEHICLE_LOOKUP_SIGNING_KEY", key);
    vi.stubEnv("VEHICLE_LOOKUP_PREVIOUS_SIGNING_KEY", "");
    expect(readVehicleLookupSnapshot(stored)).toEqual(stored);
    expect(readVerifiedVehicleLookup(stored, organization, { plate, vin })).toEqual(stored);
    expect(verifyVehicleLookup(stored, organization, { plate, vin }, key)).toEqual(stored);
    expect(stored.result.sources).toHaveLength(4);
  });

  it("reads and verifies five sources with string-valued technical details", () => {
    const lookup = result([
      source("databazavozidiel", { ...technicalFacts, vin: { value: vin, quality: "reported" } }),
      source("skp"), source("stkonline"), source("haka"), source("vpic"),
    ]);
    const stored = sealVehicleLookup(lookup, organization, key);
    expect(readVehicleLookupSnapshot(stored)?.result.sources).toHaveLength(5);
    expect(verifyVehicleLookup(stored, organization, { plate, vin }, key)).toEqual(stored);
    expect(readVehicleLookupSnapshot(stored)?.result.sources[0].facts).toMatchObject(technicalFacts);
    const tooMany = structuredClone(stored);
    tooMany.result.sources.push(source("skp"));
    expect(readVehicleLookupSnapshot(tooMany)).toBeUndefined();
  });

  it("detects a modified API technical value and rejects reuse by another organization", () => {
    const stored = sealVehicleLookup(result([source("databazavozidiel", technicalFacts)]), organization, key);
    const modified = structuredClone(stored);
    modified.result.sources[0].facts.grossWeightKg!.value = "3500";
    expect(readVehicleLookupSnapshot(modified)).toBeDefined();
    expect(() => verifyVehicleLookup(modified, organization, { plate }, key)).toThrow();
    expect(() => verifyVehicleLookup(stored, "different-synthetic-org", { plate }, key)).toThrow();
  });

  it.each([
    "http://www.databazavozidiel.sk/",
    "https://untrusted.example/",
    "https://www.databazavozidiel.sk.untrusted.example/",
    "https://www.databazavozidiel.sk@untrusted.example/",
    "https://synthetic:fixture@www.databazavozidiel.sk/",
    "https://www.databazavozidiel.sk:8443/",
    "javascript:alert(1)",
  ])("rejects an unsafe source link: %s", url => {
    const stored = sealVehicleLookup(result([{ ...source("databazavozidiel", technicalFacts), url }]), organization, key);
    expect(readVehicleLookupSnapshot(stored)).toBeUndefined();
  });

  it.each([1540, null, { min: 1500 }, ["1540"], "x".repeat(181)])("rejects malformed technical fact values (%j)", value => {
    const stored = sealVehicleLookup(result([source("databazavozidiel")]), organization, key);
    const malformed = { ...stored, result: { ...stored.result, sources: [{ ...stored.result.sources[0], facts: { curbWeightKg: { value, quality: "reported" } } }] } };
    expect(readVehicleLookupSnapshot(malformed)).toBeUndefined();
  });

  it("rejects an unrecognized provider, field and external report link", () => {
    const stored = sealVehicleLookup(result([source("databazavozidiel", technicalFacts)]), organization, key);
    expect(readVehicleLookupSnapshot({ ...stored, result: { ...stored.result, sources: [{ ...stored.result.sources[0], source: "untrusted" }] } })).toBeUndefined();
    expect(readVehicleLookupSnapshot({ ...stored, result: { ...stored.result, sources: [{ ...stored.result.sources[0], facts: { unknownTechnicalField: { value: "test", quality: "reported" } } }] } })).toBeUndefined();
    expect(readVehicleLookupSnapshot({ ...stored, result: { ...stored.result, sources: [{ ...stored.result.sources[0], reports: [{ url: "https://untrusted.example/report", title: "Synthetic report" }] }] } })).toBeUndefined();
  });

  it.each(["constructor", "__proto__", "toString"])("rejects inherited object properties as source or field names: %s", name => {
    const stored = sealVehicleLookup(result([source("databazavozidiel", technicalFacts)]), organization, key);
    expect(readVehicleLookupSnapshot({ ...stored, result: { ...stored.result, sources: [{ ...stored.result.sources[0], source: name }] } })).toBeUndefined();
    expect(readVehicleLookupSnapshot({ ...stored, result: { ...stored.result, sources: [{ ...stored.result.sources[0], facts: { [name]: { value: "test", quality: "reported" } } }] } })).toBeUndefined();
  });

  it("binds each source to its own website instead of trusting any known provider hostname", () => {
    const lookup = result([{ ...source("databazavozidiel", technicalFacts), url: urls.skp }]);
    expect(readVehicleLookupSnapshot(sealVehicleLookup(lookup, organization, key))).toBeUndefined();
    lookup.sources = [{ ...source("skp"), url: urls.databazavozidiel }];
    expect(readVehicleLookupSnapshot(sealVehicleLookup(lookup, organization, key))).toBeUndefined();
  });

  it("rejects duplicate sources even when the total stays within five", () => {
    const lookup = result([source("databazavozidiel", technicalFacts), source("databazavozidiel", { color: { value: "Čierna", quality: "reported" } })]);
    expect(readVehicleLookupSnapshot(sealVehicleLookup(lookup, organization, key))).toBeUndefined();
  });
});

it("requires manual resolution when SKP reports an older plate for the same VIN", () => {
  const lookup = result([
    source("databazavozidiel", { vin: { value: vin, quality: "reported" }, plate: { value: plate, quality: "reported" }, ...technicalFacts }),
    source("skp", { vin: { value: vin, quality: "reported" }, plate: { value: "XX000XY", quality: "reported" }, insurer: { value: "Synthetic insurer", quality: "reported" } }),
  ]);
  expect(lookupIdentityConflict(lookup, { plate, vin })).toContain("EČV");
  expect(emptyVehicleFieldPatch(lookup, { plate, vin, fuel: "", insurer: "" })).toEqual({});
  expect(() => verifyVehicleLookup(sealVehicleLookup(lookup, organization, key), organization, { plate, vin }, key)).toThrow("EČV");
});
