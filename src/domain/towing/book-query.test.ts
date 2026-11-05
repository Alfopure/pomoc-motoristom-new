import { describe, expect, it } from 'vitest';
import { towingBookDate, towingBookStage } from './book-query';
import type { TowingOrder } from './types';
const order = { workStatus: 'submitted', billingStatus: 'invoiced', paymentStatus: 'paid', fields: {}, createdAt: '2026-11-01T10:00:00Z' } as TowingOrder;
describe('book semantic stage', () => {
  it.each(['draft', 'assigned', 'in_progress', 'needs_changes', 'cancelled'] as const)('keeps physical %s visible despite paid billing', workStatus => {
    expect(towingBookStage({ ...order, workStatus })).toBe(({ draft: 'draft', assigned: 'active', in_progress: 'active', needs_changes: 'needs_changes', cancelled: 'cancelled' })[workStatus]);
  });
  it('requires closed billing and confirmed payment for paid; a partial receipt is separate', () => {
    expect(towingBookStage(order)).toBe('paid');
    expect(towingBookStage({ ...order, paymentStatus: 'partial' })).toBe('invoiced');
    expect(towingBookStage({ ...order, billingStatus: 'not_ready' })).toBe('review');
    expect(towingBookStage({ ...order, billingStatus: 'not_required' })).toBe('paid');
  });
  it('puts AWP record-only drafts in office review', () => {
    expect(towingBookStage({ ...order, workStatus: 'draft', fields: { ...order.fields, executionOrigin: 'awp_record_only' } })).toBe('review');
  });
});
describe('book date provenance', () => {
  it('ignores assignment timestamps as actual work, then falls back to plan and creation', () => {
    const fields = { ...order.fields, startedAt: '2026-11-02T10:00:00Z', startSource: 'assignment' as const, plannedAt: '2026-11-03T10:00:00Z' };
    expect(towingBookDate({ ...order, fields }, 'dispatch')).toEqual({ value: fields.plannedAt, source: 'planned' });
    expect(towingBookDate({ ...order, fields: { ...fields, plannedAt: '2026-02-30T10:00:00Z' } }, 'dispatch')).toEqual({ value: order.createdAt, source: 'created' });
    expect(towingBookDate({ ...order, fields: { ...fields, startSource: 'manual' } }, 'dispatch').source).toBe('actual');
    expect(towingBookDate({ ...order, fields }, 'created').value).toBe(order.createdAt);
  });
});
