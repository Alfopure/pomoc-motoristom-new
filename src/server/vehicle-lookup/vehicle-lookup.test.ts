import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { emptyVehicleFieldPatch, lookupIdentityConflict, parseVehicleLookupInput, preferredVehicleFacts, resolveInternalVehicle, slovakToday, vehicleText, type VehicleLookupResult, type VehicleQuery } from "@/lib/vehicle-lookup";
import { parseSkp } from "./providers/skp";
import { parseStkOnline, parseSlovakDate } from "./providers/stkonline";
import { parseVpic } from "./providers/vpic";
import { parseHaka } from "./providers/haka";

const vin = "WVWZZZ1JZXW000001";
const date = "2026-09-05T08:00:00.000Z";
const query: VehicleQuery = { kind: "plate", value: "XX000XX", country: "SK", checkedForDate: "2026-09-05" };
const contract = { spz: query.value, vin, znackaVozidla: "ŠKODA", typVozidla: "NEUVEDENÝ", farbaVozidla: "ČIERNA", poistitel: "0007 Kooperativa" };
const skp = () => parseSkp({ ok: true, status: "POISTENÉ", zmluvy: [contract] }, query, date);
const result = (): VehicleLookupResult => ({ version: 1, id: "test", query, fetchedAt: date, sources: [skp()] });
const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/stkonline-${name}.html`, import.meta.url), "utf8");

describe("Slovak vehicle identity and proposals", () => {
  it("normalizes only separators, accepts European VIN without US checksum", () => {
    expect(parseVehicleLookupInput({ kind: "vin", value: "wvw zzz1jz-xw000001", country: "SK" }).query.value).toBe(vin);
    expect(() => parseVehicleLookupInput({ kind: "vin", value: "IIIIIIIIIIIIIIIII", country: "SK" })).toThrow();
    expect(() => parseVehicleLookupInput({ kind: "plate", value: "XX000XX", country: "CZ" })).toThrow();
    expect(() => parseVehicleLookupInput({ kind: "plate", value: "https://internal", country: "SK" })).toThrow();
    expect(() => parseVehicleLookupInput({ kind: "plate", value: "XX000XX", country: "SK", knownIdentity: { vin: "bad" } })).toThrow();
  });
  it("uses the Bratislava day across UTC midnight", () => expect(slovakToday(new Date("2026-09-05T22:30:00Z"))).toBe("2026-09-06"));
  it("does not treat missing/other model sentinels as data", () => {
    for (const value of ["NEUVEDENÝ", "NEUVEDENÁ", "OSTATNÉ", "", "—", null]) expect(vehicleText(value)).toBeUndefined();
  });
  it("preserves existing fields and offers only blank fields", () => {
    expect(emptyVehicleFieldPatch(result(), { plate: query.value, vin: "", make: "Ručná značka", model: "", color: "" })).toEqual({ vin, color: "ČIERNA" });
    expect(lookupIdentityConflict(result(), { vin: "WVWZZZ1JZXW000002" })).toBeTruthy();
  });
  it("checks the query even if vPIC returns no identifier facts", () => {
    const partial = { ...result(), query: { ...query, kind: "vin" as const, value: vin }, sources: [parseVpic({ Results: [{ ErrorCode: "4,14", Make: "TESLA", Model: "Model 3" }] }, date)] };
    expect(lookupIdentityConflict(partial, { vin: "WVWZZZ1JZXW000002" })).toBeTruthy();
    expect(lookupIdentityConflict(partial, { vin: "" })).toBeTruthy();
  });
  it("blocks cross-provider VIN disagreement and duplicate Commander candidates", () => {
    const other = parseStkOnline(fixture("skoda").replaceAll(vin, "WVWZZZ1JZXW000002"), query, date);
    expect(lookupIdentityConflict({ ...result(), sources: [skp(), other] }, {})).toBeTruthy();
    const candidate = { licensePlate: "XX000XX", vin, country: "SK" };
    expect(resolveInternalVehicle([candidate, candidate], query.value, "")).toBeUndefined();
    expect(resolveInternalVehicle([{ ...candidate, country: undefined }], query.value, "")).toBeUndefined();
    expect(resolveInternalVehicle([candidate], query.value, vin)).toBe(candidate);
  });
});

describe("observed provider contracts", () => {
  it("SKP provides current PZP, not an expiry or a missing model", () => {
    expect(skp().facts).toMatchObject({ vin: { value: vin }, insuranceStatus: { value: "Poistené" }, insurer: { value: "0007 Kooperativa" } });
    expect(skp().facts.model).toBeUndefined();
    expect(skp().facts).not.toHaveProperty("insuranceValidUntil");
  });
  it("SKP never silently takes the first vehicle or negative state on malformed/empty/challenge", () => {
    expect(parseSkp({ ok: true, status: "POISTENÉ", zmluvy: [contract, { ...contract, vin: "WVWZZZ1JZXW000002" }] }, query, date).status).toBe("ambiguous");
    expect(parseSkp({ ok: false, message: "captcha verification failed" }, query, date).status).toBe("challenge_required");
    expect(parseSkp({ ok: true, status: "NEZNÁME", zmluvy: [] }, query, date).status).toBe("not_found");
    expect(parseSkp({ ok: true, status: "NEPOISTENÉ", zmluvy: [contract] }, query, date).facts.insuranceStatus).toBeUndefined();
    expect(parseSkp({ ok: true, zmluvy: "changed schema" }, query, date).status).toBe("unavailable");
  });
  it.each(["tesla", "skoda", "bmw", "ford"])("parses the freely visible %s markup without paid facts", (name) => {
    const parsed = parseStkOnline(fixture(name), query, date);
    expect(parsed.status).toBe("found"); expect(parsed.facts.vin?.value).toBe(vin);
    expect(parsed.facts.model?.value).toBeTruthy(); expect(parsed.facts.fuel?.value).toBeTruthy();
    expect(parsed.facts).not.toHaveProperty("firstRegisteredAt");
  });
  it("requires an executed TK/EK before accepting validity", () => {
    expect(parseStkOnline(fixture("skoda"), query, date).facts.technicalInspectionValidUntil?.value).toBe("2027-09-08");
    expect(parseStkOnline(fixture("skoda"), query, date).facts.emissionInspectionValidUntil?.value).toBe("2027-09-08");
    expect(parseStkOnline(fixture("tesla"), query, date).facts.emissionInspectionValidUntil).toBeUndefined();
    const ford = parseStkOnline(fixture("ford"), query, date);
    expect(ford.facts.technicalInspectionValidUntil).toBeUndefined(); expect(ford.facts.emissionInspectionValidUntil).toBeUndefined();
  });
  it("requires exact STK identity and explicit not-found page", () => {
    expect(parseStkOnline(fixture("skoda"), { ...query, value: "XX000XY" }, date).status).toBe("ambiguous");
    expect(parseStkOnline('<h4 class="alert alert-danger">Vozidlo s uvedeným VIN číslom sa v databáze nenachádza!</h4>', query, date).status).toBe("not_found");
    expect(parseStkOnline("<html><h1>Unexpected error</h1></html>", query, date).status).toBe("unavailable");
    expect(parseSlovakDate("31.2.2027")).toBeUndefined();
  });
  it("keeps partial vPIC opt-in, model year separate, and never adopts suggested VIN or weight class", () => {
    const parsed = parseVpic({ Results: [{ ErrorCode: "4,14", Make: "TESLA", Model: "Model 3", ModelYear: "2019", GVWR: "Class 1", SuggestedVIN: "WRONG", FuelTypePrimary: "Electric" }] }, date);
    expect(parsed.facts.model?.quality).toBe("partial");
    expect(parsed.facts.modelYear?.value).toBe("2019"); expect(parsed.facts).not.toHaveProperty("productionYear");
    expect(parsed.facts).not.toHaveProperty("vin"); expect(parsed.facts).not.toHaveProperty("weightKg");
    const combined = { ...result(), sources: [skp(), parsed] };
    expect(preferredVehicleFacts(combined).model).toBeUndefined();
    expect(preferredVehicleFacts(combined, true).model?.value).toBe("Model 3");
  });
  it("HAKA ignores query reflection, reports only exact article matches and omits personal text", () => {
    const page = `<input name="keyword" value="XX000XX"><div class="list news"><div class="article"><a href="/kradeze-automobilov/prispevok/123"><div class="text"><p>TEČ ( ŠPZ ) : XX000XX\nVIN : ${vin}\nKontakt: PRIVATE PHONE</p></div></a></div></div>`;
    const parsed = parseHaka(page, query, date);
    expect(parsed.status).toBe("found"); expect(parsed.reports).toHaveLength(1);
    expect(JSON.stringify(parsed)).not.toContain("PRIVATE");
    expect(parseHaka('<input name="keyword" value="XX000XX"><div class="list news"></div>', query, date).status).toBe("not_found");
    expect(parseHaka(page.replace("TEČ ( ŠPZ ) : XX000XX", "TEČ ( ŠPZ ) : XX000XY"), query, date).status).toBe("unavailable");
  });
});
