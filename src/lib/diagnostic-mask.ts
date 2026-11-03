/** Customer data never belongs in a diagnostic. Masks phone-like numbers, e-mail
 * addresses, licence plates and VINs; record identifiers, dates and code locations
 * (file:line:column, bytecode offsets) stay, because they help to find the screen,
 * the moment and the code without naming anybody.
 * Shared by the mobile app (before sending) and the server (before logging). */
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// Only plausible dates are kept, so "20.10. 0905 123 456" cannot hide a number behind a "year".
const ISO_DATE = /\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})?)?\b/g;
// "20. 10. 2026 14:30:05", "20.10.2026" – the app's own Slovak format.
const SK_DATE = /\b(?:0?[1-9]|[12]\d|3[01])\.\s?(?:0?[1-9]|1[0-2])\.\s?(?:19|20)\d{2}\b(?:,?\s\d{1,2}:\d{2}(?::\d{2})?)?/g;
const LOCATION = /:\d+:\d+\b/g;
// Latin letters with Slovak and Czech diacritics, without regex Unicode classes (Hermes);
// bounded parts keep long inputs fast.
const EMAIL = /[A-Za-z0-9À-ɏ._%+-]{1,64}@[A-Za-z0-9À-ɏ-]{1,63}(?:\.[A-Za-z0-9À-ɏ-]{1,63})*\.[A-Za-z]{2,24}(?![A-Za-z])/g;
const EMAIL_ENCODED = /[A-Za-z0-9._%+-]{1,64}%40[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}(?![A-Za-z])/g;
const VIN = /\b(?=[A-HJ-NPR-Z0-9]*\d)(?=[A-HJ-NPR-Z0-9]*[A-HJ-NPR-Z])[A-HJ-NPR-Z0-9]{17}\b/gi;
// Capital letters with or without separators; lower case only written together ("ba123ab"),
// so "po 500 ms" stays text.
const PLATE = /\b(?:[A-Z]{2}[\s-]?\d{3}[\s-]?[A-Z]{2}|\d[A-Z][A-Z0-9][\s-]?\d{4}|[a-z]{2}\d{3}[a-z]{2}|\d[a-z][a-z0-9]\d{4})\b/g;
const NUMBERISH = /\+?\(?\d[\d\s().\/–—-]{5,}\d/g;

export function maskDiagnostic(value: string): string {
  const kept: string[] = [];
  const keep = (match: string) => "\u0000" + (kept.push(match) - 1) + "\u0000";
  return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(UUID, keep).replace(ISO_DATE, keep).replace(SK_DATE, keep).replace(LOCATION, keep)
    .replace(EMAIL, "[e-mail]").replace(EMAIL_ENCODED, "[e-mail]").replace(VIN, "[VIN]").replace(PLATE, "[EČV]")
    .replace(NUMBERISH, match => (match.match(/\d/g)?.length ?? 0) >= 7 ? "[číslo]" : match)
    .replace(/\u0000(\d+)\u0000/g, (_, index: string) => kept[Number(index)]);
}
