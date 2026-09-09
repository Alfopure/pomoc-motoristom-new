import { describe, expect, it } from "vitest";
import { buildApproximateLocationQuery, parseLocationCoordinates } from "./location-input";

describe("location form helpers", () => {
  it("accepts common coordinate formats and rejects invalid ranges", () => {
    expect(parseLocationCoordinates("48.1486, 17.1077")).toEqual({ lat: 48.1486, lng: 17.1077 });
    expect(parseLocationCoordinates("48.1486;17.1077")).toEqual({ lat: 48.1486, lng: 17.1077 });
    expect(parseLocationCoordinates("48.1486 17.1077")).toEqual({ lat: 48.1486, lng: 17.1077 });
    expect(parseLocationCoordinates("98.1, 17.1")).toBeNull();
    expect(parseLocationCoordinates("Bratislava")).toBeNull();
  });

  it("preserves domestic and foreign queries without appending a country", () => {
    expect(buildApproximateLocationQuery("R1 pri Nitre")).toBe("R1 pri Nitre");
    expect(buildApproximateLocationQuery("Bratislava, Slovensko")).toBe("Bratislava, Slovensko");
    expect(buildApproximateLocationQuery("  Wien, Österreich  ")).toBe("Wien, Österreich");
    expect(buildApproximateLocationQuery("Praha")).toBe("Praha");
    expect(buildApproximateLocationQuery("")).toBe("");
  });
});
