/**
 * What the console shows under a typed phone number, before it is dialled.
 *
 * The console used to echo the input back more or less as it was written,
 * which is fine for a number that carries its own country and useless for one
 * that does not. National input has no country in it: "0776 123 456" is a
 * Czech mobile to the person typing it and `+421776123456` to everything
 * downstream, because `normalizeE164` fills in the Slovak code. The transfer
 * then goes through — to the wrong country, with nothing anywhere saying so.
 *
 * So the preview runs the same normalisation the server will run and shows its
 * result, and says plainly when the country code was filled in rather than
 * typed.
 */

import { formatPhoneNumberForDisplay } from "./phone";
import { normalizeE164 } from "./normalize-e164";

export type DialPreview =
  /** Nothing typed yet: no number, no complaint. */
  | { kind: "empty" }
  /** Not a number we are willing to dial. */
  | { kind: "invalid" }
  | { kind: "ready"; e164: string; text: string; countryAssumed: boolean };

/** True when the input states its own country, either as `+421` or as `00421`. */
function statesCountry(raw: string): boolean {
  return /^\s*(\+|00)/.test(raw);
}

export function dialPreview(raw: string): DialPreview {
  if (!raw.trim()) return { kind: "empty" };
  const e164 = normalizeE164(raw);
  if (!e164) return { kind: "invalid" };

  const countryAssumed = !statesCountry(raw);
  const shown = formatPhoneNumberForDisplay(e164);
  return {
    kind: "ready",
    e164,
    countryAssumed,
    text: countryAssumed
      ? `Vytočí sa ${shown} — predvoľba doplnená. Pre zahraničné číslo napíšte +420…`
      : `Vytočí sa ${shown}`,
  };
}
