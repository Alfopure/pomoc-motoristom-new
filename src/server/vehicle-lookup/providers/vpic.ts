import type { VehicleSourceResult, VehicleField } from "@/lib/vehicle-lookup";
import { vehicleText } from "@/lib/vehicle-lookup";

export function parseVpic(json: unknown, fetchedAt: string): VehicleSourceResult {
  const base: VehicleSourceResult = { source: "vpic", status: "unsupported", url: "https://vpic.nhtsa.dot.gov/api/", fetchedAt, facts: {}, warnings: [] };
  if (!json || typeof json !== "object" || !Array.isArray((json as { Results?: unknown }).Results)) return { ...base, status: "unavailable" };
  const row = (json as { Results: Record<string, unknown>[] }).Results[0];
  if (!row || typeof row !== "object") return { ...base, status: "unavailable" };
  const codes = String(row.ErrorCode ?? "").split(",").map((value) => value.trim());
  const quality = codes.length === 1 && codes[0] === "0" ? "decoded" : "partial";
  const map: Record<string, VehicleField> = { Make: "make", Model: "model", ModelYear: "modelYear", FuelTypePrimary: "fuel", BodyClass: "bodyType", Doors: "doors", Seats: "seats", TransmissionStyle: "transmission", DisplacementCC: "engineCapacityCc", EnginePowerKW: "powerKw" };
  for (const [key, field] of Object.entries(map)) {
    const value = vehicleText(row[key]);
    if (value && value !== "0" && !(field === "modelYear" && !/^(19|20)\d{2}$/.test(value))) base.facts[field] = { value, quality };
  }
  if (Object.keys(base.facts).length) {
    base.status = "found";
    if (quality === "partial") base.warnings.push("Neúplné alebo nejednoznačné dekódovanie VIN. Údaje sú iba návrh; overte ich v dokladoch.");
  }
  return base;
}
