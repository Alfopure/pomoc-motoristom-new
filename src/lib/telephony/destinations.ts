/**
 * Destination allowlist of the organisation (`motorist_telephony_settings.destination_allowlist`).
 *
 * It lives in `src/lib` rather than next to the call actions because both sides
 * need the same rule: the server refuses a disallowed destination before it
 * dials, and the routing settings screens (Phase 3) must reject an external ring
 * group member or a fallback number *before* the manager presses save. Pure, no
 * Node built-ins, so it is safe in the browser bundle.
 */

/** ISO country → dial prefix for the `destination_allowlist` setting. */
export const COUNTRY_DIAL_PREFIXES: Record<string, string> = {
  SK: "+421",
  CZ: "+420",
  AT: "+43",
  DE: "+49",
  HU: "+36",
  PL: "+48",
  UA: "+380",
  GB: "+44",
  IT: "+39",
  FR: "+33",
  ES: "+34",
  NL: "+31",
  BE: "+32",
  CH: "+41",
  SI: "+386",
  HR: "+385",
  RO: "+40",
  BG: "+359",
  RS: "+381",
  DK: "+45",
  SE: "+46",
  NO: "+47",
  FI: "+358",
  IE: "+353",
  PT: "+351",
  GR: "+30",
  LT: "+370",
  LV: "+371",
  EE: "+372",
  LU: "+352",
};

export function isDestinationAllowed(e164: string, allowlist: readonly string[] | null | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return false;
  return allowlist.some((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) return false;
    if (trimmed === "*") return true;
    if (trimmed.startsWith("+")) return e164.startsWith(trimmed);
    const prefix = COUNTRY_DIAL_PREFIXES[trimmed.toUpperCase()];
    return prefix ? e164.startsWith(prefix) : false;
  });
}
