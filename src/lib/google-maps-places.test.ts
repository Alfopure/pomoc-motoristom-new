import { afterEach, expect, it, vi } from "vitest";
import { createPlaceAutocompleteElement } from "./google-maps-places";

afterEach(() => vi.unstubAllGlobals());

it("keeps Slovak presentation without restricting countries in any shared search field", () => {
  const constructor = vi.fn();
  vi.stubGlobal("google", { maps: {
    UnitSystem: { METRIC: 0 },
    places: { PlaceAutocompleteElement: class {
      setAttribute = vi.fn();
      constructor(options: unknown) { constructor(options); }
    } },
  } });
  createPlaceAutocompleteElement("Hľadať miesto");
  expect(constructor.mock.calls[0][0]).toMatchObject({ requestedLanguage: "sk", requestedRegion: "sk" });
  expect(constructor.mock.calls[0][0].includedRegionCodes).toBeUndefined();
  expect(constructor.mock.calls[0][0].locationRestriction).toBeUndefined();
});
