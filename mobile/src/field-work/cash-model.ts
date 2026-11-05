/** Parse user-entered euros as integer cents without floating point rounding. */
export function cashAmountCents(value: string): number | null {
  const normalized = value.trim().replace(/\s/g, "");
  if (!/^\d{1,9}(?:[.,]\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.replace(",", ".").split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}
export function cashEuro(cents: number | null | undefined): string {
  return cents == null ? "Neurčené" : `${(cents / 100).toLocaleString("sk-SK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}
export function canProposeCash(amountCents: number | null, account: { balanceCents: number; reservedCents: number } | null): boolean {
  return account !== null && amountCents !== null && amountCents > 0 && amountCents <= account.balanceCents - account.reservedCents;
}
