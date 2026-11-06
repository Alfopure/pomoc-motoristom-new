import type { TowingCashBreakdown, TowingCashCategories, TowingCashCategory } from './types';

export const CASH_CATEGORIES = ['regular', 'other', 'unclassified'] as const;
export const cashCategoryLabels: Record<TowingCashCategory, string> = {
  regular: 'Bežná hotovosť', other: 'Iná hotovosť (bez faktúry)', unclassified: 'Historicky nerozlíšená hotovosť',
};
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export function isCashCategory(value: unknown): value is TowingCashCategory { return CASH_CATEGORIES.includes(value as TowingCashCategory); }
export function isCashBreakdown(value: unknown): value is TowingCashBreakdown {
  return record(value) && Object.keys(value).length === 3 && CASH_CATEGORIES.every(key => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)
    && Number.isSafeInteger(CASH_CATEGORIES.reduce((sum, key) => sum + Number(value[key]), 0));
}
export function cashBreakdownTotal(value: TowingCashBreakdown): number { return CASH_CATEGORIES.reduce((sum, key) => sum + value[key], 0); }
export function isCashCategories(value: unknown): value is TowingCashCategories {
  return record(value) && Object.keys(value).length === 3 && CASH_CATEGORIES.every(key => {
    const entry = value[key]; return record(entry) && Number.isSafeInteger(entry.balanceCents) && Number.isSafeInteger(entry.reservedCents) && Number(entry.reservedCents) >= 0;
  });
}
/** A proposal can span categories; retain the exact recorded split until acceptance. */
export function allocateCash(amountCents: number, categories: TowingCashCategories, category?: TowingCashCategory): TowingCashBreakdown | null {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return null;
  const result: TowingCashBreakdown = { regular: 0, other: 0, unclassified: 0 };
  if (category) {
    if (amountCents > categories[category].balanceCents - categories[category].reservedCents) return null;
    result[category] = amountCents; return result;
  }
  let remaining = amountCents;
  for (const category of ['unclassified', 'regular', 'other'] as const) {
    const available = Math.max(0, categories[category].balanceCents - categories[category].reservedCents);
    result[category] = Math.min(remaining, available); remaining -= result[category];
  }
  return remaining ? null : result;
}
