/** Customer data never belongs in a diagnostic. Masks phone-like numbers, e-mail
 * addresses, licence plates and VINs; record identifiers and dates stay, because
 * they help to find the screen and the moment without naming anybody.
 * Shared by the mobile app (before sending) and the server (before logging). */
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const DATE = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})?)?\b/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const VIN = /\b(?=[A-HJ-NPR-Z0-9]*\d)(?=[A-HJ-NPR-Z0-9]*[A-HJ-NPR-Z])[A-HJ-NPR-Z0-9]{17}\b/g;
const PLATE = /\b(?:[A-Z]{2}[\s-]?\d{3}[\s-]?[A-Z]{2}|\d[A-Z][A-Z0-9][\s-]?\d{4})\b/g;
const NUMBERISH = /\+?\(?\d[\d\s().\/-]{5,}\d\)?/g;

export function maskDiagnostic(value: string): string {
  const kept: string[] = [];
  const keep = (match: string) => "\u0000" + (kept.push(match) - 1) + "\u0000";
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(UUID, keep).replace(DATE, keep)
    .replace(EMAIL, "[e-mail]").replace(VIN, "[VIN]").replace(PLATE, "[EČV]")
    .replace(NUMBERISH, match => (match.match(/\d/g)?.length ?? 0) >= 7 ? "[číslo]" : match)
    .replace(/\u0000(\d+)\u0000/g, (_, index: string) => kept[Number(index)]);
}
