import { afterEach, describe, expect, it, vi } from "vitest";
import { createToolsApi, ToolsApiError } from "./api";
import type { MobileTransport } from "../lib/api";

const profile = "00000000-0000-4000-8000-000000000001", organization = "00000000-0000-4000-8000-000000000002";
const config = { environment: "test" as const, apiOrigin: "https://test.dispecing.linkapomoci.sk", supabaseUrl: "https://nzpnqdstvkfncflgqlny.supabase.co", publishableKey: "fixture" };
const scope = { ok: true, apiVersion: 1, environment: "test", profileId: profile, organizationId: organization, checkedAt: "2026-10-15T17:00:00Z" };
const filter = { q: "", kind: "all" as const, status: "all" as const, offset: 0 };
const asset = { id: "00000000-0000-4000-8000-000000000003", kind: "tow_truck", label: "Odťah 1", licensePlate: "BA123AA", make: null, model: null, status: "available", internalStatus: "available", occupancy: null, occupancyCheckedAt: null, availabilityVerified: null,
  point: { lat: 0, lng: 0 }, gps: { source: "commander", positionTime: scope.checkedAt, syncedAt: scope.checkedAt, stale: false } };
const fleet = () => ({ ...scope, selection: filter, assets: [asset], total: 1, nextOffset: null, snapshot: "stored", gpsLastSuccessAt: scope.checkedAt });
const input = { origin: { lat: 0, lng: 0 }, destination: { lat: 1, lng: 1 } };
const leg = { distanceMeters: 1000, durationSeconds: 120, encodedPolyline: "????" };
const route = () => ({ ...scope, request: { ...input, intermediates: [] }, route: { ...leg, legs: [leg], provider: "google-routes", calculatedAt: scope.checkedAt } });
function setup(body: unknown, current = () => true) {
  const transport = vi.fn<MobileTransport>().mockResolvedValue(Response.json(body));
  return { transport, api: createToolsApi(config, profile, organization, async () => "private-token", transport, current) };
}
afterEach(() => vi.useRealTimers());

describe("mobile dispatch tools transport", () => {
  it("uses the existing scoped Bearer API without cookies or provider requests", async () => {
    const { api, transport } = setup(fleet());
    expect((await api.fleet(filter)).assets[0].point).toEqual({ lat: 0, lng: 0 });
    expect(transport).toHaveBeenCalledWith(config.apiOrigin + "/api/mobile/v1/tools/fleet?q=&kind=all&status=all&offset=0", expect.objectContaining({ method: "GET", credentials: "omit", headers: expect.objectContaining({ Authorization: "Bearer private-token", "X-PM-Expected-Organization": organization, "X-PM-App-Environment": "test" }) }));
  });
  it.each([{ environment: "production" }, { profileId: "other" }, { organizationId: "other" }, { checkedAt: "invalid" }, { rawProviderPayload: { token: "secret" } }])("rejects wrong scope or an expanded private payload %j", async change => {
    await expect(setup({ ...fleet(), ...change }).api.fleet(filter)).rejects.toMatchObject({ status: 502 });
  });
  it.each([
    { assets: [asset, asset], total: 2 }, { assets: [{ ...asset, point: { lat: 91, lng: 0 } }] },
    { assets: [{ ...asset, notes: "private" }] }, { assets: [{ ...asset, point: null }] },
    { selection: { ...filter, q: "other" } }, { nextOffset: 0 }, { total: 1001 },
    { assets: [{ ...asset, gps: { ...asset.gps, positionTime: "invalid" } }] },
  ])("rejects incomplete or mismatched fleet data %j", async change => {
    await expect(setup({ ...fleet(), ...change }).api.fleet(filter)).rejects.toMatchObject({ status: 502 });
  });
  it("binds the road result to the exact ordered points", async () => {
    const { api, transport } = setup(route());
    expect((await api.route(input)).route.distanceMeters).toBe(1000);
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).toEqual({ ...input, intermediates: [] });
    await expect(setup({ ...route(), request: { ...input, destination: input.origin, intermediates: [] } }).api.route(input)).rejects.toMatchObject({ status: 502 });
  });
  it.each([{ encodedPolyline: "?" }, { distanceMeters: -1 }, { durationSeconds: null }, { legs: [] }, { legs: [{ ...leg, encodedPolyline: "_" }] }])("rejects malformed driving proof %j", async change => {
    await expect(setup({ ...route(), route: { ...route().route, ...change } }).api.route(input)).rejects.toMatchObject({ status: 502 });
  });
  it("normalizes the explicit lookup and keeps source conflicts instead of silently selecting a winner", async () => {
    const body = { ...scope, query: { kind: "plate", value: "BA123AA", country: "SK", checkedForDate: "2026-10-15" }, cached: false, conflict: "EČV sa nezhoduje.", result: { id: asset.id, fetchedAt: scope.checkedAt, sources: [{ source: "skp", status: "unavailable", fetchedAt: scope.checkedAt, facts: {}, warnings: ["Nedostupné"], candidates: [] }] } };
    const { api, transport } = setup(body);
    expect((await api.lookup({ kind: "plate", value: " ba 123aa ", country: "SK" })).conflict).toBe(body.conflict);
    expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).value).toBe("BA123AA");
    await expect(setup({ ...body, query: { ...body.query, value: "BA456BB" } }).api.lookup({ kind: "plate", value: "BA123AA", country: "SK" })).rejects.toMatchObject({ status: 502 });
    await expect(setup({ ...body, result: { ...body.result, proof: "private" } }).api.lookup({ kind: "plate", value: "BA123AA", country: "SK" })).rejects.toMatchObject({ status: 502 });
  });
  it("does not send invalid or pre-cancelled requests", async () => {
    const { api, transport } = setup(fleet()); const abort = new AbortController(); abort.abort();
    await expect(api.fleet(filter, abort.signal)).rejects.toBeInstanceOf(ToolsApiError);
    await expect(api.route({ ...input, origin: { lat: Number.NaN, lng: 0 } })).rejects.toMatchObject({ status: 400 });
    await expect(api.lookup({ kind: "plate", value: "bad!", country: "SK" })).rejects.toMatchObject({ status: 400 });
    expect(transport).not.toHaveBeenCalled();
  });
  it("fences requests which resolve after the account closes", async () => {
    let active = true; const { api, transport } = setup(fleet(), () => active);
    transport.mockImplementation(async () => { active = false; return Response.json(fleet()); });
    await expect(api.fleet(filter)).rejects.toMatchObject({ status: 401 });
  });
  it("preserves bounded retry delay and never automatically repeats a provider operation", async () => {
    const { api, transport } = setup(null);
    transport.mockResolvedValue(Response.json({ ok: false, error: "Prebieha iné overenie." }, { status: 409, headers: { "Retry-After": "5" } }));
    await expect(api.lookup({ kind: "plate", value: "BA123AA", country: "SK" })).rejects.toMatchObject({ status: 409, retryAfterSeconds: 5 });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("gives lookup its real server budget and reports an uncertain timeout", async () => {
    vi.useFakeTimers(); const { api, transport } = setup(null);
    transport.mockImplementation((_url, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const pending = api.lookup({ kind: "plate", value: "BA123AA", country: "SK" });
    const assertion = expect(pending).rejects.toMatchObject({ status: 0, retryAfterSeconds: 5, message: expect.stringContaining("serveri") });
    await vi.advanceTimersByTimeAsync(12001); expect(transport.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(44000); await assertion; expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe("large fleet response contract", () => {
  const rows = (count: number) => Array.from({ length: count }, (_, index) => ({
    ...asset,
    id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
    label: `Auto ${String(index).padStart(4, "0")}`,
    licensePlate: `BA${String(index).padStart(4, "0")}AB`,
  }));

  it.each([298, 350, 1000])("accepts the complete sequence of pages for %i vehicles", async count => {
    const assets = rows(count);
    const ids: string[] = [];
    for (let offset = 0; offset < count; offset += 25) {
      const selection = { ...filter, offset };
      const page = assets.slice(offset, offset + 25);
      const body = { ...fleet(), selection, assets: page, total: count, nextOffset: offset + page.length < count ? offset + page.length : null };
      const result = await setup(body).api.fleet(selection);
      expect(result.total).toBe(count);
      expect(result.assets).toEqual(page);
      ids.push(...result.assets.map(row => row.id));
    }
    expect(ids).toEqual(assets.map(row => row.id));
    expect(new Set(ids).size).toBe(count);
  });

  it("accepts an exact vehicle search beyond the old boundary and the final empty page", async () => {
    const tail = { ...rows(350)[349], occupancy: "occupied", availabilityVerified: true, gps: { ...asset.gps, stale: true } };
    const search = { ...filter, q: tail.licensePlate };
    const found = await setup({ ...fleet(), selection: search, assets: [tail] }).api.fleet(search);
    expect(found.assets).toEqual([tail]);
    const selection = { ...filter, offset: 1000 };
    await expect(setup({ ...fleet(), selection, assets: [], total: 1000 }).api.fleet(selection)).resolves.toMatchObject({ total: 1000, assets: [], nextOffset: null });
  });

  it("still rejects a snapshot or requested offset beyond the complete-read limit", async () => {
    const { api, transport } = setup({ ...fleet(), assets: rows(25), total: 1001, nextOffset: 25 });
    await expect(api.fleet(filter)).rejects.toMatchObject({ status: 502 });
    transport.mockClear();
    await expect(api.fleet({ ...filter, offset: 1001 })).rejects.toMatchObject({ status: 400 });
    expect(transport).not.toHaveBeenCalled();
  });
});
