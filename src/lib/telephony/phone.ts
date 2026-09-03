export type PhoneInputKind = "extension" | "phone";

export class TelephonyPhoneInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelephonyPhoneInputError";
  }
}

export function cleanPhoneInput(value: unknown, fieldName = "number") {
  const input = String(value ?? "").trim();

  if (!input) {
    throw new TelephonyPhoneInputError(`${fieldName} is required.`);
  }

  if (!/^\+?[\d ()/.-]{1,40}$/.test(input)) {
    throw new TelephonyPhoneInputError(`${fieldName} must be a valid phone number or PBX extension.`);
  }

  const digits = input.replace(/\D/g, "");

  if (digits.length < 2 || digits.length > 18) {
    throw new TelephonyPhoneInputError(`${fieldName} must contain 2 to 18 digits.`);
  }

  return {
    input,
    digits,
    hasPlus: input.startsWith("+"),
    kind: digits.length <= 8 && !input.startsWith("+") && !digits.startsWith("00") ? "extension" : "phone",
  } satisfies { input: string; digits: string; hasPlus: boolean; kind: PhoneInputKind };
}

export function isDialablePhoneInput(value: unknown) {
  try {
    cleanPhoneInput(value);
    return true;
  } catch (error) {
    if (error instanceof TelephonyPhoneInputError) return false;
    throw error;
  }
}

export function formatDialTarget(value: unknown, fieldName = "number") {
  const parsed = cleanPhoneInput(value, fieldName);

  if (parsed.kind === "extension") {
    return parsed.digits;
  }

  if (parsed.digits.startsWith("00")) {
    return parsed.digits;
  }

  if (parsed.digits.startsWith("421") && parsed.digits.length >= 12) {
    return `0${parsed.digits.slice(3)}`;
  }

  if (parsed.hasPlus) {
    return `00${parsed.digits}`;
  }

  return parsed.digits;
}

export function normalizeDialNumberForComparison(value: unknown) {
  const input = String(value ?? "").trim();
  const digits = input.replace(/\D/g, "");

  if (!digits) {
    return "";
  }

  if (digits.startsWith("00")) {
    return digits.slice(2);
  }

  if (digits.startsWith("0")) {
    return `421${digits.slice(1)}`;
  }

  return digits;
}

export function sameDialNumber(left: unknown, right: unknown) {
  const normalizedLeft = normalizeDialNumberForComparison(left);
  const normalizedRight = normalizeDialNumberForComparison(right);

  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

/**
 * Formats provider-facing phone identities for people. PBX feeds commonly
 * return international numbers with a `00` prefix; exposing that raw transport
 * form made an otherwise normal Slovak number look as if it had two extra
 * zeroes. Short PBX extensions intentionally stay untouched.
 */
export function formatPhoneNumberForDisplay(value: unknown) {
  const input = String(value ?? "").trim();
  if (!input) return "";

  const digits = input.replace(/\D/g, "");
  if (!digits || (digits.length <= 8 && !input.startsWith("+") && !digits.startsWith("00"))) {
    return input;
  }

  const international = digits.startsWith("00")
    ? digits.slice(2)
    : digits.startsWith("421") && digits.length >= 12
      ? digits
      : input.startsWith("+")
        ? digits
        : null;

  if (international?.startsWith("421") && international.length === 12) {
    return `+421 ${international.slice(3, 6)} ${international.slice(6, 9)} ${international.slice(9)}`;
  }

  if (international) {
    return `+${international}`;
  }

  if (digits.startsWith("0") && digits.length === 10) {
    return `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  }

  return input;
}
