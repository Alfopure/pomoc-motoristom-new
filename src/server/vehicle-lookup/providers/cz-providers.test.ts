import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VehicleQuery } from "@/lib/vehicle-lookup";
import { AUTOKUK_URL, lookupAutokuk, parseAutokuk } from "./autokuk";
import { MYCARPLATE_URL, lookupMyCarPlate, parseMyCarPlate } from "./mycarplate";
import { RSV_URL, lookupRsv, parseRsv } from "./rsv";

const plate = "1AA0001";
const vin = "WVWZZZ1JZXW000001";
const otherVin = "WVWZZZ1JZXW000002";
const fetchedAt = "2026-09-30T10:00:00Z";
const plateQuery: VehicleQuery = { country: "CZ", kind: "plate", value: plate, checkedForDate: "2026-09-30" };
const vinQuery: VehicleQuery = { ...plateQuery, kind: "vin", value: vin };
const secret = "synthetic-private-api-key";

function myCarPlateData(overrides: Record<string, unknown> = {}) {
  return { success: true, data: {
    country: "CZ", plate, vin, make: "Volkswagen", model: "Tiguan", year: 2026,
    color: "Sivá", fuelType: "Hybrid", engineSize: "1498", powerKw: 110,
    weight: 1640, firstRegistration: "2026-03-18", motStatus: "Valid", motExpiryDate: "2030-03-18", confidence: 0.98,
    insurer: "Historical only", insuranceStatus: "Insured", owner: secret, ...overrides,
  } };
}
function rsvData(overrides: Record<string, unknown> = {}) {
  return { Status: 1, Data: {
    VIN: vin, TovarniZnacka: "VOLKSWAGEN", ObchodniOznaceni: "TIGUAN", Kategorie: "M1",
    VozidloDruh: "OSOBNÍ AUTOMOBIL", KaroserieDruh: "AC KOMBI", VozidloKaroserieBarva: "ŠEDÁ",
    Palivo: "BA", VozidloHybridni: "ANO", MotorZdvihObjem: 1498, MotorMaxVykon: "110 / 5000",
    HmotnostiProvozni: 1640, HmotnostiPripPov: "2190/ 2170", HmotnostiPripPovJS: "3970/ 3970",
    HmotnostiPripPovBrzdenePV: "1800/ 1800", HmotnostiPripPovNebrzdenePV: "750/ 750",
    VozidloKaroserieMist: "5 / 5 / 0", Rozmery: "4539/ 1842/ 1660", RozmeryRozvor: "2680",
    DatumPrvniRegistrace: "2026-03-18T00:00:00", PravidelnaTechnickaProhlidkaDo: "2030-03-18T00:00:00",
    CisloTp: secret, CisloOrv: secret, PocetVlastniku: 2, ...overrides,
  } };
}
function autokukData(overrides: Record<string, unknown> = {}) {
  return { status: "ok", data: {
    query: plate, vin, searched_by_spz: true, vehicle_records: { ambiguous: false },
    vehicle: { vin, brand: "VOLKSWAGEN", model: "TIGUAN", category: "M1", fuel: "Benzín", power_kw: 110 },
    technical: { weights: { operating_weight_kg: 1640, max_permitted_weight_kg: 2170 }, capacity: { seats_total: 5 } },
    vignette: { status: "ok", valid: true, exempt: false, valid_from: "2026-03-24", valid_until: "2027-03-23" },
    insurance: [{ insurer_name: secret, valid_from: "2024-01-01" }],
    owners: { records: [{ name: secret, address: secret }] },
    ...overrides,
  } };
}
function facts(result: ReturnType<typeof parseAutokuk>) {
  return Object.fromEntries(Object.entries(result.facts).map(([field, fact]) => [field, fact.value]));
}

describe("Czech provider parsers", () => {
  it("binds a Czech MyCarPlate result to the echoed plate and VIN, without insurance", () => {
    const result = parseMyCarPlate(myCarPlateData(), plateQuery, fetchedAt);
    expect(result).toMatchObject({ source: "mycarplate", status: "found", url: MYCARPLATE_URL, fetchedAt });
    expect(facts(result)).toMatchObject({ plate, vin, make: "Volkswagen", model: "Tiguan", modelYear: "2026", curbWeightKg: "1640", engineCapacityCc: "1498", powerKw: "110", firstRegisteredAt: "2026-03-18", technicalInspectionValidUntil: "2030-03-18" });
    expect(result.facts.fuel?.quality).toBe("partial");
    expect(result.facts.insurer).toBeUndefined();
    expect(result.facts.insuranceStatus).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([{ plate: "2AA0001" }, { country: "SK" }, { vin: null }, { vin: "INVALID" }])("does not accept an unverified MyCarPlate binding: %j", (change) => {
    const result = parseMyCarPlate(myCarPlateData(change), plateQuery, fetchedAt);
    expect(result.status).not.toBe("found");
    expect(result.facts).toEqual({});
  });

  it("does not bind an explicitly low-confidence Czech plate to a VIN", () => {
    for (const confidence of [0, 0.5, 0.79]) {
      const result = parseMyCarPlate(myCarPlateData({ confidence }), plateQuery, fetchedAt);
      expect(result).toMatchObject({ status: "ambiguous", facts: {} });
      expect(result.warnings[0]).toContain("nízku istotu");
    }
    expect(parseMyCarPlate(myCarPlateData({ confidence: 0.8 }), plateQuery, fetchedAt).status).toBe("found");
    expect(parseMyCarPlate(myCarPlateData({ confidence: null }), plateQuery, fetchedAt).status).toBe("found");
  });

  it.each([-0.1, 1.1, Infinity, NaN, "0.98"])("rejects malformed confidence %s", (confidence) => {
    const result = parseMyCarPlate(myCarPlateData({ confidence }), plateQuery, fetchedAt);
    expect(result).toMatchObject({ status: "unavailable", facts: {} });
    expect(result.warnings[0]).toContain("neplatnú mieru istoty");
  });

  it("maps RSV's legal maximum, category and STK while dropping certificate and owner data", () => {
    const result = parseRsv(rsvData(), vinQuery, fetchedAt);
    expect(result).toMatchObject({ source: "rsv", status: "found", url: RSV_URL, fetchedAt });
    expect(facts(result)).toMatchObject({ vin, make: "VOLKSWAGEN", model: "TIGUAN", vehicleCategory: "M1", curbWeightKg: "1640", grossWeightKg: "2170", grossTrainWeightKg: "3970", seats: "5", powerKw: "110", engineRpm: "5000", fuel: "Benzín / hybrid", firstRegisteredAt: "2026-03-18", technicalInspectionValidUntil: "2030-03-18" });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.facts.plate).toBeUndefined();
  });

  it("does not silently accept a different RSV VIN or malformed success body", () => {
    expect(parseRsv(rsvData({ VIN: otherVin }), vinQuery, fetchedAt)).toMatchObject({ status: "ambiguous", facts: {} });
    expect(parseRsv({ Status: 1, Data: { VIN: "INVALID" } }, vinQuery, fetchedAt)).toMatchObject({ status: "unavailable", facts: {} });
    expect(parseRsv({ Status: 0, Data: { VIN: vin } }, vinQuery, fetchedAt)).toMatchObject({ status: "unavailable", facts: {} });
  });

  it("maps Autokuk's explicit current vignette answer, never its historical insurance", () => {
    const result = parseAutokuk(autokukData(), plateQuery, fetchedAt);
    expect(result).toMatchObject({ source: "autokuk", status: "found", url: AUTOKUK_URL, fetchedAt });
    expect(facts(result)).toMatchObject({ plate, vin, make: "VOLKSWAGEN", vehicleCategory: "M1", curbWeightKg: "1640", grossWeightKg: "2170", vignetteStatus: "Platná", vignetteValidFrom: "2026-03-24", vignetteValidUntil: "2027-03-23" });
    expect(result.facts.insurer).toBeUndefined();
    expect(result.facts.insuranceStatus).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("distinguishes invalid, exempt and unknown vignette responses", () => {
    expect(facts(parseAutokuk(autokukData({ vignette: { status: "ok", valid: false, exempt: false } }), plateQuery, fetchedAt))).toMatchObject({ vignetteStatus: "Neplatná" });
    expect(facts(parseAutokuk(autokukData({ vignette: { status: "ok", valid: false, exempt: true } }), plateQuery, fetchedAt))).toMatchObject({ vignetteStatus: "Oslobodené" });
    for (const vignette of [{ status: "timeout", valid: false }, { status: "ok", valid: null }, { status: "ok" }]) {
      expect(parseAutokuk(autokukData({ vignette }), plateQuery, fetchedAt).facts.vignetteStatus).toBeUndefined();
    }
  });

  it("requires Autokuk to confirm the queried plate and a single VIN", () => {
    expect(parseAutokuk(autokukData({ query: "2AA0001" }), plateQuery, fetchedAt)).toMatchObject({ status: "ambiguous", facts: {} });
    expect(parseAutokuk(autokukData({ searched_by_spz: false }), plateQuery, fetchedAt)).toMatchObject({ status: "unavailable", facts: {} });
    expect(parseAutokuk(autokukData({ vehicle: { vin: otherVin } }), plateQuery, fetchedAt)).toMatchObject({ status: "ambiguous", facts: {} });
    expect(parseAutokuk(autokukData({ vehicle_records: { ambiguous: true } }), plateQuery, fetchedAt)).toMatchObject({ status: "ambiguous", facts: {} });
  });

  it("can query Autokuk by VIN without inventing a plate", () => {
    const result = parseAutokuk(autokukData({ query: vin, searched_by_spz: false }), vinQuery, fetchedAt);
    expect(result.status).toBe("found");
    expect(result.facts.plate).toBeUndefined();
    expect(result.facts.vin?.value).toBe(vin);
  });
});

describe("Czech provider requests", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("CZ_RSV_API_KEY", secret);
    vi.stubEnv("CZ_AUTOKUK_API_KEY", secret);
    vi.stubEnv("CZ_MYCARPLATE_API_KEY", "");
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); fetchMock.mockReset(); });

  it("makes an anonymous bounded MyCarPlate GET when no key is configured", async () => {
    fetchMock.mockResolvedValue(Response.json(myCarPlateData()));
    expect((await lookupMyCarPlate(plateQuery, { timeoutMs: 500 })).status).toBe("found");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`https://mycarplate.online/api/v1/vehicle?plate=${plate}&country=CZ&withVin=true`);
    expect(init).toMatchObject({ cache: "no-store", redirect: "error", headers: { Accept: "application/json" } });
    expect(init?.headers).not.toHaveProperty("X-API-Key");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("uses a server-side MyCarPlate key without exposing it in the URL/result", async () => {
    vi.stubEnv("CZ_MYCARPLATE_API_KEY", secret);
    fetchMock.mockResolvedValue(Response.json(myCarPlateData()));
    const result = await lookupMyCarPlate(plateQuery);
    const [url, init] = fetchMock.mock.calls[0];
    expect(init?.headers).toMatchObject({ "X-API-Key": secret });
    expect(String(url)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("requires an RSV key and calls the official VIN endpoint", async () => {
    vi.stubEnv("CZ_RSV_API_KEY", " ");
    expect(await lookupRsv(vinQuery)).toMatchObject({ status: "unsupported", facts: {} });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv("CZ_RSV_API_KEY", secret);
    fetchMock.mockResolvedValue(Response.json(rsvData()));
    expect((await lookupRsv(vinQuery, { timeoutMs: 300 })).status).toBe("found");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`https://api.dataovozidlech.cz/api/vehicletechnicaldata/v2?vin=${vin}`);
    expect(init).toMatchObject({ cache: "no-store", redirect: "error", headers: { API_KEY: secret, Accept: "application/json" } });
    expect(String(url)).not.toContain(secret);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends one commercial Autokuk POST with vignette include and bounded transport", async () => {
    fetchMock.mockResolvedValue(Response.json(autokukData()));
    const result = await lookupAutokuk(plateQuery, { timeoutMs: 400 });
    expect(result.status).toBe("found");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://autokuk.cz/api/v1/search");
    expect(init).toMatchObject({ method: "POST", cache: "no-store", redirect: "error", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" } });
    expect(JSON.parse(String(init?.body))).toEqual({ query: plate, include: ["vignette"] });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("makes no Autokuk request without a commercial key", async () => {
    vi.stubEnv("CZ_AUTOKUK_API_KEY", "");
    expect(await lookupAutokuk(plateQuery)).toMatchObject({ status: "unsupported", facts: {} });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([404, 429, 401, 500])("handles MyCarPlate HTTP %s without retries or body disclosure", async (status) => {
    fetchMock.mockResolvedValue(Response.json({ message: secret }, { status }));
    const result = await lookupMyCarPlate(plateQuery);
    expect(result.status).toBe(status === 404 ? "not_found" : status === 429 ? "rate_limited" : "unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("does not expose an oversized Autokuk response", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    fetchMock.mockResolvedValue({ ok: true, body: { getReader: () => ({ read: async () => ({ done: false, value: new Uint8Array(500_001) }), cancel }) } } as unknown as Response);
    expect(await lookupAutokuk(plateQuery)).toMatchObject({ status: "unavailable", facts: {} });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
