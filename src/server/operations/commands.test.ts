import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({ rpc: vi.fn().mockResolvedValue({ data: { operations: [], totalCount: 0 }, error: null }) }));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: () => mocks }));
vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: vi.fn() }));
import { operationsWorkspaceFor, parseOperationCommand } from './index';
const id = '11111111-1111-4111-8111-111111111111';
describe('web operation command boundary', () => {
 it('retains a stable command, target and expected revision', () => {
  expect(parseOperationCommand({ commandId: id, action: 'assign', expectedRevision: 5, payload: { assigneeId: id } }, id)).toEqual({ commandId: id, operationId: id, action: 'assign', expectedRevision: 5, payload: { assigneeId: id } });
 });
 it.each([{ action: 'elevate' }, { expectedRevision: -1 }, { commandId: 'unstable' }, { payload: [] }])('rejects malformed command %j', bad => {
  expect(() => parseOperationCommand({ commandId: id, action: 'create', expectedRevision: 0, payload: {}, ...bad })).toThrow();
 });
});

 describe('server operation search boundary', () => {
  it('sends a bounded global search to the authorized RPC', async () => {
    await operationsWorkspaceFor({ userId: id, organizationId: id }, { query: '  Bratislava  ', offset: '50' });
    expect(mocks.rpc).toHaveBeenCalledWith('motorist_operations_workspace', { p_user_id: id, p_organization_id: id, p_filters: { query: 'Bratislava', offset: 50, limit: 50 } });
  });
  it.each([{ query: 'x'.repeat(201) }, { query: {} }, { limit: 51 }, { offset: -1 }])('rejects invalid filter %j', async filters => {
    await expect(operationsWorkspaceFor({ userId: id, organizationId: id }, filters)).rejects.toMatchObject({ status: 400 });
  });
 });
