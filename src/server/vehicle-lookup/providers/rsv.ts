import "server-only";
import { isVin, normalizeVehicleIdentifier, vehicleText, type VehicleField, type VehicleQuery, type VehicleSourceResult } from "@/lib/vehicle-lookup";
import { ProviderHttpError, providerText } from "./http";

export const RSV_URL = "https://dataovozidlech.cz/vyhledavani";
const ENDPOINT = "https://api.dataovozidlech.cz/api/vehicletechnicaldata/v2";
type Row = Record<string, unknown>;

function row(value: unknown): Row | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
}
function text(value: unknown): string | undefined { return vehicleText(value); }
function number(value: unknown): string | undefined {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? String(value) : undefined;
  if (typeof value !== "string" || !/^\s*\d+(?:[.,]\d+)?\s*$/.test(value)) return undefined;
  const parsed = Number(value.trim().replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? String(parsed) : undefined;
}
function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) return undefined;
  const day = value.slice(0, 10);
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day ? day : undefined;
}
function slashValues(value: unknown): [string | undefined, string | undefined] {
  if (typeof value !== "string") return [undefined, undefined];
  const parts = value.split("/");
  if (parts.length !== 2) return [undefined, undefined];
  return [number(parts[0]), number(parts[1])];
}
function permittedWeight(value: unknown): string | undefined {
  // RSV writes "technically permissible / legally permitted" in one field.
  return slashValues(value)[1];
}
function empty(fetchedAt: string): VehicleSourceResult {
  return { source: "rsv", status: "unavailable", url: RSV_URL, fetchedAt, facts: {}, warnings: [] };
}

/** Map only dispatch-relevant technical facts; certificate and owner fields are discarded. */
export function parseRsv(payload: unknown, query: VehicleQuery, fetchedAt: string): VehicleSourceResult {
  const result = empty(fetchedAt);
  if (query.country !== "CZ" || query.kind !== "vin" || !isVin(query.value)) return { ...result, status: "unsupported" };
  const envelope = row(payload);
  const data = row(envelope?.Data);
  if (envelope?.Status !== 1 || !data) return result;
  const vin = normalizeVehicleIdentifier(text(data.VIN) ?? "");
  if (isVin(vin) && vin !== query.value) {
    return { ...result, status: "ambiguous", warnings: ["Register vrátil iný VIN. Overte údaje v dokladoch."] };
  }
  if (!isVin(vin)) return result;
  function put(field: VehicleField, value: string | undefined) {
    if (value) result.facts[field] = { value, quality: "reported" };
  }
  put("vin", vin);
  put("make", text(data.TovarniZnacka));
  put("model", text(data.ObchodniOznaceni));
  put("vehicleCategory", text(data.Kategorie));
  put("vehicleType", text(data.VozidloDruh));
  put("vehicleTypeDesignation", text(data.Typ));
  put("variant", text(data.Varianta));
  put("version", text(data.Verze));
  const manufacturer = text(data.VozidloVyrobce);
  if (manufacturer !== ".") put("manufacturer", manufacturer);
  put("bodyType", text(data.KaroserieDruh));
  put("color", text(data.VozidloKaroserieBarva));
  put("engineType", text(data.MotorTyp));
  put("engineManufacturer", text(data.MotorVyrobce));
  put("engineCapacityCc", number(data.MotorZdvihObjem));
  put("emissionClass", text(data.EmisniUroven));
  put("firstRegisteredAt", isoDate(data.DatumPrvniRegistrace));
  put("technicalInspectionValidUntil", isoDate(data.PravidelnaTechnickaProhlidkaDo));
  put("curbWeightKg", number(data.HmotnostiProvozni));
  put("grossWeightKg", permittedWeight(data.HmotnostiPripPov));
  put("grossTrainWeightKg", permittedWeight(data.HmotnostiPripPovJS));
  put("trailerBrakedWeightKg", permittedWeight(data.HmotnostiPripPovBrzdenePV));
  put("trailerUnbrakedWeightKg", permittedWeight(data.HmotnostiPripPovNebrzdenePV));
  put("wheelbaseMm", number(data.RozmeryRozvor));
  put("maxSpeedKmh", number(data.NejvyssiRychlost));
  const [power, rpm] = slashValues(data.MotorMaxVykon);
  put("powerKw", power);
  put("engineRpm", rpm);
  const seats = typeof data.VozidloKaroserieMist === "string" ? data.VozidloKaroserieMist.split("/")[0] : undefined;
  put("seats", number(seats));
  const dimensions = typeof data.Rozmery === "string" ? data.Rozmery.split("/") : [];
  if (dimensions.length === 3) {
    put("lengthMm", number(dimensions[0]));
    put("widthMm", number(dimensions[1]));
    put("heightMm", number(dimensions[2]));
  }
  const fuel = text(data.Palivo);
  if (fuel) {
    const normalized = /^(BA|BA\s*\d+\s*[A-Z]?)$/iu.test(fuel) ? "Benzín"
      : /^(NM|NAFTA)$/iu.test(fuel) ? "Nafta"
      : /^(EL|ELEKTŘINA|ELEKTRINA)$/iu.test(fuel) ? "Elektrina" : fuel;
    put("fuel", data.VozidloHybridni === "ANO" ? `${normalized} / hybrid` : normalized);
  }
  result.status = "found";
  return result;
}

export async function lookupRsv(query: VehicleQuery, options: { timeoutMs?: number } = {}): Promise<VehicleSourceResult> {
  const result = empty(new Date().toISOString());
  if (query.country !== "CZ" || query.kind !== "vin" || !isVin(query.value)) return { ...result, status: "unsupported" };
  const key = process.env.CZ_RSV_API_KEY?.trim();
  if (!key) return { ...result, status: "unsupported", warnings: ["Český register RSV nemá nastavený API kľúč."] };
  const url = new URL(ENDPOINT);
  url.searchParams.set("vin", query.value);
  try {
    const body = await providerText(url.toString(), { timeoutMs: Math.max(1, Math.min(options.timeoutMs ?? 9_000, 9_000)), headers: { API_KEY: key, Accept: "application/json" } });
    return parseRsv(JSON.parse(body), query, new Date().toISOString());
  } catch (error) {
    if (error instanceof ProviderHttpError) {
      if (error.status === 404) return { ...result, status: "not_found" };
      if (error.status === 429) return { ...result, status: "rate_limited" };
    }
    return result;
  }
}
