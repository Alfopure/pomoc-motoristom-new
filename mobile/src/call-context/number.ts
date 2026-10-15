import { cleanPhoneInput } from "../../../src/lib/telephony/phone";

/** Keep national prefixes; never turn an internal extension into a customer. */
export function customerCallNumber(direction: string, value: string | null): string | null {
  if (direction !== "inbound" && direction !== "outbound" || value === null) return null;
  try {
    const parsed = cleanPhoneInput(value);
    if (parsed.kind !== "phone") return null;
    const international = parsed.hasPlus ? parsed.digits : parsed.digits.startsWith("00") ? parsed.digits.slice(2) : null;
    if (international !== null) return /^[1-9]\d{6,14}$/.test(international) ? "+" + international : null;
    return /^\d{9,15}$/.test(parsed.digits) && /[1-9]/.test(parsed.digits) ? parsed.digits : null;
  } catch { return null; }
}
