import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TowingMember, TowingWorkspace } from '@/domain/towing/types';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), select: vi.fn(), eq: vi.fn(), in: vi.fn() }));
vi.mock('./client', () => ({ towingAdmin: () => mocks }));
import { loadTowingWorkspace } from './service';

const actor: TowingMember = { id: 'member', userId: 'user', organizationId: 'organization', displayName: 'Fixture', roles: ['manager','driver'], capabilities: ['operate','price','drive'], active: true, version: 1 };
function workspace(view: 'office' | 'driver' = 'office'): TowingWorkspace {
  return { actor, view, orders: [{ id: 'order', number: 'Z-test', sourceCaseId: null, revision: 7, assignmentGeneration: 1, driverId: actor.id, workStatus: 'submitted', billingStatus: 'not_ready', paymentStatus: 'unpriced', fields: { serviceType: 'repair', subjectType: 'vehicle', subjectDescription: 'Fixture', pickup: 'Fixture' }, authorizedCollectionCents: null, receivedCents: 0, dueCents: null, reconciliationRequired: false, createdAt: '', updatedAt: '', attachments: [], taxDate: 'wrong-date' }], members: [], branches: [], fleet: [], cashAccounts: [], handovers: [], taxConfigured: true, taxRates: ['0'], taxDate: '2026-10-13' };
}
beforeEach(() => {
  mocks.rpc.mockResolvedValue({ data: workspace(), error: null });
  mocks.from.mockReturnValue(mocks); mocks.select.mockReturnValue(mocks); mocks.eq.mockReturnValue(mocks);
  mocks.in.mockResolvedValue({ data: [{ id: 'order', revision: 7, tax_date: '2026-09-30' }], error: null });
});
afterEach(() => vi.resetAllMocks());

describe('persisted office pricing date', () => {
  it('keeps the date belonging to the saved pricing, scoped to visible orders in the same organization', async () => {
    const data = await loadTowingWorkspace(actor, 'office');
    expect(data.orders[0].taxDate).toBe('2026-09-30');
    expect(data.taxDate).toBe('2026-10-13');
    expect(mocks.from).toHaveBeenCalledExactlyOnceWith('motorist_towing_orders');
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith('id,revision,tax_date');
    expect(mocks.eq).toHaveBeenCalledExactlyOnceWith('organization_id', actor.organizationId);
    expect(mocks.in).toHaveBeenCalledExactlyOnceWith('id', ['order']);
  });
  it.each([{ rows: [] }, { rows: [{ id: 'order', revision: 8, tax_date: '2026-10-01' }] }])('rejects missing or concurrently changed pricing instead of mixing snapshots', async ({ rows }) => {
    mocks.in.mockResolvedValue({ data: rows, error: null });
    await expect(loadTowingWorkspace(actor, 'office')).rejects.toMatchObject({ status: 409 });
  });
  it('preserves an explicitly unpriced date and fails when its read is unavailable', async () => {
    mocks.in.mockResolvedValueOnce({ data: [{ id: 'order', revision: 7, tax_date: null }], error: null });
    expect((await loadTowingWorkspace(actor, 'office')).orders[0].taxDate).toBeNull();
    mocks.in.mockResolvedValueOnce({ data: null, error: { code: 'XX000' } });
    await expect(loadTowingWorkspace(actor, 'office')).rejects.toMatchObject({ status: 503 });
  });
  it('does not issue an unbounded query for an empty workspace', async () => {
    mocks.rpc.mockResolvedValue({ data: { ...workspace(), orders: [] }, error: null });
    expect((await loadTowingWorkspace(actor, 'office')).orders).toEqual([]);
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('does not query or expose the date in the driver projection even for a dual-role actor', async () => {
    mocks.rpc.mockResolvedValue({ data: workspace('driver'), error: null });
    expect((await loadTowingWorkspace(actor, 'driver')).orders[0]).not.toHaveProperty('taxDate');
    expect(mocks.from).not.toHaveBeenCalled();
  });
});
