import { describe, expect, it } from "vitest";
import { caseDraftInput, caseUpdateCommand } from "./draft-codecs";
import { placeSelection, compareRevisions, describeCurrentPlace, describeSelectedPlace } from "./location";
const point = { label: "Miesto", address: "Adresa", lat: 0, lng: 0, provider: "manual" };
describe("versioned location codecs", () => {
  it("accepts v2 explicit zero selection, rejects v1 shape extension and ambiguous manual field", () => {
    expect(caseDraftInput({ pickup: point }, 2)).toEqual({ pickup: point });
    expect(() => caseDraftInput({ pickup: point }, 1)).toThrow();
    expect(() => caseDraftInput({ pickup: point, manualPickupAddress: "Old" }, 2)).toThrow();
    expect(caseDraftInput({ pickup: null }, 2)).toEqual({ pickup: null });
  });
  it.each([{ lat: null }, { lng: Infinity }, { lat: 91 }, { address: "\ud800" }, { label: "A\nB" }, { provider: undefined }, { extra: true }])("rejects malformed nested point %j", change => {
    expect(() => placeSelection({ ...point, ...change })).toThrow();
  });
  it("leaves exact v1 pending UUID/revision/omitted locations unchanged", () => {
    const input = { mutationId: "00000000-0000-4000-8000-000000000001", expectedUpdatedAt: "2026-10-12T12:00:00.123456Z", note: "Exact" };
    expect(caseUpdateCommand(input, { updatedAt: input.expectedUpdatedAt, editable: {} as never }, 1)).toEqual(input);
  });
  it("compares microseconds without rewriting command revision", () => {
    expect(compareRevisions("2026-10-12T12:00:00.123456Z", "2026-10-12T12:00:00.123457Z")).toBeLessThan(0);
  });
});

describe("location conflict comparison", () => {
  it("shows the actual latest map point instead of treating absent editable selections as absent locations", () => {
    const latest = { editable: { manualPickupAddress: "Rovnaká adresa" }, pickupAddress: "Rovnaká adresa", map: {
      pickup: { address: "Rovnaká adresa", point: { lat: 48.2, lng: 17.2 }, source: "google_places" },
    } } as Parameters<typeof describeCurrentPlace>[0];
    expect(describeCurrentPlace(latest, "pickup")).toBe("Rovnaká adresa · 48.2, 17.2 · Google Maps");
    expect(describeSelectedPlace({ ...point, address: "Rovnaká adresa", lat: 0, lng: 0, provider: "manual" })).toBe("Rovnaká adresa · 0, 0 · Ručne zvolená poloha");
  });
  it("uses canonical manual address when a legacy detail has no map projection", () => {
    const latest = { editable: { manualDestinationAddress: "Aktuálna ručná adresa" }, destinationAddress: "Aktuálna ručná adresa" } as Parameters<typeof describeCurrentPlace>[0];
    expect(describeCurrentPlace(latest, "destination")).toBe("Aktuálna ručná adresa · Poloha nie je uvedená");
    expect(describeSelectedPlace(null)).toBe("Odstrániť uložené miesto");
  });
});
