import { normalizeE164 } from "./normalize-e164";
import { cleanPhoneInput } from "./phone";

export function isAmbiguousBareInternational(value: string): boolean {
  const input = value.trim();
  const digits = input.replace(/[\s()./-]/g, "");
  return !input.startsWith("+") && !input.startsWith("00") && digits.length > 10;
}

/** Canonical storage format for numbers entered by a person. A directory may also contain PBX extensions. */
export function normalizeEditablePhone(value: unknown, options: { allowExtension?: boolean } = {}): string | null {
  if (typeof value !== "string") throw new Error("Invalid phone input");
  const input = value.trim();
  if (!input) return null;
  const digits = input.replace(/[\s()./-]/g, "");

  // Manual entry has only one implicit country: Slovakia. Long bare strings
  // can be a country code without its prefix, which is too ambiguous to save.
  if (isAmbiguousBareInternational(input)) {
    throw new Error("International phone input needs + or 00");
  }
  if (input.startsWith("0") && !input.startsWith("00") && digits.length !== 10) {
    throw new Error("Slovak national phone input needs ten digits");
  }

  if (options.allowExtension) {
    try {
      const parsed = cleanPhoneInput(input);
      if (parsed.kind === "extension" && !parsed.digits.startsWith("0")) return parsed.digits;
    } catch { /* The full number check below gives the final answer. */ }
  }

  const normalized = normalizeE164(input);
  if (!normalized) throw new Error("Invalid phone input");
  if (normalized.startsWith("+421") && normalized.length !== 13) {
    throw new Error("Slovak phone input needs nine significant digits");
  }
  return normalized;
}

export function previewEditablePhone(value: unknown, options: { allowExtension?: boolean } = {}): string | null {
  try { return normalizeEditablePhone(value, options); }
  catch { return null; }
}

/** Existing contacts and call history may predate canonical storage. Keep them callable. */
export function storedPhoneForDial(value: string): string {
  return normalizeE164(value) ?? value;
}
