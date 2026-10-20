/** Customer data never belongs in a diagnostic. Masks phone-like numbers, e-mail
 * addresses, licence plates and VINs; record identifiers, dates and code locations
 * (file:line:column, bytecode offsets) stay, because they help to find the screen,
 * the moment and the code without naming anybody.
 * Shared by the mobile app (before sending) and the server (before logging). */
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})?)?\b/g;
// "20. 10. 2026 14:30:05", "20.10.2026" – the app's own Slovak format.
const SK_DATE = /\b\d{1,2}\.\s?\d{1,2}\.\s?\d{4}(?:,?\s\d{1,2}:\d{2}(?::\d{2})?)?\b/g;
const LOCATION = /:\d+:\d+\b/g;
// Latin letters with Slovak and Czech diacritics, without regex Unicode classes (Hermes).
const EMAIL = /[A-Za-z0-9À-ɏ._%+-]+@[A-Za-z0-9À-ɏ-]+(?:\.[A-Za-z0-9À-ɏ-]+)*\.[A-Za-z]{2,}\b/g;
const VIN = /\b(?=[A-HJ-NPR-Z0-9]*\d)(?=[A-HJ-NPR-Z0-9]*[A-HJ-NPR-Z])[A-HJ-NPR-Z0-9]{17}\b/gi;
const PLATE = /\b(?:[A-Z]{2}[\s-]?\d{3}[\s-]?[A-Z]{2}|\d[A-Z][A-Z0-9][\s-]?\d{4})\b/gi;
const NUMBERISH = /\+?\(?\d[\d\s().\/-]{5,}\d/g;

export function maskDiagnostic(value: string): string {
  const kept: string[] = [];
  const keep = (match: string) => "\u0000" + (kept.push(match) - 1) + "\u0000";
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(UUID, keep).replace(ISO_DATE, keep).replace(SK_DATE, keep).replace(LOCATION, keep)
    .replace(EMAIL, "[e-mail]").replace(VIN, "[VIN]").replace(PLATE, "[EČV]")
    .replace(NUMBERISH, match => (match.match(/\d/g)?.length ?? 0) >= 7 ? "[číslo]" : match)
    .replace(/\u0000(\d+)\u0000/g, (_, index: string) => kept[Number(index)]);
}
