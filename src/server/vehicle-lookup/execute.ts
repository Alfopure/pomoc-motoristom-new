import "server-only";
import { randomUUID } from "node:crypto";
import { isVin, lookupIdentityConflict, normalizeVehicleIdentifier, preferredVehicleFacts, type VehicleLookupResult, type VehicleQuery, type VehicleSource, type VehicleSourceResult } from "@/lib/vehicle-lookup";
import { SKP_URL } from "./providers/skp";
import { parseStkOnline, stkOnlineUrl } from "./providers/stkonline";
import { hakaUrl, parseHaka } from "./providers/haka";
import { parseVpic } from "./providers/vpic";
import { ProviderHttpError, providerText } from "./providers/http";

export type LookupProviders = { skp: boolean; stkonline: boolean; haka: boolean; vpic: boolean };
const STK_HEADERS = { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.0.0 Safari/537.36", Accept: "text/html", "Accept-Language": "sk-SK,sk;q=0.9" };
async function sourceResult(source: VehicleSource, url: string, enabled: boolean, task: () => Promise<VehicleSourceResult>): Promise<VehicleSourceResult> {
  const started = Date.now();
  let result: VehicleSourceResult;
  try { result = enabled ? await task() : { source, url, status: "unsupported", fetchedAt: new Date().toISOString(), facts: {}, warnings: ["Automatický zdroj je momentálne vypnutý."] }; }
  catch (error) { result = { source, url, status: error instanceof ProviderHttpError && error.status === 429 ? "rate_limited" : "unavailable", fetchedAt: new Date().toISOString(), facts: {}, warnings: [] }; }
  console.info("vehicle_lookup_source", { source, status: result.status, elapsedMs: Date.now() - started, fieldCount: Object.keys(result.facts).length });
  return result;
}
export async function executeVehicleLookup(query: VehicleQuery, enabled: LookupProviders, deadline = Date.now() + 40_000): Promise<VehicleLookupResult> {
  if (Date.now() >= deadline) throw new Error("lookup_deadline");
  const httpTimeout = remainingTimeout(deadline, 9_000);
  const haka = sourceResult("haka", hakaUrl(query), enabled.haka, async () => parseHaka(await providerText(hakaUrl(query), { timeoutMs: httpTimeout }), query, new Date().toISOString()));
  // STK can establish the plate → VIN binding before we ask SKP.
  // A VIN entered alongside a plate is only a conflict check at the route boundary.
  const sources = [await sourceResult("stkonline", stkOnlineUrl(query), enabled.stkonline, async () => parseStkOnline(await providerText(stkOnlineUrl(query), { headers: STK_HEADERS, timeoutMs: httpTimeout }), query, new Date().toISOString()))];
  const result: VehicleLookupResult = { version: 1, id: randomUUID(), query, fetchedAt: new Date().toISOString(), sources };
  const resolvedVin = verifiedVin(result);
  const insuranceQuery: VehicleQuery = resolvedVin ? { ...query, kind: "vin", value: resolvedVin } : query;
  let insurance = await insuranceResult(insuranceQuery, enabled.skp, deadline);
  // An empty VIN result can still have a contract under the current plate. A
  // timeout, challenge, or ambiguous response must not trigger another attempt.
  if (query.kind === "plate" && insuranceQuery.kind === "vin" && insurance.status === "not_found" && Date.now() < deadline) {
    const fallback = await insuranceResult(query, enabled.skp, deadline);
    insurance = { ...fallback, warnings: [`SKP nenašlo zmluvu podľa VIN ${insuranceQuery.value}; následne sme overili EČV ${query.value}.`, ...fallback.warnings] };
  }
  sources.push(insurance, await haka);
  const vin = verifiedVin(result);
  if (vin && enabled.vpic && Date.now() < deadline) sources.push(await sourceResult("vpic", "https://vpic.nhtsa.dot.gov/api/", true, async () => parseVpic(JSON.parse(await providerText(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`, { timeoutMs: remainingTimeout(deadline, 5_000) })), new Date().toISOString())));
  return result;
}

function remainingTimeout(deadline: number, maximum: number) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("lookup_deadline");
  return Math.min(maximum, remaining);
}

function verifiedVin(result: VehicleLookupResult): string | undefined {
  if (result.query.kind === "vin") return result.query.value;
  if (lookupIdentityConflict(result, {})) return undefined;
  const vin = normalizeVehicleIdentifier(preferredVehicleFacts(result).vin?.value ?? "");
  return isVin(vin) ? vin : undefined;
}

async function insuranceResult(query: VehicleQuery, enabled: boolean, deadline: number) {
  const result = await sourceResult("skp", SKP_URL, enabled, async () => {
    remainingTimeout(deadline, 25_000);
    const { lookupSkp } = await import("./providers/skp-browser");
    remainingTimeout(deadline, 25_000);
    return lookupSkp(query, deadline);
  });
  return enabled ? { ...result, warnings: [`Overenie PZP podľa ${query.kind === "vin" ? "VIN" : "EČV"}: ${query.value}.`, ...result.warnings] } : result;
}
