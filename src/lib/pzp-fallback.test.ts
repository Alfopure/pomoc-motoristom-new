import { describe, expect, it } from "vitest";
import { pzpFallbackMessage } from "./pzp-fallback";
import type { VehicleLookupResult } from "./vehicle-lookup";
const result = (status: string, facts = {}) =>
  ({
    query: { country: "SK" },
    sources: [{ source: "skp", status, facts }],
  }) as unknown as VehicleLookupResult;
describe("PZP fallback", () => {
  it.each([
    "challenge_required",
    "rate_limited",
    "unsupported",
    "not_found",
    "ambiguous",
    "unavailable",
  ])("offers a manual path for %s without declaring no insurance", (status) => {
    const message = pzpFallbackMessage(result(status));
    expect(message).toBeTruthy();
    expect(message).not.toContain("nepoistené");
  });
  it("supports total request failure and no source result", () =>
    expect(pzpFallbackMessage()).toContain("nepodarilo"));
  it("does not offer SKP for a Czech lookup", () =>
    expect(pzpFallbackMessage(null, "CZ")).toBeNull());
  it("a conflict invalidates otherwise found insurance facts", () => {
    const found = result("found", { insuranceStatus: { value: "Poistené" } });
    expect(pzpFallbackMessage(found)).toBeNull();
    expect(pzpFallbackMessage(found, "SK", true)).toContain("Identita");
  });
});
