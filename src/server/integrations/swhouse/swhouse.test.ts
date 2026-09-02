import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mapSwhouseBranch, findStaleBranchTargets } from "./branch-mapping";
import { __resetSwhouseCaches, SwhouseClient } from "./client";
import {
  buildBasicAuthHeader,
  buildUserAuthHeader,
  parseBranchMap,
  parseFleetOwnerTypeIds,
  sha256Hex,
  swhouseConfigFromEnv,
  SwhouseConfigError,
  type SwhouseConfig,
} from "./config";
import {
  aggregateAvailability,
  normalizeFleet,
  normalizeFleetCar,
  normalizeOccupancy,
  normalizePlateForPairing,
  pairFleetOccupancy,
} from "./replacement-vehicles";
import type { SwhouseCarOccupancyRaw, SwhouseCarRaw } from "./types";
import type { SwhouseCodelistMaps } from "./codelists";
import { validateAuthoritativeFleetTransition } from "./sync";

const TEST_CONFIG: SwhouseConfig = {
  baseUrl: "https://swh.test/rest",
  basicUsername: "basicUser",
  basicPassword: "basicPass",
  loginUsername: "test-login-user",
  loginPassword: "test-login-password",
  codelistTtlMs: 60_000,
  occupancyTtlMs: 60_000,
  carsTtlMs: 60_000,
  requestTimeoutMs: 1000,
  branchMap: { "1": "br-zilina", "6": "br-ba" },
  fleetOwnerTypeIds: [3, 4],
};

describe("config / auth helpers", () => {
  it("sha256Hex matches the verified golden hash", () => {
    expect(sha256Hex("test-login-password")).toBe(
      "af4345bce5310a9fa0429521ff62c23b563f8d4655c1dc091540a768eb81615b",
    );
  });

  it("buildUserAuthHeader = base64(user:sha256hex(pwd))", () => {
    expect(buildUserAuthHeader("test-login-user", "test-login-password")).toBe(
      "dGVzdC1sb2dpbi11c2VyOmFmNDM0NWJjZTUzMTBhOWZhMDQyOTUyMWZmNjJjMjNiNTYzZjhkNDY1NWMxZGMwOTE1NDBhNzY4ZWI4MTYxNWI=",
    );
  });

  it("buildBasicAuthHeader = Basic base64(user:pass)", () => {
    expect(buildBasicAuthHeader("test-basic-user", "test-basic-password")).toBe(
      "Basic dGVzdC1iYXNpYy11c2VyOnRlc3QtYmFzaWMtcGFzc3dvcmQ=",
    );
  });

  it("parseBranchMap parses valid JSON, filters non-strings, tolerates junk", () => {
    expect(parseBranchMap('{"1":"a","6":"b"}')).toEqual({ "1": "a", "6": "b" });
    expect(parseBranchMap('{"1":2,"3":"c"}')).toEqual({ "3": "c" });
    expect(parseBranchMap("not json")).toEqual({});
    expect(parseBranchMap("")).toEqual({});
    expect(parseBranchMap(undefined)).toEqual({});
    expect(parseBranchMap("[1,2]")).toEqual({});
  });

  it("parseFleetOwnerTypeIds parses CSV, falls back to default [3,4] on junk", () => {
    expect(parseFleetOwnerTypeIds("3,4")).toEqual([3, 4]);
    expect(parseFleetOwnerTypeIds(" 2 , 5 ")).toEqual([2, 5]);
    expect(parseFleetOwnerTypeIds("")).toEqual([3, 4]);
    expect(parseFleetOwnerTypeIds(undefined)).toEqual([3, 4]);
    expect(parseFleetOwnerTypeIds("abc")).toEqual([3, 4]);
    expect(parseFleetOwnerTypeIds("0,-1")).toEqual([3, 4]);
  });

  it("swhouseConfigFromEnv throws SwhouseConfigError on missing/placeholder creds", () => {
    expect(() => swhouseConfigFromEnv({})).toThrow(SwhouseConfigError);
    expect(() =>
      swhouseConfigFromEnv({
        SWHOUSE_BASIC_USERNAME: "replace-with-server-only-swhouse-basic-username",
        SWHOUSE_BASIC_PASSWORD: "x",
        SWHOUSE_LOGIN_USERNAME: "y",
        SWHOUSE_LOGIN_PASSWORD: "z",
      }),
    ).toThrow(SwhouseConfigError);
  });

  it("requires an explicit HTTPS base URL so production cannot fall back to legacy data", () => {
    const credentials = {
      SWHOUSE_BASIC_USERNAME: "basic-user",
      SWHOUSE_BASIC_PASSWORD: "basic-password",
      SWHOUSE_LOGIN_USERNAME: "login-user",
      SWHOUSE_LOGIN_PASSWORD: "login-password",
    };

    expect(() => swhouseConfigFromEnv(credentials)).toThrow("SWHOUSE_API_BASE_URL");
    expect(() => swhouseConfigFromEnv({ ...credentials, SWHOUSE_API_BASE_URL: "http://example.test/rest" })).toThrow(
      "HTTPS",
    );
    expect(
      swhouseConfigFromEnv({
        ...credentials,
        SWHOUSE_API_BASE_URL: "https://app.pomocmotoristom.sk/rest/",
      }).baseUrl,
    ).toBe("https://app.pomocmotoristom.sk/rest");
  });
});

describe("branch-mapping (explicit only, no fuzzy)", () => {
  it("maps known lasFilialId, returns null for unknown/null", () => {
    const map = { "1": "br-zilina", "6": "br-ba" };
    expect(mapSwhouseBranch(map, 1)).toBe("br-zilina");
    expect(mapSwhouseBranch(map, 6)).toBe("br-ba");
    expect(mapSwhouseBranch(map, 10)).toBeNull();
    expect(mapSwhouseBranch(map, null)).toBeNull();
  });

  it("findStaleBranchTargets returns map targets not present in known branch ids", () => {
    const map = { "1": "br-zilina", "6": "br-missing" };
    expect(findStaleBranchTargets(map, ["br-zilina", "br-ba"])).toEqual(["br-missing"]);
    expect(findStaleBranchTargets(map, ["br-zilina", "br-missing"])).toEqual([]);
  });
});

describe("normalize + aggregate", () => {
  const maps: SwhouseCodelistMaps = {
    manufacturers: new Map([[1, "Audi"]]),
    colors: new Map([[11, "Čierna"]]),
    carTypes: new Map([[1, "Osobné"]]),
    ownerTypes: new Map([[3, "Prenajímateľ"]]),
    branches: new Map([
      [1, "Žilina"],
      [6, "Bratislava"],
    ]),
    expiresAt: Date.now() + 60_000,
  };

  const raw: SwhouseCarOccupancyRaw[] = [
    // placeholder — musí byť preskočený
    { carId: 0, manufacturerId: 0, colorId: 0, model: "", ecv: "", vin: "", cotp: "", typeId: 1, ownerTypeId: 0, lasFilialId: null, rentId: null, assistanceRentId: null, rentTo: null },
    { carId: 8772, manufacturerId: 1, colorId: 11, model: "A6 Avant", ecv: "AA010HN", vin: "WAUZ", cotp: null, typeId: 1, ownerTypeId: 3, lasFilialId: 1, rentId: 7202, assistanceRentId: null, rentTo: "2025-08-07T22:00:00Z" },
    { carId: 9001, manufacturerId: 1, colorId: 11, model: "A4", ecv: "AA999XX", vin: "WAUX", cotp: null, typeId: 1, ownerTypeId: 3, lasFilialId: 1, rentId: 1, assistanceRentId: null, rentTo: null },
    // lasFilialId 10 nie je v mape → nepriradené
    { carId: 9002, manufacturerId: 1, colorId: 11, model: "Q5", ecv: "AA111YY", vin: "WAUY", cotp: null, typeId: 1, ownerTypeId: 3, lasFilialId: 10, rentId: 2, assistanceRentId: null, rentTo: null },
  ];

  it("normalizeOccupancy skips placeholder, resolves codelists, maps branch", () => {
    const vehicles = normalizeOccupancy(raw, maps, TEST_CONFIG.branchMap);
    expect(vehicles).toHaveLength(3);
    const first = vehicles[0];
    expect(first.make).toBe("Audi");
    expect(first.color).toBe("Čierna");
    expect(first.ownerType).toBe("Prenajímateľ");
    expect(first.kindHint).toBe("replacement_car");
    expect(first.branchInternalId).toBe("br-zilina");
    expect(first.swhouseBranchName).toBe("Žilina");
    const unmapped = vehicles.find((v) => v.carId === 9002);
    expect(unmapped?.branchInternalId).toBeNull();
  });

  it("aggregateAvailability counts per branch + unassigned + total", () => {
    const vehicles = normalizeOccupancy(raw, maps, TEST_CONFIG.branchMap);
    const agg = aggregateAvailability(vehicles);
    expect(agg.availabilityByBranch).toEqual({ "br-zilina": 2 });
    expect(agg.unassignedCount).toBe(1);
    expect(agg.totalFree).toBe(3);
  });

  it("normalizeOccupancy without codelists leaves names null but still counts", () => {
    const emptyMaps: SwhouseCodelistMaps = {
      manufacturers: new Map(),
      colors: new Map(),
      carTypes: new Map(),
      ownerTypes: new Map(),
      branches: new Map(),
      expiresAt: 0,
    };
    const vehicles = normalizeOccupancy(raw, emptyMaps, TEST_CONFIG.branchMap);
    expect(vehicles[0].make).toBeNull();
    expect(aggregateAvailability(vehicles).totalFree).toBe(3);
  });
});

describe("normalizeFleet (roster celej flotily pre Fázu 2)", () => {
  const maps: SwhouseCodelistMaps = {
    manufacturers: new Map([[1, "Audi"]]),
    colors: new Map([[11, "Čierna"]]),
    carTypes: new Map([[1, "Osobné"]]),
    ownerTypes: new Map([
      [3, "Náhradné vozidlo"],
      [4, "Pomoc motoristom"],
    ]),
    branches: new Map([[1, "Žilina"]]),
    expiresAt: Date.now() + 60_000,
  };

  const cars: SwhouseCarRaw[] = [
    { carId: 0, ecv: "", ownerTypeId: 3 }, // placeholder → skip
    { carId: 101, ecv: "AA010HN", ownerTypeId: 3, vin: "WAUZ1", manufacturerId: 1, model: "A6", colorId: 11, lasFilialId: 1 },
    { carId: 102, ecv: "AA020PM", ownerTypeId: 4, vin: "WAUZ2", manufacturerId: 1, model: "Q7", colorId: 11, lasFilialId: 1 },
    { carId: 103, ecv: "ZZ999ZZ", ownerTypeId: 0, vin: "CUST01", manufacturerId: 1, model: "A1", colorId: 11, lasFilialId: 1 }, // zákaznícke → skip
  ];

  it("filtruje na fleet ownerType (3/4), preskočí placeholder + zákaznícke", () => {
    const fleet = normalizeFleet(cars, maps, TEST_CONFIG.branchMap, [3, 4]);
    expect(fleet.map((v) => v.carId).sort()).toEqual([101, 102]);
  });

  it("zahŕňa obe kategórie (Náhradné aj Pomoc motoristom) a rozlíši ownerType", () => {
    const fleet = normalizeFleet(cars, maps, TEST_CONFIG.branchMap, [3, 4]);
    expect(fleet.find((v) => v.carId === 101)?.ownerType).toBe("Náhradné vozidlo");
    expect(fleet.find((v) => v.carId === 102)?.ownerType).toBe("Pomoc motoristom");
  });

  it("normalizeFleetCar prenáša VIN/značku/model/pobočku, kindHint replacement_car, rentTo null", () => {
    const vehicle = normalizeFleetCar(cars[1], maps, TEST_CONFIG.branchMap);
    expect(vehicle).not.toBeNull();
    expect(vehicle?.vin).toBe("WAUZ1");
    expect(vehicle?.make).toBe("Audi");
    expect(vehicle?.model).toBe("A6");
    expect(vehicle?.kindHint).toBe("replacement_car");
    expect(vehicle?.branchInternalId).toBe("br-zilina");
    expect(vehicle?.rentTo).toBeNull();
  });

  it("normalizeFleetCar vráti null pre placeholder carId 0", () => {
    expect(normalizeFleetCar(cars[0], maps, TEST_CONFIG.branchMap)).toBeNull();
  });
});

describe("pairFleetOccupancy (párovanie obsadenosti flotily)", () => {
  const freeRaw: SwhouseCarOccupancyRaw[] = [
    // placeholder — musí byť preskočený
    { carId: 0, manufacturerId: 0, colorId: 0, model: "", ecv: "", vin: "", cotp: "", typeId: 1, ownerTypeId: 0, lasFilialId: null, rentId: null, assistanceRentId: null, rentTo: null },
    { carId: 8772, manufacturerId: 1, colorId: 11, model: "A6 Avant", ecv: "aa 010-hn", vin: "WAUZ", cotp: null, typeId: 1, ownerTypeId: 3, lasFilialId: 1, rentId: 7202, assistanceRentId: null, rentTo: null },
    { carId: 8888, manufacturerId: 1, colorId: 11, model: "Customer", ecv: "BL999XX", vin: "CUSTOMER", cotp: null, typeId: 1, ownerTypeId: 9, lasFilialId: 1, rentId: null, assistanceRentId: null, rentTo: null },
  ];
  const allCars: SwhouseCarRaw[] = [
    { carId: 0, ecv: "", ownerTypeId: 0 }, // placeholder
    { carId: 8772, ecv: "AA010HN", ownerTypeId: 3 }, // voľné
    { carId: 9100, ecv: "ZA141HM", ownerTypeId: 3 }, // flotila, nie je voľné → obsadené
    { carId: 9101, ecv: "ZA 226 JD", ownerTypeId: 4 }, // flotila (druhý owner type) → obsadené
    { carId: 9102, ecv: "BL999XX", ownerTypeId: 0 }, // zákaznícke auto → ignorovať
    { carId: 9103, ecv: null, ownerTypeId: 3 }, // bez ŠPZ → ignorovať
  ];

  it("normalizePlateForPairing zjednotí formáty ŠPZ", () => {
    expect(normalizePlateForPairing("aa 010-hn")).toBe("AA010HN");
    expect(normalizePlateForPairing(null)).toBe("");
    expect(normalizePlateForPairing(undefined)).toBe("");
  });

  it("obsadené = flotila (ownerTypeIds) mínus voľné; zákaznícke autá a prázdne ŠPZ ignoruje", () => {
    const result = pairFleetOccupancy(freeRaw, allCars, [3, 4]);
    expect(result.freePlates).toEqual(["AA010HN"]);
    expect(result.occupiedPlates).toEqual(["ZA141HM", "ZA226JD"]);
  });

  it("pri duplicitnej ŠPZ (starý + nový SWHouse záznam) vyhráva voľné", () => {
    const withDuplicate: SwhouseCarRaw[] = [...allCars, { carId: 9200, ecv: "AA010HN", ownerTypeId: 3 }];
    const result = pairFleetOccupancy(freeRaw, withDuplicate, [3, 4]);
    expect(result.occupiedPlates).not.toContain("AA010HN");
  });

  it("rešpektuje konfigurovateľné ownerTypeIds", () => {
    const result = pairFleetOccupancy(freeRaw, allCars, [4]);
    expect(result.occupiedPlates).toEqual(["ZA226JD"]);
  });
});

describe("authoritative roster safety gate", () => {
  const ids = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}-${index}`);

  it("accepts the verified test-to-production transition with a healthy overlap", () => {
    const existing = ids("shared", 152).concat(ids("old", 71));
    const incoming = ids("shared", 152).concat(ids("new", 119));
    expect(validateAuthoritativeFleetTransition(existing, incoming)).toBeNull();
  });

  it("rejects an empty or implausibly small authoritative response", () => {
    expect(validateAuthoritativeFleetTransition(ids("old", 223), [])).toContain("bezpečným minimom");
    expect(validateAuthoritativeFleetTransition([], ids("new", 5))).toContain("bezpečným minimom");
  });

  it("rejects a destructive shrink or a switch to unrelated vehicle ids", () => {
    expect(validateAuthoritativeFleetTransition(ids("old", 100), ids("old", 30))).toContain("podozrivo zmenšil");
    expect(validateAuthoritativeFleetTransition(ids("old", 100), ids("new", 100))).toContain("malý prekryv");
  });
});

describe("SwhouseClient auth/token (new code — primary test target)", () => {
  let loginCount = 0;
  let occupancyCount = 0;
  let allOccupancyCount = 0;
  let occupancyStatusQueue: number[] = [];

  function installFetch() {
    loginCount = 0;
    occupancyCount = 0;
    allOccupancyCount = 0;
    occupancyStatusQueue = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/login")) {
        loginCount += 1;
        return new Response(
          JSON.stringify({ token: `tok-${loginCount}`, expirationISO: new Date(Date.now() + 3_600_000).toISOString() }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/carOccupancy/getCarsOccupancyAll")) {
        allOccupancyCount += 1;
        return new Response(JSON.stringify([{ carId: 2, manufacturerId: 1, colorId: 1, model: "all", ecv: "ALL", vin: "VIN2", cotp: null, typeId: 1, ownerTypeId: 3, lasFilialId: 6, rentId: null, assistanceRentId: null, rentTo: null }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/carOccupancy/getCarsOccupancy")) {
        occupancyCount += 1;
        const status = occupancyStatusQueue.shift() ?? 200;
        if (status !== 200) {
          return new Response("unauthorized", { status });
        }
        return new Response(JSON.stringify([{ carId: 1, manufacturerId: 1, colorId: 1, model: "x", ecv: "E", vin: "V", cotp: null, typeId: 1, ownerTypeId: 1, lasFilialId: 1, rentId: 1, assistanceRentId: null, rentTo: null }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("[]", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  beforeEach(() => {
    __resetSwhouseCaches();
    installFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("logs in once and returns occupancy", async () => {
    const client = new SwhouseClient(TEST_CONFIG);
    const res = await client.getCarsOccupancy();
    expect(res.ok).toBe(true);
    expect(res.data).toHaveLength(1);
    expect(loginCount).toBe(1);
  });

  it("single-flights login under concurrency", async () => {
    const client = new SwhouseClient(TEST_CONFIG);
    await Promise.all([client.getCarsOccupancy(), client.getCarsOccupancy(), client.getCarsOccupancy()]);
    expect(loginCount).toBe(1);
    expect(occupancyCount).toBe(1); // occupancy single-flight too
  });

  it("serves occupancy from cache within TTL (no second network call)", async () => {
    const client = new SwhouseClient(TEST_CONFIG);
    await client.getCarsOccupancy();
    await client.getCarsOccupancy();
    expect(occupancyCount).toBe(1);
  });

  it("uses and single-flights the authoritative all-occupancy endpoint", async () => {
    const client = new SwhouseClient(TEST_CONFIG);
    const [first, second] = await Promise.all([client.getCarsOccupancyAll(), client.getCarsOccupancyAll()]);
    expect(first.ok).toBe(true);
    expect(second.data?.[0]?.lasFilialId).toBe(6);
    expect(allOccupancyCount).toBe(1);
    expect(loginCount).toBe(1);
  });

  it("invalidates token and retries once on 401", async () => {
    occupancyStatusQueue = [401]; // first occupancy → 401, then 200
    const client = new SwhouseClient(TEST_CONFIG);
    const res = await client.getCarsOccupancy();
    expect(res.ok).toBe(true);
    expect(loginCount).toBe(2); // initial + re-login after 401
    expect(occupancyCount).toBe(2);
  });

  it("returns redacted auth_failed after second 401 (no creds leaked)", async () => {
    occupancyStatusQueue = [401, 401];
    const client = new SwhouseClient(TEST_CONFIG);
    const res = await client.getCarsOccupancy();
    expect(res.ok).toBe(false);
    expect(res.error).toBe("auth_failed");
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(TEST_CONFIG.loginPassword);
    expect(serialized).not.toContain(TEST_CONFIG.basicPassword);
    expect(serialized).not.toContain("tok-");
  });
});
