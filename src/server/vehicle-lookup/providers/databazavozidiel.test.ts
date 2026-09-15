import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VehicleQuery } from "@/lib/vehicle-lookup";
import { DATABAZA_VOZIDIEL_URL, lookupDatabazaVozidiel, parseDatabazaVozidiel } from "./databazavozidiel";

const query: VehicleQuery = { kind: "plate", value: "XX000XX", country: "SK", checkedForDate: "2026-09-15" };
const vin = "WVWZZZ1JZXW000001";
const otherVin = "WVWZZZ1JZXW000002";
const fetchedAt = "2026-09-15T09:00:00Z";
const serverKey = "synthetic-private-api-key";
function payload(vehicle: Record<string, unknown> = {}, ektk?: Record<string, unknown>) {
  return { vehicle: { ecv: query.value, vin, ...vehicle }, ...(ektk ? { ektk } : {}) };
}
function parse(vehicle: Record<string, unknown> = {}, ektk?: Record<string, unknown>) {
  return parseDatabazaVozidiel(payload(vehicle, ektk), query, fetchedAt);
}

describe("DatabázaVozidiel v3 response contract", () => {
  it("maps documented technical fields without conflating engine number, type and weight categories", () => {
    const result = parse({
      znacka: "TEST", obch_nazov: "MODEL", farba: "Biela", druh_paliva: "Nafta", druh_karoserie: "Kombi",
      kategoria: "M1", druh_vozidla: "osobné vozidlo", typ: "ABC", typ_variant_verzia: "ABC/V1/X2",
      vyrobca_vozidla: "Test manufacturer", vyrobca_motora: "Test engine maker", cislo_motora: "ENG123",
      emisie_a_spotreba_es_ehk: "715/2007", prevodovka: "AT", objem: 1998, vykon: 110.5, pocet_miest: 5,
      pocet_stupnov: 6, otacky: 4000, max_rychlost: 190, prevadzkova_hmotnost: 1550, hmotnost: 2100,
      pripustna_hmotnost_supravy: 3500, najvacsia_pripustna_hmotnost_pripojneho_vozidla_brzdeneho: 1400,
      najvacsia_pripustna_hmotnost_pripojneho_vozidla_nebrzdeneho: 650,
      rozmery_celkove_dlzka: 4500, rozmery_celkove_sirka: 1800, rozmery_celkove_vyska: 1500,
      dat_prva_evid: "12.01.2011", dat_prva_evid_sr: "15.02.2013",
    });
    expect(result).toMatchObject({ source: "databazavozidiel", status: "found", fetchedAt, url: DATABAZA_VOZIDIEL_URL });
    expect(Object.fromEntries(Object.entries(result.facts).map(([field, fact]) => [field, fact.value]))).toEqual({
      vin, plate: query.value, make: "TEST", model: "MODEL", color: "Biela", fuel: "Nafta", bodyType: "Kombi",
      vehicleCategory: "M1", vehicleType: "osobné vozidlo", vehicleTypeDesignation: "ABC", typeVariantVersion: "ABC/V1/X2",
      manufacturer: "Test manufacturer", engineManufacturer: "Test engine maker", engineNumber: "ENG123", emissionClass: "715/2007",
      transmission: "Automatická", engineCapacityCc: "1998", powerKw: "110.5", seats: "5", transmissionGears: "6",
      engineRpm: "4000", maxSpeedKmh: "190", curbWeightKg: "1550", grossWeightKg: "2100", grossTrainWeightKg: "3500",
      trailerBrakedWeightKg: "1400", trailerUnbrakedWeightKg: "650", lengthMm: "4500", widthMm: "1800", heightMm: "1500",
      firstRegisteredAt: "2011-01-12", firstRegisteredInSkAt: "2013-02-15",
    });
    expect(Object.values(result.facts).every(fact => fact.quality === "reported")).toBe(true);
    expect(result.facts).not.toHaveProperty("engineType");
    expect(result.facts).not.toHaveProperty("modelYear");
  });

  it("normalizes matching identifiers before binding an EČV to a VIN", () => {
    expect(parse({ ecv: " xx-000 xx ", vin: " wvwzzz1jzxw000001 " })).toMatchObject({
      status: "found", facts: { plate: { value: query.value }, vin: { value: vin } },
    });
  });

  it.each([
    { ecv: "YY000YY", vin },
    { ecv: "YY000YY", vin: null },
  ])("never binds a different returned plate: %j", (vehicle) => {
    const result = parse(vehicle);
    expect(result.status).toBe("ambiguous");
    expect(result.facts).toEqual({});
    expect(result.candidates?.[0].plate).toBe("YY000YY");
  });

  it("rejects a different VIN for a VIN lookup even if the plate matches", () => {
    const result = parseDatabazaVozidiel(payload({ vin: otherVin }), { ...query, kind: "vin", value: vin }, fetchedAt);
    expect(result).toMatchObject({ status: "ambiguous", facts: {}, candidates: [{ vin: otherVin, plate: query.value }] });
  });

  it.each([
    { ecv: null }, { ecv: "?" }, { vin: null }, { vin: "invalid" }, { vin: "WVWZZZ1JZXW00000I" },
  ])("requires both valid identifiers for a plate lookup: %j", (vehicle) => {
    expect(parse(vehicle)).toMatchObject({ status: "unavailable", facts: {} });
  });

  it("accepts an exact VIN response without inventing a missing plate", () => {
    const result = parseDatabazaVozidiel(payload({ ecv: null }), { ...query, kind: "vin", value: vin }, fetchedAt);
    expect(result).toMatchObject({ status: "found", facts: { vin: { value: vin } } });
    expect(result.facts.plate).toBeUndefined();
  });

  it.each([null, [], {}, { vehicle: [] }, { vehicle: null }, { vehicle: "invalid" }, { message: "Not Found" }])("treats malformed success bodies as unavailable: %j", (body) => {
    expect(parseDatabazaVozidiel(body, query, fetchedAt)).toMatchObject({ status: "unavailable", facts: {} });
  });

  it.each([0, -1, null, "0", "1500", false, NaN, Infinity])("does not turn unknown or invalid numeric data into technical facts: %s", (value) => {
    const result = parse({ objem: value, vykon: value, prevadzkova_hmotnost: value, pocet_naprav: value });
    expect(result.facts.engineCapacityCc).toBeUndefined();
    expect(result.facts.powerKw).toBeUndefined();
    expect(result.facts.curbWeightKg).toBeUndefined();
    expect(result.facts.axleCount).toBeUndefined();
  });

  it.each(["", "NEUVEDENÉ", "N/A", "unknown", "x".repeat(181)])("ignores absent, sentinel and oversized textual values: %s", (value) => {
    expect(parse({ farba: value, druh_paliva: value }).facts).toEqual({ vin: { value: vin, quality: "reported" }, plate: { value: query.value, quality: "reported" } });
  });

  it.each([["AT", "Automatická"], ["MT", "Manuálna"], ["CVT", "CVT"]])("normalizes only understood transmission code %s", (raw, expected) => {
    expect(parse({ prevodovka: raw }).facts.transmission?.value).toBe(expected);
  });

  it("displays exact driven axle numbers and separate axle weights", () => {
    const result = parse({
      pocet_naprav: 3, pohanana_naprava_1: false, pohanana_naprava_2: true, pohanana_naprava_3: true,
      najvacsia_pripustna_hmotnost_pripadajuca_na_napravu_1: 4000,
      najvacsia_pripustna_hmotnost_pripadajuca_na_napravu_2: 6000,
      najvacsia_pripustna_hmotnost_pripadajuca_na_napravu_3: 6000,
      najvacsia_pripustna_hmotnost_pripadajuca_na_napravu_4: 9999,
    });
    expect(result.facts.drivenAxles?.value).toBe("2. náprava, 3. náprava");
    expect(result.facts.maxAxleWeightKg?.value).toBe("1.: 4000; 2.: 6000; 3.: 6000");
  });

  it.each([
    { pocet_naprav: 2, pohanana_naprava_1: true },
    { pohanana_naprava_1: true, pohanana_naprava_2: false, pohanana_naprava_3: false, pohanana_naprava_4: false },
    { pocet_naprav: 5, pohanana_naprava_1: true, pohanana_naprava_2: false, pohanana_naprava_3: false, pohanana_naprava_4: false },
  ])("marks incomplete driven axle data without guessing front/rear/all-wheel drive", (vehicle) => {
    expect(parse(vehicle).facts.drivenAxles?.value).toBe("1. náprava (ostatné nezistené)");
  });

  it.each([
    { pocet_naprav: 2, pohanana_naprava_1: false, pohanana_naprava_2: false },
    { pocet_naprav: 2, pohanana_naprava_1: "true", pohanana_naprava_2: 1 },
  ])("does not infer driven axles from false or non-boolean flags", (vehicle) => {
    expect(parse(vehicle).facts.drivenAxles).toBeUndefined();
  });

  it("formats documented structured tires, rims and towing data without serializing objects", () => {
    const result = parse({
      pocet_naprav: 2, razvor_1: 2800, razvor_2: null,
      pneumatiky_1: { sirka: "225", vyska: "65", konstrukcia: "R", priemer_rafiku: "17", index_nosnosti: "102", rychlostny_index: "H" },
      pneumatiky_2: { sirka: "225" },
      rafiky_1: { sirka: "6.5", tvar_patky: "J", priemer: "17", zalis: "40" },
      rafiky_2: null, spajacie_zariadenie_trieda: "A50-X", spajacie_zariadenie_typ: "Test", spajacie_zariadenie_znacka: "Maker",
    });
    expect(result.facts).toMatchObject({
      wheelbaseMm: { value: "1.: 2800" }, tireDimensions: { value: "1.: 225/65 R17 102H" },
      rimDimensions: { value: "1.: 6.5J × 17 ET 40" }, towingDevice: { value: "A50-X · Test · Maker" },
    });
  });

  it("copies inspection dates only with a performed inspection and coherent expiry", () => {
    const result = parse({}, { kmTkLastCheck: "2026-01-10", kmTkNextCheck: "2028-01-10", kmEkLastCheck: "2024-02-29", kmEkNextCheck: "2026-02-28" });
    expect(result.facts).toMatchObject({
      technicalInspectionAt: { value: "2026-01-10" }, technicalInspectionValidUntil: { value: "2028-01-10" },
      emissionInspectionAt: { value: "2024-02-29" }, emissionInspectionValidUntil: { value: "2026-02-28" },
    });
  });

  it.each([null, "2026-02-29", "2026-09-16", "10.01.2026"])("does not assert validity with missing, malformed or future execution %s", (lastCheck) => {
    const result = parse({}, { kmTkLastCheck: lastCheck, kmTkNextCheck: "2028-01-10" });
    expect(result.facts.technicalInspectionAt).toBeUndefined();
    expect(result.facts.technicalInspectionValidUntil).toBeUndefined();
    expect(result.warnings.some(warning => warning.startsWith("TK:"))).toBe(true);
  });

  it("retains performed inspection but omits expiry before it, invalid registration dates and inferred model years", () => {
    const result = parse({ dat_prva_evid: "31.02.2020", dat_prva_evid_sr: "2020-01-01" }, { kmEkLastCheck: "2026-01-10", kmEkNextCheck: "2025-01-10" });
    expect(result.facts.emissionInspectionAt?.value).toBe("2026-01-10");
    expect(result.facts.emissionInspectionValidUntil).toBeUndefined();
    expect(result.facts.firstRegisteredAt).toBeUndefined();
    expect(result.facts.firstRegisteredInSkAt).toBeUndefined();
    expect(result.facts.modelYear).toBeUndefined();
  });

  it("only exposes allowlisted technical data and never assumes an insurance status", () => {
    const privateText = "synthetic-private-owner-or-document";
    const result = parse({ cislo_tp: privateText, cislo_eoe: privateText, dalsie_zaznamy: privateText, owner: privateText, insuranceStatus: "Poistené" });
    expect(JSON.stringify(result)).not.toContain(privateText);
    expect(result.facts.insuranceStatus).toBeUndefined();
    expect(result.facts.insurer).toBeUndefined();
  });
});

describe("DatabázaVozidiel authenticated HTTP request", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.stubEnv("DATABAZA_VOZIDIEL_API_KEY", serverKey);
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); fetchMock.mockReset(); });

  it.each(["plate", "vin"] as const)("sends a single %s request to the official origin with v3 auth and bounded no-store transport", async (kind) => {
    const input = { ...query, kind, value: kind === "plate" ? query.value : vin };
    fetchMock.mockResolvedValue(Response.json(payload()));
    const result = await lookupDatabazaVozidiel(input, { timeoutMs: 500 });
    expect(result.status).toBe("found");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`https://www.databazavozidiel.sk/api/vehicles?${kind === "plate" ? "ecv" : "vin"}=${input.value}&ek_tk_live=false`);
    expect(options).toMatchObject({ cache: "no-store", redirect: "error", headers: { Authorization: `Bearer ${serverKey}`, Version: "3", Accept: "application/json" } });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(String(url)).not.toContain(serverKey);
    expect(JSON.stringify(result)).not.toContain(serverKey);
  });

  it("makes no outbound request when the key is missing", async () => {
    vi.stubEnv("DATABAZA_VOZIDIEL_API_KEY", "  ");
    expect(await lookupDatabazaVozidiel(query)).toMatchObject({ status: "unsupported", facts: {} });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [404, "not_found"], [429, "rate_limited"], [401, "unavailable"], [403, "unavailable"], [422, "unavailable"], [500, "unavailable"],
  ] as const)("maps HTTP %s to %s without leaking the provider body or retrying", async (httpStatus, expectedStatus) => {
    fetchMock.mockResolvedValue(Response.json({ message: `${serverKey}: synthetic-private-error` }, { status: httpStatus }));
    const result = await lookupDatabazaVozidiel(query);
    expect(result).toMatchObject({ status: expectedStatus, facts: {} });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(serverKey);
    expect(JSON.stringify(result)).not.toContain("synthetic-private-error");
  });

  it("does not follow redirects and expose the key to another host", async () => {
    fetchMock.mockImplementation(async (_url, options) => {
      expect(options?.redirect).toBe("error");
      throw new TypeError(`redirect failed: ${serverKey}`);
    });
    const result = await lookupDatabazaVozidiel(query);
    expect(result).toMatchObject({ status: "unavailable", facts: {} });
    expect(JSON.stringify(result)).not.toContain(serverKey);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts the request using the supplied timeout without returning the error message", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    fetchMock.mockImplementation(async (_url, options) => await new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error(`${serverKey}: request timeout`)), { once: true });
    }));
    const pending = lookupDatabazaVozidiel(query, { timeoutMs: 123 });
    controller.abort();
    const result = await pending;
    expect(timeout).toHaveBeenCalledExactlyOnceWith(123);
    expect(result).toMatchObject({ status: "unavailable", facts: {} });
    expect(JSON.stringify(result)).not.toContain(serverKey);
  });

  it("stops and cancels an oversized response before parsing provider data", async () => {
    const read = vi.fn().mockResolvedValue({ done: false, value: new Uint8Array(500_001) });
    const cancel = vi.fn().mockResolvedValue(undefined);
    fetchMock.mockResolvedValue({ ok: true, body: { getReader: () => ({ read, cancel }) } } as unknown as Response);
    expect(await lookupDatabazaVozidiel(query)).toMatchObject({ status: "unavailable", facts: {} });
    expect(read).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each(["<html>Challenge</html>", "null", "{invalid", "[]"])("treats an invalid success response as unavailable: %s", async (body) => {
    fetchMock.mockResolvedValue(new Response(body));
    expect(await lookupDatabazaVozidiel(query)).toMatchObject({ status: "unavailable", facts: {} });
  });
});
