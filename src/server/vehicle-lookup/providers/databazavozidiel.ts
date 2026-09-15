import "server-only";
import { isSlovakPlate, isVin, normalizeVehicleIdentifier, vehicleText, type VehicleField, type VehicleQuery, type VehicleSourceResult } from "@/lib/vehicle-lookup";
import { ProviderHttpError, providerText } from "./http";
import { parseSlovakDate } from "./stkonline";

export const DATABAZA_VOZIDIEL_URL = "https://www.databazavozidiel.sk/api-dokumentacia/v3";
const ENDPOINT = "https://www.databazavozidiel.sk/api/vehicles";
type Row = Record<string, unknown>;
function row(value: unknown): Row | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined; }
function positive(value: unknown): string | undefined { return typeof value === "number" && Number.isFinite(value) && value > 0 ? vehicleText(value) : undefined; }
function text(value: unknown) { return typeof value === "string" ? vehicleText(value) : undefined; }
function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : undefined;
}
function empty(fetchedAt: string): VehicleSourceResult { return { source: "databazavozidiel", status: "unavailable", url: DATABAZA_VOZIDIEL_URL, fetchedAt, facts: {}, warnings: [] }; }

/** Official v3 allowlist. Raw documents, owner data and freeform records never leave the adapter. */
export function parseDatabazaVozidiel(payload: unknown, query: VehicleQuery, fetchedAt: string): VehicleSourceResult {
  const result = empty(fetchedAt);
  const envelope = row(payload), candidate = row(envelope?.vehicle);
  if (!candidate) return result;
  const vehicle: Row = candidate;
  const vin = normalizeVehicleIdentifier(text(vehicle.vin) ?? "");
  const plate = normalizeVehicleIdentifier(text(vehicle.ecv) ?? "");
  const validVin = isVin(vin), validPlate = isSlovakPlate(plate);
  // A plate lookup may bind a VIN only when BOTH identifiers are valid and the plate matches.
  if ((query.kind === "plate" && validPlate && plate !== query.value) || (query.kind === "vin" && validVin && vin !== query.value)) {
    return { ...result, status: "ambiguous", candidates: [{ ...(validVin ? { vin } : {}), ...(validPlate ? { plate } : {}) }], warnings: ["DatabázaVozidiel.sk vrátila iný identifikátor. Overte VIN v dokladoch."] };
  }
  if (!validVin || (query.kind === "plate" && !validPlate)) return result;
  function put(field: VehicleField, value: string | undefined) { if (value) result.facts[field] = { value, quality: "reported" }; }
  put("vin", vin);
  if (validPlate) put("plate", plate);
  const strings: Partial<Record<VehicleField, string>> = {
    make: "znacka", model: "obch_nazov", color: "farba", fuel: "druh_paliva", bodyType: "druh_karoserie",
    vehicleCategory: "kategoria", vehicleType: "druh_vozidla", vehicleTypeDesignation: "typ", typeVariantVersion: "typ_variant_verzia",
    manufacturer: "vyrobca_vozidla", engineManufacturer: "vyrobca_motora", engineNumber: "cislo_motora", emissionClass: "emisie_a_spotreba_es_ehk",
  };
  const numbers: Partial<Record<VehicleField, string>> = {
    engineCapacityCc: "objem", powerKw: "vykon", seats: "pocet_miest", transmissionGears: "pocet_stupnov", engineRpm: "otacky", maxSpeedKmh: "max_rychlost",
    curbWeightKg: "prevadzkova_hmotnost", grossWeightKg: "hmotnost", grossTrainWeightKg: "pripustna_hmotnost_supravy",
    trailerBrakedWeightKg: "najvacsia_pripustna_hmotnost_pripojneho_vozidla_brzdeneho", trailerUnbrakedWeightKg: "najvacsia_pripustna_hmotnost_pripojneho_vozidla_nebrzdeneho",
    lengthMm: "rozmery_celkove_dlzka", widthMm: "rozmery_celkove_sirka", heightMm: "rozmery_celkove_vyska",
  };
  for (const [field, key] of Object.entries(strings)) put(field as VehicleField, text(vehicle[key]));
  for (const [field, key] of Object.entries(numbers)) put(field as VehicleField, positive(vehicle[key]));
  const transmission = text(vehicle.prevodovka);
  put("transmission", transmission === "AT" ? "Automatická" : transmission === "MT" ? "Manuálna" : transmission);
  put("firstRegisteredAt", parseSlovakDate(text(vehicle.dat_prva_evid) ?? ""));
  put("firstRegisteredInSkAt", parseSlovakDate(text(vehicle.dat_prva_evid_sr) ?? ""));
  const axleCount = typeof vehicle.pocet_naprav === "number" && Number.isInteger(vehicle.pocet_naprav) && vehicle.pocet_naprav > 0 ? vehicle.pocet_naprav : undefined;
  if (axleCount) put("axleCount", positive(axleCount));
  const axes = [1, 2, 3, 4].filter(index => !axleCount || index <= axleCount);
  const driven = axes.filter(index => vehicle[`pohanana_naprava_${index}`] === true);
  if (driven.length) {
    const incomplete = !axleCount || axleCount > 4 || axes.some(index => typeof vehicle[`pohanana_naprava_${index}`] !== "boolean");
    put("drivenAxles", `${driven.map(index => `${index}. náprava`).join(", ")}${incomplete ? " (ostatné nezistené)" : ""}`);
  }
  function perAxle(field: VehicleField, prefix: string, format: (value: unknown) => string | undefined) {
    const values = axes.flatMap(index => { const value = format(vehicle[`${prefix}_${index}`]); return value ? [`${index}.: ${value}`] : []; });
    put(field, vehicleText(values.join("; ")));
  }
  perAxle("maxAxleWeightKg", "najvacsia_pripustna_hmotnost_pripadajuca_na_napravu", positive);
  perAxle("wheelbaseMm", "razvor", positive);
  perAxle("tireDimensions", "pneumatiky", value => {
    const tire = row(value); if (!tire) return undefined;
    const width = text(tire.sirka), height = text(tire.vyska), construction = text(tire.konstrukcia), diameter = text(tire.priemer_rafiku);
    if (!width || !height || !construction || !diameter) return undefined;
    return vehicleText(`${width}/${height} ${construction}${diameter} ${text(tire.index_nosnosti) ?? ""}${text(tire.rychlostny_index) ?? ""}`);
  });
  perAxle("rimDimensions", "rafiky", value => {
    const rim = row(value); if (!rim) return undefined;
    const width = text(rim.sirka), diameter = text(rim.priemer);
    if (!width || !diameter) return undefined;
    return vehicleText(`${width}${text(rim.tvar_patky) ?? ""} × ${diameter}${text(rim.zalis) ? ` ET ${text(rim.zalis)}` : ""}`);
  });
  put("towingDevice", vehicleText(["trieda", "typ", "znacka"].map(key => text(vehicle[`spajacie_zariadenie_${key}`])).filter(Boolean).join(" · ")));
  const inspections = row(envelope?.ektk);
  for (const [kind, label, at, until] of [["Tk", "TK", "technicalInspectionAt", "technicalInspectionValidUntil"], ["Ek", "EK", "emissionInspectionAt", "emissionInspectionValidUntil"]] as const) {
    const execution = isoDate(inspections?.[`km${kind}LastCheck`]), validity = isoDate(inspections?.[`km${kind}NextCheck`]);
    if (execution && execution <= query.checkedForDate) {
      put(at, execution);
      if (validity && validity >= execution) put(until, validity);
    } else if (validity) result.warnings.push(`${label}: zdroj uvádza termín bez nájdenej vykonanej kontroly. Platnosť preto nepreberáme.`);
  }
  result.status = "found";
  result.warnings.push("Údaje TK/EK sú z evidencie poskytovateľa; živé obnovenie sa nevyžaduje. Novú kontrolu overte podľa protokolu.");
  return result;
}

export async function lookupDatabazaVozidiel(query: VehicleQuery, options: { timeoutMs?: number } = {}): Promise<VehicleSourceResult> {
  const result = empty(new Date().toISOString());
  const key = process.env.DATABAZA_VOZIDIEL_API_KEY?.trim();
  if (!key) return { ...result, status: "unsupported", warnings: ["DatabázaVozidiel.sk nie je nakonfigurovaná."] };
  const url = new URL(ENDPOINT);
  url.searchParams.set(query.kind === "plate" ? "ecv" : "vin", query.value);
  url.searchParams.set("ek_tk_live", "false");
  try {
    const body = await providerText(url.toString(), { timeoutMs: options.timeoutMs, headers: { Authorization: `Bearer ${key}`, Version: "3", Accept: "application/json" } });
    return parseDatabazaVozidiel(JSON.parse(body), query, new Date().toISOString());
  } catch (error) {
    if (error instanceof ProviderHttpError) {
      if (error.status === 404) return { ...result, status: "not_found" };
      if (error.status === 429) return { ...result, status: "rate_limited", warnings: ["DatabázaVozidiel.sk hlási vyčerpanú API kvótu. Skontrolujte balík požiadaviek u poskytovateľa."] };
      if (error.status === 401 || error.status === 403) return { ...result, warnings: ["DatabázaVozidiel.sk odmietla API prístup. Správca musí skontrolovať kľúč a oprávnenia."] };
      if (error.status === 422) return { ...result, warnings: ["DatabázaVozidiel.sk neprijala zadaný identifikátor."] };
    }
    return result;
  }
}
