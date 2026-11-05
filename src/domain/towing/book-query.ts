import type { TowingOrder } from './types';

export const TOWING_BOOK_SORTS = ['operational', 'date_asc', 'date_desc', 'amount_desc', 'driver_asc'] as const;
export const TOWING_BOOK_STAGES = ['draft', 'active', 'review', 'ready', 'invoiced', 'paid', 'cancelled', 'needs_changes'] as const;
export const TOWING_BOOK_DATE_BASES = ['created', 'dispatch'] as const;
export const TOWING_REQUESTER_TYPES = ['assistance', 'selfpayer', 'unknown'] as const;
export type TowingBookStage = typeof TOWING_BOOK_STAGES[number];

/** Financial states never hide unfinished physical work. Record-only drafts await office review. */
export function towingBookStage(order: Pick<TowingOrder, 'workStatus' | 'billingStatus' | 'paymentStatus' | 'fields'>): TowingBookStage {
  if (order.workStatus === 'cancelled' || order.workStatus === 'needs_changes') return order.workStatus;
  if (order.workStatus === 'draft') return order.fields.executionOrigin === 'awp_record_only' ? 'review' : 'draft';
  if (order.workStatus === 'assigned' || order.workStatus === 'in_progress') return 'active';
  if (['invoiced', 'not_required'].includes(order.billingStatus) && ['paid', 'overpaid'].includes(order.paymentStatus)) return 'paid';
  if (order.billingStatus === 'invoiced') return 'invoiced';
  if (order.billingStatus === 'ready' || order.billingStatus === 'not_required') return 'ready';
  return 'review';
}

function validTimestamp(value: string): boolean {
  const date = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!date || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day] = date.map(Number);
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** startedAt stamped by old assignment code is not evidence of actual work. */
export function towingBookDate(order: Pick<TowingOrder, 'fields' | 'createdAt'>, basis: 'created' | 'dispatch') {
  if (basis === 'dispatch') {
    if (order.fields.startSource !== 'assignment' && order.fields.startedAt && validTimestamp(order.fields.startedAt)) return { value: order.fields.startedAt, source: 'actual' as const };
    if (order.fields.plannedAt && validTimestamp(order.fields.plannedAt)) return { value: order.fields.plannedAt, source: 'planned' as const };
  }
  return { value: order.createdAt, source: 'created' as const };
}
