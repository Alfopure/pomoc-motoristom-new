import { expect, it } from "vitest";
import { emptyVehicleFieldPatch, hakaReportMatch, vehicleFactConflicts, type VehicleLookupResult } from "./vehicle-lookup";
import { parseHaka } from "@/server/vehicle-lookup/providers/haka";

const vin = "WVWZZZ1JZXW000001";
const plate = "XX000XX";
const time = "2026-09-05T08:00:00Z";
const result: VehicleLookupResult = { version: 1, id: "test", query: { kind: "plate", value: plate, country: "SK", checkedForDate: "2026-09-05" }, fetchedAt: time, sources: [
  { source: "skp", status: "found", url: "https://www.skp.sk/", fetchedAt: time, warnings: [], facts: { vin: { value: vin, quality: "reported" }, make: { value: "ŠKODA", quality: "reported" } } },
  { source: "stkonline", status: "found", url: "https://www.stkonline.sk/", fetchedAt: time, warnings: [], facts: { vin: { value: vin, quality: "reported" }, make: { value: "VOLKSWAGEN", quality: "reported" } } },
] };

it("requires a source choice for a conflicting blank field and preserves manual values", () => {
  expect(vehicleFactConflicts(result).make).toHaveLength(2);
  expect(emptyVehicleFieldPatch(result, { make: "", vin: "" })).toEqual({ vin });
  expect(emptyVehicleFieldPatch(result, { make: "" }, false, { make: "stkonline" })).toEqual({ make: "VOLKSWAGEN" });
  expect(emptyVehicleFieldPatch(result, { make: "Manual" }, false, { make: "stkonline" })).toEqual({});
  expect(emptyVehicleFieldPatch(result, { make: "" }, false, { make: "haka" })).toEqual({});
});
it("ignores equivalent spelling and fuel translations, but requires opt-in for partial disagreements", () => {
  const equivalent = structuredClone(result);
  equivalent.sources[1].facts.make!.value = " skoda ";
  equivalent.sources[0].facts.fuel = { value: "ELEKTRINA", quality: "reported" };
  equivalent.sources[1].facts.fuel = { value: "Electric", quality: "decoded" };
  expect(vehicleFactConflicts(equivalent)).toEqual({});
  const partial = structuredClone(result);
  partial.sources[1].facts.make!.quality = "partial";
  expect(vehicleFactConflicts(partial)).toEqual({});
  expect(vehicleFactConflicts(partial, true).make).toHaveLength(2);
  expect(emptyVehicleFieldPatch(partial, { make: "" }, false, { make: "stkonline" })).toEqual({ make: "ŠKODA" });
});
it("retains HAKA identity and flags a different VIN on the same plate without adopting it", () => {
  const otherVin = "WVWZZZ1JZXW000002";
  const html = `<input name="keyword" value="${plate}"><div class="list news"><div class="article"><a href="/kradeze-automobilov/prispevok/123"><div class="text"><p>TEČ ( ŠPZ ) : ${plate}\nVIN : ${otherVin}\nKontakt: OMIT</p></div></a></div></div>`;
  const haka = parseHaka(html, result.query, time);
  expect(haka.reports?.[0].identity).toEqual({ plate, vin: otherVin });
  expect(hakaReportMatch(haka.reports![0], result, { plate, vin })).toBe("conflict");
  expect(haka.facts).toEqual({});
  expect(JSON.stringify(haka)).not.toContain("OMIT");
});
it("distinguishes VIN match, plate-only match and older reports without identity", () => {
  const report = { url: "https://www.hakasystem.eu/kradeze-automobilov/prispevok/123", title: "HAKA" };
  expect(hakaReportMatch({ ...report, identity: { vin, plate: "XX000XY" } }, result, { plate, vin })).toBe("vin");
  expect(hakaReportMatch({ ...report, identity: { plate } }, result, { plate, vin })).toBe("plate");
  expect(hakaReportMatch(report, result, { plate, vin })).toBe("unverified");
  expect(hakaReportMatch({ ...report, identity: { vin: "WVWZZZ1JZXW000002", plate } }, { ...result, sources: [] }, { vin })).toBe("conflict");
});
