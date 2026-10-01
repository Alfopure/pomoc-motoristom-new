import "server-only";
import { isVin, normalizeVehicleIdentifier, vehicleText, type VehicleField, type VehicleQuery, type VehicleSourceResult } from "@/lib/vehicle-lookup";
import { ProviderHttpError } from "./http";

export const AUTOKUK_URL = "https://autokuk.cz/api";
const ENDPOINT = "https://autokuk.cz/api/v1/search";
type Row = Record<string, unknown>;

function row(value: unknown): Row | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
}
function text(value: unknown): string | undefined { return vehicleText(value); }
function positive(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? String(value) : undefined;
}
function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) return undefined;
  const day = value.slice(0, 10);
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day ? day : undefined;
}
function empty(fetchedAt: string): VehicleSourceResult {
  return { source: "autokuk", status: "unavailable", url: AUTOKUK_URL, fetchedAt, facts: {}, warnings: [] };
}

/** Allowlisted vehicle and vignette fields only: historical insurance is not current coverage. */
export function parseAutokuk(payload: unknown, query: VehicleQuery, fetchedAt: string): VehicleSourceResult {
  const result = empty(fetchedAt);
  if (query.country !== "CZ") return { ...result, status: "unsupported" };
  const envelope = row(payload), data = row(envelope?.data);
  if (envelope?.status !== "ok" || !data) return result;
  const echoed = normalizeVehicleIdentifier(text(data.query) ?? "");
  const vin = normalizeVehicleIdentifier(text(data.vin) ?? "");
  const vehicle = row(data.vehicle);
  const vehicleVin = normalizeVehicleIdentifier(text(vehicle?.vin) ?? "");
  const records = row(data.vehicle_records);
  if (records?.ambiguous === true || (isVin(vehicleVin) && vehicleVin !== vin) ||
      (echoed && echoed !== query.value) || (query.kind === "vin" && isVin(vin) && vin !== query.value)) {
    return { ...result, status: "ambiguous", warnings: ["Zdroj vrátil nejednoznačnú identitu vozidla. Overte VIN v dokladoch."] };
  }
  if (!isVin(vin) || !vehicle || (vehicleVin && !isVin(vehicleVin)) ||
      (query.kind === "plate" && (echoed !== query.value || data.searched_by_spz !== true))) return result;
  function put(field: VehicleField, value: string | undefined) {
    if (value) result.facts[field] = { value, quality: "reported" };
  }
  put("vin", vin);
  // The API does not return an independently found plate, but explicitly confirms
  // that it resolved the echoed plate to the returned VIN.
  if (query.kind === "plate") put("plate", query.value);
  const technical = row(data.technical);
  const specification = row(technical?.specification);
  const registration = row(technical?.registration);
  const engine = row(technical?.engine);
  const weights = row(technical?.weights);
  const dimensions = row(technical?.dimensions);
  const capacity = row(technical?.capacity);
  const towing = row(technical?.towing);
  const emissions = row(technical?.emissions_consumption);
  put("make", text(vehicle.brand) ?? text(specification?.brand));
  put("model", text(vehicle.model) ?? text(specification?.model));
  put("vehicleCategory", text(vehicle.category) ?? text(specification?.category));
  put("vehicleType", text(specification?.vehicle_kind));
  put("vehicleTypeDesignation", text(vehicle.type) ?? text(specification?.type));
  put("variant", text(specification?.variant));
  put("version", text(specification?.version));
  put("manufacturer", text(specification?.vehicle_manufacturer));
  put("bodyType", text(vehicle.body_type) ?? text(specification?.body_type));
  put("color", text(vehicle.color) ?? text(specification?.color));
  put("fuel", text(vehicle.fuel) ?? text(engine?.fuel));
  put("engineType", text(engine?.type));
  put("engineCapacityCc", positive(vehicle.engine_capacity_cc) ?? positive(engine?.displacement_cc));
  put("powerKw", positive(vehicle.power_kw) ?? positive(engine?.max_power_kw));
  put("engineRpm", positive(engine?.max_power_rpm));
  put("firstRegisteredAt", isoDate(vehicle.first_registration) ?? isoDate(registration?.first_registration));
  put("curbWeightKg", positive(weights?.operating_weight_kg));
  put("grossWeightKg", positive(weights?.max_permitted_weight_kg));
  put("trailerBrakedWeightKg", positive(towing?.braked_trailer_technically_permissible_kg));
  put("trailerUnbrakedWeightKg", positive(towing?.unbraked_trailer_technically_permissible_kg));
  put("lengthMm", positive(dimensions?.length_mm));
  put("widthMm", positive(dimensions?.width_mm));
  put("heightMm", positive(dimensions?.height_mm));
  put("wheelbaseMm", positive(dimensions?.wheelbase_mm));
  put("seats", positive(capacity?.seats_total));
  put("emissionClass", text(emissions?.emission_level));
  const vignette = row(data.vignette);
  if (vignette?.status === "ok") {
    if (vignette.exempt === true) put("vignetteStatus", "Oslobodené");
    else if (typeof vignette.valid === "boolean") {
      put("vignetteStatus", vignette.valid ? "Platná" : "Neplatná");
      if (vignette.valid) {
        put("vignetteValidFrom", isoDate(vignette.valid_from));
        put("vignetteValidUntil", isoDate(vignette.valid_until));
      }
    }
  }
  result.status = "found";
  return result;
}

/** POST variant of providerText: fixed URL, no redirects/cache, bounded time and body. */
async function postSearch(query: string, key: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(ENDPOINT, {
    method: "POST", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, 9_000))),
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ query, include: ["vignette"] }),
  });
  if (!response.ok) throw new ProviderHttpError(response.status);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty_body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 500_000) throw new Error("response_too_large");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function lookupAutokuk(query: VehicleQuery, options: { timeoutMs?: number } = {}): Promise<VehicleSourceResult> {
  const result = empty(new Date().toISOString());
  if (query.country !== "CZ") return { ...result, status: "unsupported" };
  const key = process.env.CZ_AUTOKUK_API_KEY?.trim();
  if (!key) return { ...result, status: "unsupported", warnings: ["Autokuk API nemá nastavený kľúč."] };
  try {
    return parseAutokuk(await postSearch(query.value, key, options.timeoutMs ?? 9_000), query, new Date().toISOString());
  } catch (error) {
    if (error instanceof ProviderHttpError) {
      if (error.status === 404) return { ...result, status: "not_found" };
      if (error.status === 429) return { ...result, status: "rate_limited" };
    }
    return result;
  }
}
