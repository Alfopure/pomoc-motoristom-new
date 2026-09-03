/**
 * E.164 normalisation for everything that crosses the Telnyx boundary.
 *
 * Telnyx stores the first Bratislava DID as `+4210232408700` (national trunk
 * zero kept after the country code) while the other numbers of the same block
 * come back as `+421232408718`. Both must resolve to the same canonical
 * `+421232408700` form before any lookup in `motorist_telephony_lines`, and
 * dispatcher input such as `0905 123 456`, `02/32 408 700` or `00420…` must
 * land in the same shape before it is dialled or stored.
 *
 * The function is deliberately conservative: anything that is not clearly a
 * phone number (letters, short extensions, SIP URIs, empty input) yields
 * `null` instead of a guess.
 */

export type NormalizeE164Options = {
  /** Country calling code assumed for national input (default 421 = Slovakia). */
  defaultCountryCode?: string;
};

/**
 * Country calling codes whose national numbering plan uses a leading `0` trunk
 * prefix that must never appear in the E.164 form. Telnyx occasionally keeps it
 * (see the module comment); callers' national input always carries it.
 */
const TRUNK_ZERO_COUNTRY_CODES = ["421", "420", "43", "49", "36", "48", "44", "33", "31", "32", "40", "385", "386", "380", "375", "370", "371"];

const E164_MIN_DIGITS = 8;
const E164_MAX_DIGITS = 15;

/** Characters that commonly decorate a written phone number and carry no information. */
const DECORATION_PATTERN = /[\s().\/-]/g;

function stripTrunkZero(international: string): string {
  const countryCode = TRUNK_ZERO_COUNTRY_CODES.find((code) => international.startsWith(code));
  if (!countryCode) return international;

  const national = international.slice(countryCode.length);
  if (!national.startsWith("0")) return international;

  // A lone trunk zero (e.g. "+4210 232 408 700") is dropped; "00" would be an
  // impossible national number, so refuse it rather than strip repeatedly.
  const stripped = national.slice(1);
  return stripped.startsWith("0") ? "" : `${countryCode}${stripped}`;
}

/**
 * Returns the canonical `+<country><national>` string, or `null` when the
 * input is not a phone number we are willing to dial or match.
 */
export function normalizeE164(value: unknown, options: NormalizeE164Options = {}): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;

  let input = String(value).trim();
  if (!input) return null;

  // Tolerate `tel:` and `sip:` style prefixes only for the plain `tel:` case;
  // SIP URIs address endpoints, not subscribers.
  if (/^tel:/i.test(input)) input = input.slice(4);
  if (/^sip:/i.test(input)) return null;

  // "(0)" is the conventional way of writing an optional trunk prefix in
  // international notation: "+421 (0) 905 123 456".
  input = input.replace(/\(0\)/g, "");
  input = input.replace(DECORATION_PATTERN, "");
  if (!input) return null;

  let hasPlus = false;
  if (input.startsWith("+")) {
    hasPlus = true;
    input = input.slice(1);
  }

  if (!/^\d+$/.test(input)) return null;

  const defaultCountryCode = (options.defaultCountryCode ?? "421").replace(/\D/g, "");
  let international: string;

  if (hasPlus) {
    international = input;
  } else if (input.startsWith("00")) {
    international = input.slice(2);
  } else if (input.startsWith("0")) {
    international = `${defaultCountryCode}${input.slice(1)}`;
  } else if (input.length === 9 && defaultCountryCode === "421") {
    // Slovak national significant number written without the trunk zero.
    international = `${defaultCountryCode}${input}`;
  } else if (input.length >= 11 && (input.startsWith(defaultCountryCode) || TRUNK_ZERO_COUNTRY_CODES.some((code) => input.startsWith(code)))) {
    // Digits-only international without prefix, e.g. "421905123456" from PBX feeds.
    international = input;
  } else {
    return null;
  }

  international = stripTrunkZero(international);
  if (!international || international.startsWith("0")) return null;
  if (international.length < E164_MIN_DIGITS || international.length > E164_MAX_DIGITS) return null;

  return `+${international}`;
}

/** True when both inputs normalise to the same E.164 number. */
export function sameE164(left: unknown, right: unknown, options?: NormalizeE164Options): boolean {
  const a = normalizeE164(left, options);
  const b = normalizeE164(right, options);
  return a !== null && b !== null && a === b;
}

/** Digits without the leading `+`, as some Telnyx list filters expect. */
export function e164Digits(value: unknown, options?: NormalizeE164Options): string | null {
  const normalized = normalizeE164(value, options);
  return normalized ? normalized.slice(1) : null;
}
