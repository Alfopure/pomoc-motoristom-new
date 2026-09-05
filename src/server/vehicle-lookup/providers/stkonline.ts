import { load } from "cheerio";
import { isVin, normalizeVehicleIdentifier, vehicleText, type VehicleField, type VehicleQuery, type VehicleSourceResult } from "@/lib/vehicle-lookup";

export function stkOnlineUrl(query: VehicleQuery) { return `https://www.stkonline.sk/${query.kind === "plate" ? "spz" : "vin"}/${encodeURIComponent(query.value)}`; }
export function parseSlovakDate(value: string): string | undefined {
  const match = value.trim().match(/^(\d{1,2})\.\s*(\d{1,2})\.\s*((?:19|20)\d{2})$/);
  if (!match) return undefined;
  const [, day, month, year] = match;
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : undefined;
}

export function parseStkOnline(html: string, query: VehicleQuery, fetchedAt: string): VehicleSourceResult {
  const result: VehicleSourceResult = { source: "stkonline", status: "unavailable", url: stkOnlineUrl(query), fetchedAt, facts: {}, warnings: [] };
  const $ = load(html);
  if (!$("#check").length) {
    if (/captcha|challenge-platform|turnstile/i.test(html)) result.status = "challenge_required";
    else if (/Vozidlo .*sa v databáze nenachádza/i.test($("h4.alert.alert-danger").text())) result.status = "not_found";
    return result;
  }
  const map: Record<string, VehicleField> = { "Evidenčné číslo": "plate", VIN: "vin", "Značka vozidla": "make", Model: "model", Farba: "color", Palivo: "fuel" };
  $("#check span.label").each((_, element) => {
    const label = $(element);
    if (label.closest("#vehicle-detail").length) return;
    const field = map[label.text().trim()];
    const target = label.next();
    if (!field || target.find('.icon-lock,[data-target="#PaymentModal"]').length) return;
    const value = vehicleText(target.text());
    if (value) result.facts[field] = { value, quality: "reported" };
  });
  const vin = normalizeVehicleIdentifier(result.facts.vin?.value ?? "");
  const plate = normalizeVehicleIdentifier(result.facts.plate?.value ?? "");
  if (!isVin(vin)) return { ...result, facts: {} };
  if ((query.kind === "vin" ? vin : plate) !== query.value) return { ...result, status: "ambiguous", facts: {}, candidates: [{ vin, plate }] };
  result.facts.vin = { value: vin, quality: "reported" };
  if (plate) result.facts.plate = { value: plate, quality: "reported" };
  result.status = "found";
  result.warnings.push("Údaje STKonline môžu mať oneskorenú aktualizáciu. Dátumy kontrol sú údajom tohto zdroja.");
  const inspections: Record<string, string> = {};
  $("#stk span.label").each((_, element) => {
    const target = $(element).next();
    if (!target.find('.icon-lock,[data-target="#PaymentModal"]').length) inspections[$(element).text().trim()] = target.text().trim();
  });
  for (const [kind, at, until] of [["TK", "technicalInspectionAt", "technicalInspectionValidUntil"], ["EK", "emissionInspectionAt", "emissionInspectionValidUntil"]] as const) {
    const execution = parseSlovakDate(inspections[`Dátum vykonania ${kind}`] ?? "");
    const validity = parseSlovakDate(inspections[`Termín platnosti ${kind}`] ?? "");
    if (execution && execution <= query.checkedForDate) {
      result.facts[at] = { value: execution, quality: "reported" };
      if (validity && validity >= execution) result.facts[until] = { value: validity, quality: "reported" };
    } else if (validity) result.warnings.push(`${kind}: zdroj uvádza termín bez nájdenej vykonanej kontroly. Platnosť preto nepreberáme.`);
  }
  return result;
}
