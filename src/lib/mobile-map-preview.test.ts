import { describe, expect, it } from "vitest";
import { parseMobileMapPreview } from "./mobile-map-preview";

const point = { lat: 0, lng: 0, label: "Posledná známa poloha" };
describe("mobile map preview boundary", () => {
  it("keeps zero coordinates and clones caller-owned markers", () => {
    const input = { points: [point], encodedPolyline: "????" };
    const preview = parseMobileMapPreview(input);
    expect(preview).toEqual(input);
    expect(preview.points[0]).not.toBe(point);
    expect(parseMobileMapPreview({ points: [point], encodedPolyline: "??" }).encodedPolyline).toBe("??");
    expect(parseMobileMapPreview({ points: [{ lat: 38.5, lng: -120.2, label: "Trasa" }], encodedPolyline: "_p~iF~ps|U_ulLnnqC_mqNvxq`@" }).points).toHaveLength(1);
  });
  it.each([
    {}, { points: [] }, { points: Array.from({ length: 101 }, () => point) },
    { points: [{ ...point, lat: 91 }] }, { points: [{ ...point, lng: Number.NaN }] },
    { points: [{ ...point, label: "A\u0000B" }] }, { points: [{ ...point, label: "\ud800" }] },
    { points: [{ ...point, label: " " }] }, { points: [{ ...point, authorization: "secret" }] },
    { points: [point], token: "secret" }, { points: [point], encodedPolyline: "" },
    { points: [point], encodedPolyline: "?" }, { points: [point], encodedPolyline: "_" },
    { points: [point], encodedPolyline: "<script>" }, { points: [point], encodedPolyline: "~".repeat(200001) },
    { points: [point], encodedPolyline: "~~~~~~????" },
  ])("rejects malformed or oversized map data %j", value => {
    expect(() => parseMobileMapPreview(value)).toThrow();
  });
});
