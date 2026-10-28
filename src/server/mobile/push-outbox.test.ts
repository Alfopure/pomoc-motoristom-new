import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: vi.fn() }));
import { outboxOutcomes, type OutboxRow } from './push-outbox';
const row = (id: string): OutboxRow => ({ id, leaseId: 'l-' + id, memberId: 'm', profileId: null, type: 'work', event: 'work_assigned', title: 't', body: 'b', target: { kind: 'operation', id: 'o' } });
describe('work push outbox outcomes', () => {
  it('counts a row sent when any of its phones was reached', () => {
    expect(outboxOutcomes([row('a')], [{ rowId: 'a' }, { rowId: 'a' }], ['failed', 'sent'])).toEqual([{ id: 'a', lease_id: 'l-a', outcome: 'sent' }]);
  });
  it('drops a row without a wanting phone or whose phones were all removed', () => {
    expect(outboxOutcomes([row('a'), row('b')], [{ rowId: 'b' }], ['gone'])).toEqual([{ id: 'a', lease_id: 'l-a', outcome: 'no_device' }, { id: 'b', lease_id: 'l-b', outcome: 'no_device' }]);
  });
  it('retries a row only when every reachable attempt failed', () => {
    expect(outboxOutcomes([row('a')], [{ rowId: 'a' }, { rowId: 'a' }], ['failed', 'gone'])).toEqual([{ id: 'a', lease_id: 'l-a', outcome: 'failed' }]);
  });
});
