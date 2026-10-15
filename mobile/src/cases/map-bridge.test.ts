import { describe, expect, it } from "vitest";
import { MapBridge, allowsMapNavigation, mapOriginWhitelist, type MapSource } from "./map-bridge";
const source: MapSource = { uri: "https://test.dispecing.linkapomoci.sk/api/mobile/v1/maps/picker", headers: { Authorization: "Bearer PRIVATE" }, identity: {
  version: 1, nonce: "00000000-0000-4000-8000-000000000001", mode: "pick", target: "pickup", environment: "test", profileId: "profile", organizationId: "org", caseId: null } };
const selected = { label: "Bod", address: "Adresa", lat: 0, lng: 0, provider: "manual" as const };
const envelope = (type: string, fields = {}) => JSON.stringify({ ...source.identity, type, ...fields });
describe("native map bridge", () => {
  it("serializes a bounded tools preview only into a standalone view and clones it", () => {
    const viewSource = { ...source, identity: { ...source.identity, mode: "view" as const } };
    const preview = { points: [{ lat: 0, lng: 0, label: "Fleet" }], encodedPolyline: "????" };
    const view = new MapBridge(viewSource, { selection: null, address: "", preview }); preview.points[0].lat = 50;
    expect(view.receive(source.uri, envelope("ready", { mode: "view" }))?.seed).toContain('"lat":0');
    expect(() => new MapBridge(source, { selection: null, address: "", preview })).toThrow();
    expect(() => new MapBridge({ ...viewSource, identity: { ...viewSource.identity, caseId: "case" } }, { selection: null, address: "", preview })).toThrow();
  });
  it("sends local seed once only after scoped ready and never serializes request authorization", () => {
    const bridge = new MapBridge(source, { selection: selected, address: "Adresa" });
    expect(bridge.receive(source.uri, envelope("candidate", { selection: selected }))).toBeNull();
    const result = bridge.receive(source.uri, envelope("ready")); expect(result?.seed).toContain('"lat":0'); expect(result?.seed).not.toContain("PRIVATE");
    expect(bridge.receive(source.uri, envelope("ready"))).toBeNull(); expect(bridge.receive(source.uri, envelope("candidate", { selection: selected }))).toEqual({ selection: selected });
  });
  it("rejects different nonce/scope/target/case/version, navigation and extra keys", () => {
    for (const change of [{ nonce: "wrong" }, { organizationId: "other" }, { profileId: "other" }, { caseId: "other" }, { target: "destination" }, { environment: "production" }, { version: 2 }, { extra: true }]) {
      const bridge = new MapBridge(source, { selection: null, address: "" }); expect(bridge.receive(source.uri, envelope("ready", change))).toBeNull();
    }
    const bridge = new MapBridge(source, { selection: null, address: "" }); expect(bridge.receive("https://attacker.invalid", envelope("ready"))).toBeNull();
    expect(mapOriginWhitelist).toEqual(["*"]); for (const url of ["tel:123", "https://attacker.invalid", source.uri + "#redirect", "about:blank"]) expect(allowsMapNavigation(url, source.uri)).toBe(false);
  });
  it("closed or view frame cannot apply a candidate and seed is independent of caller mutation", () => {
    const seed = { ...selected }, bridge = new MapBridge(source, { selection: seed, address: "A" }); seed.lat = 40;
    expect(bridge.receive(source.uri, envelope("ready"))?.seed).toContain('"lat":0'); bridge.close(); expect(bridge.receive(source.uri, envelope("candidate", { selection: selected }))).toBeNull();
    const view = new MapBridge({ ...source, identity: { ...source.identity, mode: "view" } }, { selection: null, address: "" });
    view.receive(source.uri, envelope("ready", { mode: "view" })); expect(view.receive(source.uri, envelope("candidate", { mode: "view", selection: selected }))).toBeNull();
  });
  it.each([{ lat: null }, { lng: 181 }, { provider: "unknown" }, { address: "A\u0000B" }, { placeId: "\ud800" }, { token: "PRIVATE" }])("rejects malformed candidate %j", change => {
    const bridge = new MapBridge(source, { selection: null, address: "" }); bridge.receive(source.uri, envelope("ready"));
    expect(bridge.receive(source.uri, envelope("candidate", { selection: { ...selected, ...change } }))).toBeNull();
  });
});
