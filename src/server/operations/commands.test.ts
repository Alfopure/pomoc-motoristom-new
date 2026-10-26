import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: vi.fn() }));
import { parseOperationCommand } from './index';
const id = '11111111-1111-4111-8111-111111111111';
describe('web operation command boundary', () => {
 it('retains a stable command, target and expected revision', () => {
  expect(parseOperationCommand({ commandId: id, action: 'assign', expectedRevision: 5, payload: { assigneeId: id } }, id)).toEqual({ commandId: id, operationId: id, action: 'assign', expectedRevision: 5, payload: { assigneeId: id } });
 });
 it.each([{ action: 'elevate' }, { expectedRevision: -1 }, { commandId: 'unstable' }, { payload: [] }])('rejects malformed command %j', bad => {
  expect(() => parseOperationCommand({ commandId: id, action: 'create', expectedRevision: 0, payload: {}, ...bad })).toThrow();
 });
});
