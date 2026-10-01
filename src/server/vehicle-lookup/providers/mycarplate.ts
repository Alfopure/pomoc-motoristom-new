import "server-only";
import { isVin, normalizeVehicleIdentifier, vehicleText, type VehicleField, type VehicleQuery, type VehicleSourceResult } from "@/lib/vehicle-lookup";
import { ProviderHttpError, providerText } from "./http";

export const MYCARPLATE_URL = "https://www.mycarplate.online/countries/czech-republic";
const ENDPOINT = "https://mycarplate.online/api/v1/vehicle";
type Row = Record<string, unknown>;

function row(value: unknown): Row | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
}
function text(value: unknown): string | undefined { return vehicleText(value); }
function positive(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? String(value) : undefined;
}
function positiveIntegerText(value: unknown): string | undefined {
  const match = typeof value === "string" ? /^\s*(\d{1,5})(?:\s*(?:cc|cm3|cm³))?\s*$/iu.exec(value) : undefined;
  return match && Number(match[1]) > 0 ? String(Number(match[1])) : undefined;
}
function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : undefined;
}
function empty(fetchedAt: string): VehicleSourceResult {
  return { source: "mycarplate", status: "unavailable", url: MYCARPLATE_URL, fetchedAt, facts: {}, warnings: [] };
}

/** A Czech plate binds a VIN only when the provider echoes that plate and country. */
export function parseMyCarPlate(payload: unknown, query: VehicleQuery, fetchedAt: string): VehicleSourceResult {
  const result = empty(fetchedAt);
  if (query.country !== "CZ" || query.kind !== "plate") return { ...result, status: "unsupported" };
  const envelope = row(payload);
  const data = row(envelope?.data);
  if (envelope?.success !== true || !data) return result;
  const plate = normalizeVehicleIdentifier(text(data.plate) ?? "");
  const country = typeof data.country === "string" ? data.country.trim().toUpperCase() : "";
  const vin = normalizeVehicleIdentifier(text(data.vin) ?? "");
  if ((plate && plate !== query.value) || (country && country !== "CZ")) {
    return { ...result, status: "ambiguous", warnings: ["Zdroj vrátil iné EČV alebo krajinu. Overte údaje v dokladoch."] };
  }
  if (plate !== query.value || country !== "CZ" || !isVin(vin)) return result;
  // The resolver's own confidence measures the plate → VIN match. Do not use a
  // low-confidence VIN to query the register or prefill a dispatch record.
  if (data.confidence !== undefined && data.confidence !== null) {
    if (typeof data.confidence !== "number" || !Number.isFinite(data.confidence) || data.confidence < 0 || data.confidence > 1) {
      return { ...result, warnings: ["Zdroj vrátil neplatnú mieru istoty zhody EČV a VIN."] };
    }
    if (data.confidence < 0.8) {
      return { ...result, status: "ambiguous", warnings: ["Zhoda EČV a VIN má nízku istotu. Overte VIN v dokladoch."] };
    }
  }

  function put(field: VehicleField, value: string | undefined, quality: "reported" | "partial" = "reported") {
    if (value) result.facts[field] = { value, quality };
  }
  put("plate", plate);
  put("vin", vin);
  put("make", text(data.make));
  put("model", text(data.model));
  put("color", text(data.color));
  put("fuel", text(data.fuelType), typeof data.fuelType === "string" && /^hybrid$/i.test(data.fuelType.trim()) ? "partial" : "reported");
  put("bodyType", text(data.bodyClass));
  put("transmission", text(data.transmission));
  put("emissionClass", text(data.emissionClass));
  put("engineCapacityCc", positiveIntegerText(data.engineSize) ?? positive(data.engineSize));
  put("powerKw", positive(data.powerKw));
  put("curbWeightKg", positive(data.weight));
  put("firstRegisteredAt", isoDate(data.firstRegistration));
  if (data.motStatus === "Valid") put("technicalInspectionValidUntil", isoDate(data.motExpiryDate));
  if (typeof data.year === "number" && Number.isInteger(data.year) && data.year >= 1886 && data.year <= 2100) put("modelYear", String(data.year));
  if (typeof data.doors === "number" && Number.isInteger(data.doors) && data.doors > 0 && data.doors <= 9) put("doors", String(data.doors));
  result.status = "found";
  return result;
}

export async function lookupMyCarPlate(query: VehicleQuery, options: { timeoutMs?: number } = {}): Promise<VehicleSourceResult> {
  const result = empty(new Date().toISOString());
  if (query.country !== "CZ" || query.kind !== "plate") return { ...result, status: "unsupported" };
  const url = new URL(ENDPOINT);
  url.searchParams.set("plate", query.value);
  url.searchParams.set("country", "CZ");
  url.searchParams.set("withVin", "true");
  const key = process.env.CZ_MYCARPLATE_API_KEY?.trim();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (key) headers["X-API-Key"] = key;
  try {
    const body = await providerText(url.toString(), { timeoutMs: Math.max(1, Math.min(options.timeoutMs ?? 9_000, 9_000)), headers });
    return parseMyCarPlate(JSON.parse(body), query, new Date().toISOString());
  } catch (error) {
    if (error instanceof ProviderHttpError) {
      if (error.status === 404) return { ...result, status: "not_found" };
      if (error.status === 429) return { ...result, status: "rate_limited" };
    }
    return result;
  }
}
