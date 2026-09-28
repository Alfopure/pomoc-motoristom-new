import { normalizeE164 } from "@/lib/telephony/normalize-e164";
import { normalizeEditablePhone } from "@/lib/telephony/phone-entry";

export class SmsWorkflowError extends Error {
  constructor(message: string, readonly status = 500) { super(message); this.name = "SmsWorkflowError"; }
}

export function normalizeSmsRecipient(value: unknown, fieldName = "Telefónne číslo") {
  const input = String(value ?? "").trim();
  if (!input) throw new SmsWorkflowError(`${fieldName}: chýba telefónne číslo.`, 400);
  const normalized = normalizeE164(input);
  if (!normalized) throw new SmsWorkflowError(`${fieldName}: použite slovenské číslo alebo medzinárodný tvar s +/00.`, 400);
  return normalized;
}

/** A manual SMS number follows the same entry rules as cases and the directory. */
export function normalizeSmsEditableRecipient(value: unknown, fieldName = "Telefónne číslo") {
  try {
    const normalized = normalizeEditablePhone(value);
    if (normalized) return normalized;
  } catch { /* Show the same field-specific message for all invalid inputs. */ }
  throw new SmsWorkflowError(`${fieldName}: použite slovenské číslo alebo medzinárodný tvar s +/00.`, 400);
}
