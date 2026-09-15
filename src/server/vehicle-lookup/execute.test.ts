import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VehicleQuery, VehicleSource, VehicleSourceResult } from "@/lib/vehicle-lookup";

const mocks = vi.hoisted(() => ({ skp: vi.fn(), stk: vi.fn(), haka: vi.fn(), vpic: vi.fn(), text: vi.fn() }));
vi.mock("./providers/skp-browser", () => ({ lookupSkp: mocks.skp }));
vi.mock("./providers/stkonline", async (original) => ({ ...await original<typeof import("./providers/stkonline")>(), parseStkOnline: mocks.stk }));
vi.mock("./providers/haka", async (original) => ({ ...await original<typeof import("./providers/haka")>(), parseHaka: mocks.haka }));
vi.mock("./providers/vpic", () => ({ parseVpic: mocks.vpic }));
vi.mock("./providers/http", async (original) => ({ ...await original<typeof import("./providers/http")>(), providerText: mocks.text }));

import { executeVehicleLookup, type LookupProviders } from "./execute";

const query: VehicleQuery = { kind: "plate", value: "XX000XX", country: "SK", checkedForDate: "2026-09-15" };
const vin = "WVWZZZ1JZXW000001";
const otherVin = "WVWZZZ1JZXW000002";
const enabled: LookupProviders = { skp: true, stkonline: true, haka: true, vpic: true };
function source(name: VehicleSource, status: VehicleSourceResult["status"] = "not_found", facts: VehicleSourceResult["facts"] = {}): VehicleSourceResult {
  return { source: name, status, facts, url: "https://www.skp.sk/", fetchedAt: "2026-09-15T08:00:00Z", warnings: [] };
}
function identity(name: VehicleSource, value = vin): VehicleSourceResult {
  return source(name, "found", { plate: { value: query.value, quality: "reported" }, vin: { value, quality: "reported" } });
}

beforeEach(() => {
  mocks.text.mockResolvedValue("{}");
  mocks.stk.mockReturnValue(source("stkonline"));
  mocks.haka.mockReturnValue(source("haka"));
  mocks.skp.mockResolvedValue(source("skp", "found", { insuranceStatus: { value: "Poistené", quality: "reported" } }));
  mocks.vpic.mockReturnValue(source("vpic"));
});
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });

describe("VIN-first PZP lookup", () => {
  it("waits for STK identity and sends its VIN to SKP", async () => {
    let resolveStk!: (html: string) => void;
    const stkResponse = new Promise<string>((resolve) => { resolveStk = resolve; });
    mocks.text.mockImplementation((url: string) => url.includes("stkonline.sk") ? stkResponse : Promise.resolve("{}"));
    mocks.stk.mockReturnValue(identity("stkonline"));
    const pending = executeVehicleLookup(query, enabled);
    await Promise.resolve();
    expect(mocks.skp).not.toHaveBeenCalled();
    resolveStk("{}");
    const result = await pending;
    expect(mocks.skp).toHaveBeenCalledExactlyOnceWith({ ...query, kind: "vin", value: vin }, expect.any(Number));
    expect(result.sources.find((item) => item.source === "skp")?.warnings).toContain(`Overenie PZP podľa VIN: ${vin}.`);
    expect(mocks.text).toHaveBeenCalledWith(expect.stringContaining(`/DecodeVinValues/${vin}?`), expect.any(Object));
  });

  it("uses the entered plate when STK is disabled", async () => {
    await executeVehicleLookup(query, { ...enabled, stkonline: false });
    expect(mocks.stk).not.toHaveBeenCalled();
    expect(mocks.skp).toHaveBeenCalledExactlyOnceWith(query, expect.any(Number));
  });

  it("retains technical facts when the insurance provider is unavailable", async () => {
    mocks.stk.mockReturnValue(identity("stkonline"));
    mocks.skp.mockRejectedValue(new Error("provider_timeout"));
    const result = await executeVehicleLookup(query, enabled);
    expect(result.sources.find((item) => item.source === "stkonline")?.facts.vin?.value).toBe(vin);
    expect(result.sources.find((item) => item.source === "skp")?.status).toBe("unavailable");
    expect(mocks.skp).toHaveBeenCalledTimes(1);
  });

  it("uses the entered plate when no source establishes a VIN", async () => {
    const result = await executeVehicleLookup(query, enabled);
    expect(mocks.skp).toHaveBeenCalledExactlyOnceWith(query, expect.any(Number));
    expect(result.sources.find((item) => item.source === "skp")?.warnings).toContain(`Overenie PZP podľa EČV: ${query.value}.`);
    expect(mocks.vpic).not.toHaveBeenCalled();
  });

  it.each(["different_plate", "ambiguous"])("does not choose an inferred VIN from %s identity results", async (conflict) => {
    const otherVehicle = identity("stkonline");
    otherVehicle.facts.plate = { value: "YY000YY", quality: "reported" };
    mocks.stk.mockReturnValue(conflict === "ambiguous" ? source("stkonline", "ambiguous") : otherVehicle);
    const result = await executeVehicleLookup(query, enabled);
    expect(mocks.skp).toHaveBeenCalledExactlyOnceWith(query, expect.any(Number));
    expect(mocks.vpic).not.toHaveBeenCalled();
    expect(result.sources.find((item) => item.source === "stkonline")?.status).toBe(conflict === "ambiguous" ? "ambiguous" : "found");
  });

  it("tries the original EČV only after a definite empty VIN result and records both identifiers", async () => {
    mocks.stk.mockReturnValue(identity("stkonline"));
    mocks.skp.mockResolvedValueOnce(source("skp", "not_found"));
    const result = await executeVehicleLookup(query, enabled);
    expect(mocks.skp.mock.calls.map(([input]) => input)).toEqual([{ ...query, kind: "vin", value: vin }, query]);
    const insurance = result.sources.filter((item) => item.source === "skp");
    expect(insurance).toHaveLength(1);
    expect(insurance[0].status).toBe("found");
    expect(insurance[0].warnings.join(" ")).toContain(`VIN ${vin}`);
    expect(insurance[0].warnings.join(" ")).toContain(`EČV ${query.value}`);
  });

  it.each(["unavailable", "challenge_required", "rate_limited", "ambiguous"] as const)("does not retry by plate after SKP returns %s", async (status) => {
    mocks.stk.mockReturnValue(identity("stkonline"));
    mocks.skp.mockResolvedValue(source("skp", status));
    await executeVehicleLookup(query, enabled);
    expect(mocks.skp).toHaveBeenCalledTimes(1);
  });

  it("queries an entered VIN directly without inventing a plate fallback", async () => {
    const vinQuery: VehicleQuery = { ...query, kind: "vin", value: vin };
    mocks.skp.mockResolvedValue(source("skp", "not_found"));
    await executeVehicleLookup(vinQuery, enabled);
    expect(mocks.skp).toHaveBeenCalledExactlyOnceWith(vinQuery, expect.any(Number));
  });

  it("preserves a conflicting SKP identity and does not decode either inferred VIN", async () => {
    mocks.stk.mockReturnValue(identity("stkonline"));
    mocks.skp.mockResolvedValue(identity("skp", otherVin));
    const result = await executeVehicleLookup(query, enabled);
    expect(mocks.skp).toHaveBeenCalledExactlyOnceWith({ ...query, kind: "vin", value: vin }, expect.any(Number));
    expect(result.sources.find((item) => item.source === "skp")?.facts.vin?.value).toBe(otherVin);
    expect(mocks.vpic).not.toHaveBeenCalled();
  });

  it("honors the SKP circuit breaker even when STK returns a VIN", async () => {
    mocks.stk.mockReturnValue(identity("stkonline"));
    const result = await executeVehicleLookup(query, { ...enabled, skp: false });
    expect(mocks.skp).not.toHaveBeenCalled();
    expect(result.sources.find((item) => item.source === "skp")?.status).toBe("unsupported");
  });

  it("does not launch insurance or VIN decoding after identity lookup exhausts the deadline", async () => {
    vi.useFakeTimers();
    const deadline = Date.now() + 1_000;
    mocks.stk.mockImplementation(() => { vi.setSystemTime(deadline); return identity("stkonline"); });
    const result = await executeVehicleLookup(query, enabled, deadline);
    expect(mocks.skp).not.toHaveBeenCalled();
    expect(mocks.vpic).not.toHaveBeenCalled();
    expect(result.sources.find((item) => item.source === "skp")?.status).toBe("unavailable");
  });

  it("does not launch the plate fallback when the VIN attempt exhausts the deadline", async () => {
    vi.useFakeTimers();
    const deadline = Date.now() + 1_000;
    mocks.stk.mockReturnValue(identity("stkonline"));
    mocks.skp.mockImplementation(async () => { vi.setSystemTime(deadline); return source("skp", "not_found"); });
    await executeVehicleLookup(query, enabled, deadline);
    expect(mocks.skp).toHaveBeenCalledTimes(1);
    expect(mocks.vpic).not.toHaveBeenCalled();
  });

  it("makes no provider requests when the deadline has already elapsed", async () => {
    await expect(executeVehicleLookup(query, enabled, Date.now() - 1)).rejects.toThrow("lookup_deadline");
    expect(mocks.text).not.toHaveBeenCalled();
    expect(mocks.skp).not.toHaveBeenCalled();
  });
});
