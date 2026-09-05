import { load } from "cheerio";
import { normalizeVehicleIdentifier, type VehicleQuery, type VehicleSourceResult } from "@/lib/vehicle-lookup";

export function hakaUrl(query: VehicleQuery) { return `https://www.hakasystem.eu/kradeze-automobilov?keyword=${encodeURIComponent(query.value)}`; }
export function parseHaka(html: string, query: VehicleQuery, fetchedAt: string): VehicleSourceResult {
  const result: VehicleSourceResult = { source: "haka", status: "unavailable", url: hakaUrl(query), fetchedAt, facts: {}, warnings: [], reports: [] };
  const $ = load(html);
  // The reflected query is not proof of a vehicle hit. Inspect individual reports.
  if ($('input[name="keyword"]').attr("value") !== query.value || !$(".list.news").length) return result;
  let unverifiedArticles = false;
  $(".list.news .article").each((_, element) => {
    const article = $(element);
    const path = article.find("a").first().attr("href") ?? "";
    if (!/^\/kradeze-automobilov\/prispevok\/\d+$/.test(path)) { unverifiedArticles = true; return; }
    const content = article.find(".text p").text();
    const vin = content.match(/\bVIN\s*:\s*([A-HJ-NPR-Z0-9]{17})\b/i)?.[1];
    const plate = content.match(/(?:TEČ\s*\(\s*ŠPZ\s*\)|EČV|ŠPZ)\s*:\s*([A-Z0-9 -]{5,12})(?:\r?\n|$)/i)?.[1];
    const identifier = query.kind === "vin" ? vin : plate;
    if (identifier && normalizeVehicleIdentifier(identifier) === query.value) {
      // Do not copy free-form report text, people, phone numbers or contact details.
      result.reports!.push({ url: `https://www.hakasystem.eu${path}`, title: "Hlásenie vozidla v HAKA" });
    } else unverifiedArticles = true;
  });
  result.status = result.reports!.length ? "found" : unverifiedArticles ? "unavailable" : "not_found";
  result.reports = result.reports!.slice(0, 10);
  result.warnings = [result.status === "found" ? "HAKA obsahuje hlásenie k identifikátoru. Otvorte článok a overte jeho aktuálny stav; nejde o policajný register." : "Nenájdené hlásenie nepotvrdzuje, že vozidlo nie je odcudzené."];
  return result;
}
