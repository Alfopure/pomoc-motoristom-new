import type { VehicleCountry, VehicleLookupResult } from "./vehicle-lookup";
export const SKP_MANUAL_URL =
  "https://www.skp.sk/vyhladat-poistovatela-vozidla-a-overit-platnost-pzp/";
/** A failed or ambiguous lookup never becomes an assertion of uninsured status. */
export function pzpFallbackMessage(
  result?: VehicleLookupResult | null,
  country: VehicleCountry = "SK",
  identityConflict = false,
): string | null {
  if ((result?.query.country ?? country) !== "SK") return null;
  if (identityConflict)
    return "Identita vozidla nesúhlasí. PZP tohto vozidla nie je potvrdené.";
  const skp = result?.sources.find((source) => source.source === "skp");
  if (skp?.status === "found" && skp.facts.insuranceStatus) return null;
  switch (skp?.status) {
    case "challenge_required":
      return "Pri tomto overení sa PZP nepodarilo automaticky overiť, pretože stránka SKP vyžadovala ochrannú kontrolu proti automatickým dopytom.";
    case "rate_limited":
      return "Pri tomto overení SKP obmedzilo počet automatických dopytov, preto sa PZP nepodarilo overiť.";
    case "unsupported":
      return "Pri tomto overení bolo automatické overovanie PZP cez SKP pozastavené.";
    case "not_found":
      return "Pri tomto overení SKP nevrátilo jednoznačný záznam o PZP.";
    case "ambiguous":
      return "Pri tomto overení SKP vrátilo nejednoznačný výsledok PZP.";
    default:
      return "Pri tomto overení sa PZP nepodarilo automaticky overiť cez SKP.";
  }
}
