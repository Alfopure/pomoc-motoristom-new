import "server-only";
import { randomUUID } from "node:crypto";
import { lookupIdentityConflict, preferredVehicleFacts, type VehicleLookupResult, type VehicleQuery, type VehicleSource, type VehicleSourceResult } from "@/lib/vehicle-lookup";
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
  const httpTimeout = Math.max(1, Math.min(9_000, deadline - Date.now()));
  const sources = await Promise.all([
    sourceResult("skp", SKP_URL, enabled.skp, async () => (await import("./providers/skp-browser")).lookupSkp(query, deadline)),
    sourceResult("stkonline", stkOnlineUrl(query), enabled.stkonline, async () => parseStkOnline(await providerText(stkOnlineUrl(query), { headers: STK_HEADERS, timeoutMs: httpTimeout }), query, new Date().toISOString())),
    sourceResult("haka", hakaUrl(query), enabled.haka, async () => parseHaka(await providerText(hakaUrl(query), { timeoutMs: httpTimeout }), query, new Date().toISOString())),
  ]);
  const result: VehicleLookupResult = { version: 1, id: randomUUID(), query, fetchedAt: new Date().toISOString(), sources };
  const vin = query.kind === "vin" ? query.value : !lookupIdentityConflict(result, {}) ? preferredVehicleFacts(result).vin?.value : undefined;
  if (vin && enabled.vpic && Date.now() < deadline) sources.push(await sourceResult("vpic", "https://vpic.nhtsa.dot.gov/api/", true, async () => parseVpic(JSON.parse(await providerText(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`, { timeoutMs: Math.max(1, Math.min(5_000, deadline - Date.now())) })), new Date().toISOString())));
  return result;
}
