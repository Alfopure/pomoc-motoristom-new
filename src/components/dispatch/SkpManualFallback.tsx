import { ExternalLink } from "lucide-react";
import type { VehicleLookupResult } from "@/lib/vehicle-lookup";

const SKP_LOOKUP_URL = "https://www.skp.sk/vyhladat-poistovatela-vozidla-a-overit-platnost-pzp/";

function skpFailureMessage(result: VehicleLookupResult): string | null {
  if (result.query.country !== "SK") return null;
  const skp = result.sources.find(source => source.source === "skp");
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

export function SkpManualFallback({ result, showEntryHint = false, identityConflict = false, className = "" }: { result: VehicleLookupResult; showEntryHint?: boolean; identityConflict?: boolean; className?: string }) {
  const message = skpFailureMessage(result);
  if (!message) return null;
  return <div data-testid="skp-manual-fallback" className={`rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950 ${className}`}>
    <p className="font-medium">{message}</p>
    <p className="mt-1">Výsledok neznamená, že vozidlo nie je poistené. Na SKP overte EČV alebo VIN a dátum.</p>
    {identityConflict && <p className="mt-1 font-medium">Najprv skontrolujte správne EČV a VIN v dokladoch.</p>}
    <a href={SKP_LOOKUP_URL} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 font-semibold underline underline-offset-2">Overiť PZP ručne na SKP<ExternalLink size={12} /></a>
    {showEntryHint && !identityConflict && <p className="mt-2">Po ručnom overení zapíšte poisťovňu do poľa „Poisťovňa PZP“ vo formulári.</p>}
  </div>;
}
