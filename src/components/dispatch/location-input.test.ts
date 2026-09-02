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

  it("adds the Slovak search region only when it is missing", () => {
    expect(buildApproximateLocationQuery("R1 pri Nitre")).toBe("R1 pri Nitre, Slovensko");
    expect(buildApproximateLocationQuery("Bratislava, Slovensko")).toBe("Bratislava, Slovensko");
    expect(buildApproximateLocationQuery("")).toBe("");
  });
});
