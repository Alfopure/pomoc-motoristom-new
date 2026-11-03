import type { TowingLine, TowingPaymentStatus } from './types';
function decimal(value: string, scale: number): bigint {
  if (!new RegExp(`^\\d{1,9}(?:\\.\\d{1,${scale}})?$`).test(value)) throw new Error('Neplatná desatinná hodnota.');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * BigInt(10) ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0'));
}
function safe(value: bigint): number {
  if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Suma presahuje povolený limit.');
  return Number(value);
}
function halfUp(value: bigint, divisor: bigint): bigint { return (value + divisor / BigInt(2)) / divisor; }
export function calculateTowingLine(line: Pick<TowingLine, 'quantity' | 'unitPrice' | 'taxRate'>) {
  const quantity = decimal(line.quantity, 3);
  const price = decimal(line.unitPrice, 4);
  const rate = decimal(line.taxRate, 4);
  if (quantity <= BigInt(0) || rate > BigInt(1_000_000)) throw new Error('Neplatné množstvo alebo sadzba.');
  const net = halfUp(quantity * price, BigInt(100_000));
  const tax = halfUp(net * rate, BigInt(1_000_000));
  return { netCents: safe(net), taxCents: safe(tax), totalCents: safe(net + tax) };
}
export function calculateTowingTotal(lines: TowingLine[]): number {
  return safe(lines.reduce((sum, line) => sum + BigInt(calculateTowingLine(line).totalCents), BigInt(0)));
}
export function towingPaymentStatus(dueCents: number | null, receivedCents: number): TowingPaymentStatus {
  if (dueCents === null) return 'unpriced';
  if (receivedCents === dueCents) return 'paid';
  if (receivedCents > dueCents) return 'overpaid';
  return receivedCents === 0 ? 'unpaid' : 'partial';
}
export function parseEuroCents(value: string): number { return safe(decimal(value.replace(',', '.'), 2)); }
