import type { VehicleQuery, VehicleSourceResult } from "@/lib/vehicle-lookup";
import { isVin, normalizeVehicleIdentifier, vehicleText } from "@/lib/vehicle-lookup";

export const SKP_URL = "https://www.skp.sk/vyhladat-poistovatela-vozidla-a-overit-platnost-pzp/";
export function parseSkp(json: unknown, query: VehicleQuery, fetchedAt: string): VehicleSourceResult {
  const base: VehicleSourceResult = { source: "skp", status: "unavailable", url: SKP_URL, fetchedAt, facts: {}, warnings: [] };
  if (!json || typeof json !== "object") return base;
  const data = json as Record<string, unknown>;
  if (data.ok !== true) {
    if (/captcha|robot|challenge/i.test(JSON.stringify(data))) base.status = "challenge_required";
    return base;
  }
  if (!Array.isArray(data.zmluvy) || typeof data.status !== "string") return base;
  const rows = data.zmluvy.filter((row): row is Record<string, unknown> => row !== null && typeof row === "object");
  if (!rows.length) return { ...base, status: "not_found", warnings: ["SKP nevrátilo zmluvu. Bez jednoznačného výsledku nepotvrdzujeme nepoistenie."] };
  const identities = rows.map((row) => ({ vin: normalizeVehicleIdentifier(String(row.vin ?? "")), plate: normalizeVehicleIdentifier(String(row.spz ?? "")) }));
  // A plate lookup can identify a policy even when SKP does not return a VIN.
  // A provided VIN must still be valid; VIN lookups always require its exact match.
  if (identities.some((identity) => (identity.vin && !isVin(identity.vin)) || identity[query.kind] !== query.value) || new Set(identities.map((identity) => `${identity.vin}:${identity.plate}`)).size !== 1) return { ...base, status: "ambiguous", candidates: identities, warnings: ["Údaje PZP sa nedoplnili, pretože SKP nepotvrdilo zadané EČV alebo VIN jednoznačne."] };
  base.status = "found";
  const map = { spz: "plate", vin: "vin", znackaVozidla: "make", typVozidla: "model", farbaVozidla: "color", poistitel: "insurer" } as const;
  for (const [key, field] of Object.entries(map)) {
    const values = [...new Set(rows.map((row) => vehicleText(row[key])).filter((v): v is string => Boolean(v)))];
    if (values.length === 1) base.facts[field] = { value: field === "vin" || field === "plate" ? normalizeVehicleIdentifier(values[0]) : values[0], quality: "reported" };
    else if (values.length > 1) base.warnings.push(`SKP uvádza viac hodnôt pre ${field}; pole nebolo doplnené.`);
  }
  // Only documented observed success is mapped. New status words fail closed.
  if (data.status === "POISTENÉ") base.facts.insuranceStatus = { value: "Poistené", quality: "reported" };
  else base.warnings.push("SKP nevrátilo potvrdený poistný stav; skontrolujte zdroj.");
  return base;
}
