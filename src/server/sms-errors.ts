export class SmsWorkflowError extends Error {
  constructor(message: string, readonly status = 500) { super(message); this.name = "SmsWorkflowError"; }
}

export function normalizeSmsRecipient(value: unknown, fieldName = "Telefónne číslo") {
  const input = String(value ?? "").trim();
  if (!input) throw new SmsWorkflowError(`${fieldName}: chýba telefónne číslo.`, 400);
  if (!/^\+?[\d ()/.-]{1,40}$/.test(input)) throw new SmsWorkflowError(`${fieldName}: telefónne číslo nie je platné.`, 400);
  const digits = input.replace(/\D/g, "");
  const international = digits.startsWith("00") ? digits.slice(2)
    : input.startsWith("+") || digits.startsWith("421") ? digits
      : digits.startsWith("0") ? `421${digits.slice(1)}` : "";
  if (!/^[1-9]\d{6,14}$/.test(international)) {
    throw new SmsWorkflowError(`${fieldName}: použite slovenské číslo alebo medzinárodný tvar s +/00.`, 400);
  }
  return `+${international}`;
}
